/**
 * Pipeline de traitement des requêtes MCP.
 *
 * Ordre de traitement :
 * 1. Génération du Trace ID (fait en amont dans le transport)
 * 2. Authentification (qui êtes-vous ?)
 * 3. ACL (pouvez-vous faire ça ?)
 * 3b. Guardrails (l'appel est-il sûr ?)
 * 4. Rate Limit côté client (avant cache)
 * 5. Vérification du cache
 * 6. Rate Limit côté serveur (seulement si cache miss)
 * 7. Routeur → Backend
 * 8. Mise en cache
 * 9. Log + métriques
 *
 * Traitement spécifique par méthode MCP :
 * - tools/call  → auth + ACL + rate limit + cache + transmission
 * - tools/list  → auth + filtrage ACL + agrégation multi-serveur
 * - autres      → auth + passthrough transparent
 */

import type { ConduitRouter, RoutedRequest } from '../router/router.js';
import type { ServerRegistry } from '../router/registry.js';
import type { CacheStore } from '../cache/cache-store.js';
import type { InflightTracker } from '../cache/inflight.js';
import type { ConduitLogger, RequestLogContext } from '../observability/logger.js';
import { sanitizeMetricLabel, type ConduitMetrics } from '../observability/metrics.js';
import type { ConduitGatewayConfig } from '../config/types.js';
import type { RequestContext, CoreResult } from '../proxy/transport.js';
import type { JsonRpcMessage } from '../proxy/json-rpc.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import { generateCacheKey, extractTenantId } from '../cache/cache-key.js';
import { decideCachePolicy } from '../cache/cache-policy.js';
import {
  buildJsonRpcResult,
  buildJsonRpcError,
  extractToolName,
  extractToolArgs,
  JSON_RPC_ERRORS,
} from '../proxy/json-rpc.js';
import type { CacheEntry, ToolMetadata } from '../cache/types.js';
import type { RedisCacheStore } from '../cache/redis-cache.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { PluginContext } from '../plugins/types.js';
import { withSpan } from '../observability/otel.js';
import { authenticate } from '../auth/authenticator.js';
import { evaluateAcl, filterToolsList } from '../auth/acl.js';
import { evaluateGuardrails } from '../guardrails/evaluator.js';
import { sendWebhook } from '../guardrails/webhook.js';
import { resolveConnectProfile } from '../connect/export.js';
import { extractProfileIdFromTarget } from '../connect/profile-target.js';
import {
  IdentityRuntime,
  UpstreamIdentityError,
} from '../identity/runtime.js';
import type { AuthenticatedPrincipal } from '../identity/types.js';
import { GovernanceRuntime, buildRequestFingerprint } from '../governance/runtime.js';
import type { GovernanceApprovalRequestSummary } from '../governance/types.js';

const GOVERNANCE_DENIED_CODE = -32010;
const APPROVAL_REQUIRED_CODE = -32011;
const GOVERNANCE_QUOTA_CODE = -32012;
const APPROVAL_HEADER = 'x-conduit-approval-id';
const PROFILE_PROTOCOL_VERSION = '2024-11-05';
const PROFILE_SERVER_VERSION = '1.1.0';

/**
 * BUG FIX: Cacheable tools previously lost backend JSON-RPC error codes.
 * The inflight deduplicate callback threw a generic Error, which the transport
 * caught and re-wrapped as -32603 "Internal error", discarding the original
 * error code (e.g. -32000) and making it impossible for the client to distinguish
 * infrastructure failures from application errors.
 *
 * This typed error is thrown inside the inflight callback and caught in
 * handleToolCall, which returns the original code/message without caching.
 */
class UpstreamRpcError extends Error {
  constructor(
    public readonly code: number,
    public readonly rpcMessage: string,
  ) {
    super(`Upstream RPC error ${code}: ${rpcMessage}`);
    this.name = 'UpstreamRpcError';
  }
}

export class RequestPipeline {
  private readonly router: ConduitRouter;
  private readonly registry: ServerRegistry;
  private readonly cacheStore: CacheStore;
  private readonly inflightTracker: InflightTracker;
  private readonly logger: ConduitLogger;
  private readonly metrics: ConduitMetrics;
  private readonly config: ConduitGatewayConfig;
  private readonly identityRuntime: IdentityRuntime;
  private readonly governanceRuntime: GovernanceRuntime;
  private readonly rateLimiter: RateLimiter | null;
  private l2Cache: RedisCacheStore | null = null;
  private l2TtlMultiplier = 3;
  private pluginRegistry: PluginRegistry | null = null;

  constructor(
    router: ConduitRouter,
    registry: ServerRegistry,
    cacheStore: CacheStore,
    inflightTracker: InflightTracker,
    logger: ConduitLogger,
    metrics: ConduitMetrics,
    config: ConduitGatewayConfig,
    identityRuntime: IdentityRuntime,
    governanceRuntime: GovernanceRuntime,
    rateLimiter?: RateLimiter,
  ) {
    this.router = router;
    this.registry = registry;
    this.cacheStore = cacheStore;
    this.inflightTracker = inflightTracker;
    this.logger = logger;
    this.metrics = metrics;
    this.config = config;
    this.identityRuntime = identityRuntime;
    this.governanceRuntime = governanceRuntime;
    this.rateLimiter = rateLimiter ?? null;
  }

  /**
   * Traite une requête JSON-RPC pour un serveur donné.
   * Orchestre le pipeline complet.
   */
  async handle(
    serverId: string,
    message: JsonRpcMessage,
    context: RequestContext,
  ): Promise<CoreResult> {
    return withSpan(
      'conduit.handle',
      { 'conduit.server_id': serverId, 'conduit.method': message.method ?? 'unknown' },
      () => this._handle(serverId, message, context),
    );
  }

  private async _handle(
    serverId: string,
    message: JsonRpcMessage,
    context: RequestContext,
  ): Promise<CoreResult> {
    const method = message.method;
    const startTime = Date.now();

    // =========================================================================
    // Hook: before:request
    // =========================================================================
    const pluginCtx = this.buildPluginContext(serverId, message, context, 'anonymous');
    const beforeReqResult = await this.runHook('before:request', pluginCtx);
    if (beforeReqResult) return beforeReqResult;

    // =========================================================================
    // Étape 1 — Authentification
    // =========================================================================
    let clientId = 'anonymous';
    let tenantId = 'default';
    let claims: Record<string, unknown> | undefined;

    if (this.config.auth) {
      const authResult = await authenticate(context.rawHeaders, this.config.auth);
      if (!authResult.authenticated) {
        const reason = authResult.error ?? 'Authentification échouée';
        this.metrics.authFailuresTotal.inc({ reason });
        return {
          body: buildJsonRpcError(
            message.id,
            -32000,
            `Authentication failed: ${reason}`,
          ),
        };
      }
      clientId = authResult.client_id;
      tenantId = authResult.tenant_id;
      claims = authResult.claims;
    }

    const principal: AuthenticatedPrincipal = {
      client_id: clientId,
      tenant_id: tenantId,
      ...(context.authHeader ? { auth_header: context.authHeader } : {}),
      ...(claims ? { claims } : {}),
    };

    // =========================================================================
    // Hook: after:auth
    // =========================================================================
    pluginCtx.clientId = clientId;
    const afterAuthResult = await this.runHook('after:auth', pluginCtx);
    if (afterAuthResult) return afterAuthResult;

    const logContext: RequestLogContext = {
      traceId: context.traceId,
      clientId,
      serverId,
      method: method ?? 'unknown',
      startTime,
    };

    try {
      // Routage selon la méthode MCP
      if (method === 'tools/call') {
        return await this.handleToolCall(message, context, serverId, logContext, clientId, tenantId, principal, pluginCtx);
      }

      if (method === 'tools/list') {
        return await this.handleToolsList(message, context, serverId, logContext, clientId, principal);
      }

      // Passthrough pour toutes les autres méthodes
      return await this.handlePassthrough(message, context, serverId, logContext, principal);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Erreur interne';

      this.logger.log(logContext, {
        status: 'error',
        responseSize: 0,
        errorCode: JSON_RPC_ERRORS.INTERNAL_ERROR,
        errorMessage: errorMsg,
      });

      throw error;
    }
  }

  /**
   * Gère un appel d'outil avec le pipeline complet.
   */
  private async handleToolCall(
    message: JsonRpcMessage,
    context: RequestContext,
    serverId: string,
    logContext: RequestLogContext,
    clientId: string,
    tenantId: string,
    principal: AuthenticatedPrincipal,
    pluginCtx: PluginContext,
  ): Promise<CoreResult> {
    const profileId = extractProfileIdFromTarget(serverId);
    const profileServerIds = profileId ? this.getProfileServerIdSet(profileId) : null;
    const toolName = extractToolName(message) ?? '';
    const toolArgs = extractToolArgs(message);
    const directClient = profileServerIds ? null : this.router.getClientForServer(serverId);
    const resolvedToolName = this.router.resolveToolName(toolName);
    const resolvedCall = directClient ? null : this.router.resolveToolCall(toolName);
    const actualServerId = directClient
      ? serverId
      : (resolvedCall?.serverId ?? serverId);
    const actualToolName = directClient
      ? (resolvedToolName?.serverId === serverId ? resolvedToolName.toolName : toolName)
      : (resolvedCall?.toolName ?? toolName);

    if (profileServerIds && !profileServerIds.has(actualServerId)) {
      return {
        body: buildJsonRpcError(
          message.id,
          JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          `Outil introuvable dans le profil "${profileId}" : ${toolName}`,
        ),
      };
    }
    const workspace = this.governanceRuntime.resolveWorkspace({
      client_id: clientId,
      tenant_id: tenantId,
    });
    const workspaceRoles = this.governanceRuntime.getRolesForClient(workspace.id, clientId);

    logContext.toolName = toolName;
    logContext.args = toolArgs;

    // =========================================================================
    // Étape 2 — ACL : vérifier si le client peut appeler cet outil
    // =========================================================================
    if (this.config.acl?.enabled) {
      const decision = evaluateAcl(
        clientId,
        actualServerId,
        actualToolName,
        this.config.acl.policies,
        this.config.acl.default_action,
      );

      if (!decision.allowed) {
        this.metrics.aclDenialsTotal.inc({
          client: sanitizeMetricLabel(clientId),
          server: sanitizeMetricLabel(actualServerId),
          tool: sanitizeMetricLabel(actualToolName),
        });
        this.logger.log(logContext, {
          status: 'error',
          responseSize: 0,
          errorCode: -32000,
          errorMessage: `Access denied: ${decision.reason}`,
        });
        return {
          body: buildJsonRpcError(
            message.id,
            -32000,
            `Access denied: client '${clientId}' is not allowed to call '${actualToolName}' on server '${actualServerId}'`,
          ),
        };
      }
    }

    // =========================================================================
    // Étape 2b — Gouvernance workspace/RBAC
    // =========================================================================
    if (this.governanceRuntime.isEnabled()) {
      const governanceDecision = this.governanceRuntime.evaluateToolPolicy({
        workspace,
        client_id: clientId,
        roles: workspaceRoles,
        server_id: actualServerId,
        tool_name: actualToolName,
      });

      if (governanceDecision.effect === 'deny') {
        this.governanceRuntime.audit({
          workspace_id: workspace.id,
          actor_client_id: clientId,
          action: 'tool_policy_denied',
          resource_type: 'tool_call',
          resource_id: `${actualServerId}:${actualToolName}`,
          outcome: 'denied',
          details: {
            policy_name: governanceDecision.policy_name,
            trace_id: context.traceId,
          },
        });
        this.logger.log(logContext, {
          status: 'error',
          responseSize: 0,
          errorCode: GOVERNANCE_DENIED_CODE,
          errorMessage: governanceDecision.reason,
        });
        return {
          body: buildJsonRpcError(
            message.id,
            GOVERNANCE_DENIED_CODE,
            governanceDecision.reason,
            {
              workspace_id: workspace.id,
              policy_name: governanceDecision.policy_name,
              roles: workspaceRoles,
            },
          ),
        };
      }

      if (governanceDecision.effect === 'require_approval') {
        const approvalResult = this.enforceApprovalRequirement(
          message.id,
          context,
          clientId,
          workspace.id,
          actualServerId,
          actualToolName,
          toolArgs,
          'governance',
          governanceDecision.policy_name || 'governance',
          governanceDecision.reason,
          logContext,
        );
        if (approvalResult) {
          return approvalResult;
        }
      }

      const workspaceQuota = await this.governanceRuntime.consumeWorkspaceQuota(workspace.id);
      if (!workspaceQuota.allowed) {
        this.governanceRuntime.audit({
          workspace_id: workspace.id,
          actor_client_id: clientId,
          action: 'workspace_quota_blocked',
          resource_type: 'workspace_quota',
          resource_id: workspace.id,
          outcome: 'denied',
          details: {
            blocked_by: workspaceQuota.blocked_by,
            trace_id: context.traceId,
          },
        });
        this.logger.log(logContext, {
          status: 'error',
          responseSize: 0,
          errorCode: GOVERNANCE_QUOTA_CODE,
          errorMessage: `Workspace quota exceeded: ${workspaceQuota.blocked_by ?? 'workspace'}`,
        });
        return {
          body: buildJsonRpcError(
            message.id,
            GOVERNANCE_QUOTA_CODE,
            `Workspace quota exceeded: ${workspaceQuota.blocked_by ?? 'workspace'}`,
            {
              workspace_id: workspace.id,
              retry_after: workspaceQuota.retry_after ?? 60,
            },
          ),
          retryAfter: workspaceQuota.retry_after ?? 60,
        };
      }
    }

    // =========================================================================
    // Étape 2c — Guardrails : inspecter l'appel d'outil
    // =========================================================================
    if (this.config.guardrails?.enabled) {
      const grDecision = evaluateGuardrails(
        { clientId, serverId: actualServerId, toolName: actualToolName, toolArgs },
        this.config.guardrails,
      );

      if (grDecision.action === 'block') {
        this.metrics.guardrailActionsTotal.inc({
          rule: sanitizeMetricLabel(grDecision.rule_name),
          action: 'block',
          tool: sanitizeMetricLabel(actualToolName),
        });
        this.logger.log(logContext, {
          status: 'error',
          responseSize: 0,
          errorCode: -32000,
          errorMessage: `Guardrail blocked: ${grDecision.reason}`,
          guardrailRule: grDecision.rule_name,
          guardrailAction: 'block',
        });
        if (grDecision.webhook) {
          sendWebhook(grDecision.webhook, {
            event: 'guardrail_block',
            rule_name: grDecision.rule_name,
            severity: grDecision.severity ?? 'medium',
            client_id: clientId,
            server_id: actualServerId,
            tool_name: actualToolName,
            tool_args: toolArgs,
            message: grDecision.reason,
            timestamp: new Date().toISOString(),
            trace_id: context.traceId,
          });
        }
        return {
          body: buildJsonRpcError(message.id, -32000, grDecision.reason),
        };
      }

      if (grDecision.action === 'require_approval') {
        this.metrics.guardrailActionsTotal.inc({
          rule: sanitizeMetricLabel(grDecision.rule_name),
          action: 'require_approval',
          tool: sanitizeMetricLabel(actualToolName),
        });
        const approvalResult = this.enforceApprovalRequirement(
          message.id,
          context,
          clientId,
          workspace.id,
          actualServerId,
          actualToolName,
          toolArgs,
          'guardrail',
          grDecision.rule_name || 'guardrail',
          grDecision.reason,
          logContext,
          true,
        );
        if (approvalResult) {
          return approvalResult;
        }
      }

      if (grDecision.action === 'alert') {
        this.metrics.guardrailActionsTotal.inc({
          rule: sanitizeMetricLabel(grDecision.rule_name),
          action: 'alert',
          tool: sanitizeMetricLabel(actualToolName),
        });
        if (grDecision.webhook) {
          sendWebhook(grDecision.webhook, {
            event: 'guardrail_alert',
            rule_name: grDecision.rule_name,
            severity: grDecision.severity ?? 'medium',
            client_id: clientId,
            server_id: actualServerId,
            tool_name: actualToolName,
            tool_args: toolArgs,
            message: grDecision.reason,
            timestamp: new Date().toISOString(),
            trace_id: context.traceId,
          });
        }
        // Alert : continue le pipeline sans bloquer
      }
    }

    // =========================================================================
    // Étape 3 — Rate Limit côté client (avant cache)
    // =========================================================================
    if (this.config.rate_limits?.enabled && this.rateLimiter) {
      const rlResult = await this.rateLimiter.consumeClientLimits(clientId);
      if (!rlResult.allowed) {
        const blockedBy = rlResult.blocked_by ?? 'client';
        const retryAfter = rlResult.retry_after ?? 60;
        this.metrics.rateLimitRejectionsTotal.inc({
          client: sanitizeMetricLabel(clientId),
          server: sanitizeMetricLabel(serverId),
          limit_type: blockedBy,
        });
        this.logger.log(logContext, {
          status: 'error',
          responseSize: 0,
          errorCode: -32000,
          errorMessage: `Rate limit exceeded: ${blockedBy}`,
        });
        return {
          body: buildJsonRpcError(
            message.id,
            -32000,
            `Rate limit exceeded: ${blockedBy}. Retry after ${retryAfter} seconds`,
          ),
          retryAfter,
        };
      }
    }

    // =========================================================================
    // Résolution du serveur cible via le routeur
    // =========================================================================
    let routed: RoutedRequest | null;

    if (directClient) {
      // Use resolveToolName (no extra selectReplica) just for namespace stripping
      if (resolvedToolName && resolvedToolName.serverId === serverId) {
        routed = { serverId: resolvedToolName.serverId, toolName: resolvedToolName.toolName, client: directClient };
      } else {
        routed = { serverId, toolName, client: directClient };
      }
    } else {
      routed = resolvedCall;
      if (!routed) {
        const errMsg = this.router.buildToolNotFoundError(message.id, toolName);
        this.logger.log(logContext, {
          status: 'error',
          responseSize: JSON.stringify(errMsg).length,
          errorCode: JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          errorMessage: `Outil introuvable : ${toolName}`,
        });
        return { body: errMsg };
      }
    }

    const client = routed.client;

    logContext.serverId = routed.serverId;

    // Récupération des annotations et décision de cache
    const annotations = this.registry.getAnnotations(actualServerId, actualToolName);
    const serverConfig = this.config.servers.find((s) => s.id === actualServerId);

    if (!serverConfig) {
      const errMsg = buildJsonRpcError(message.id, JSON_RPC_ERRORS.INTERNAL_ERROR, `Configuration manquante pour : ${actualServerId}`);
      this.logger.log(logContext, {
        status: 'error',
        responseSize: JSON.stringify(errMsg).length,
        errorCode: JSON_RPC_ERRORS.INTERNAL_ERROR,
      });
      return { body: errMsg };
    }

    const policy = decideCachePolicy(actualToolName, annotations, serverConfig.cache);

    // Invalidation préventive si l'outil est destructeur
    if (policy.isDestructive && policy.invalidates.length > 0) {
      for (const invalidatedTool of policy.invalidates) {
        const count = this.cacheStore.deleteByTool(invalidatedTool, actualServerId);
        if (count > 0) {
          console.log(`[Conduit] Invalidé ${count} entrée(s) pour "${invalidatedTool}" (déclenché par "${actualToolName}")`);
        }
        if (this.l2Cache) {
          try {
            const l2Count = await this.l2Cache.deleteByTool(invalidatedTool, actualServerId);
            if (l2Count > 0) {
              console.log(`[Conduit] Invalidé ${l2Count} entrée(s) L2 pour "${invalidatedTool}" (déclenché par "${actualToolName}")`);
            }
          } catch (error) {
            console.warn(
              `[Conduit] L2 invalidation failed for "${invalidatedTool}" on "${actualServerId}": ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }

    // Bypass si non-cacheable
    if (!policy.shouldCache || !this.config.cache.enabled) {
      this.cacheStore.recordSkip();
      this.metrics.requestsTotal.inc({
        server: sanitizeMetricLabel(actualServerId),
        method: 'tools/call',
        tool: sanitizeMetricLabel(actualToolName),
        status: 'success',
        cache_status: 'SKIP',
      });

      // Rate Limit côté serveur (cache bypass)
      if (this.config.rate_limits?.enabled && this.rateLimiter) {
        const rlResult = await this.rateLimiter.consumeServerLimits(clientId, actualServerId, actualToolName);
        if (!rlResult.allowed) {
          const blockedBy = rlResult.blocked_by ?? 'server';
          const retryAfter = rlResult.retry_after ?? 60;
          this.metrics.rateLimitRejectionsTotal.inc({
            client: sanitizeMetricLabel(clientId),
            server: sanitizeMetricLabel(actualServerId),
            limit_type: blockedBy,
          });
          return {
            body: buildJsonRpcError(
              message.id,
              -32000,
              `Rate limit exceeded: ${blockedBy}. Retry after ${retryAfter} seconds`,
            ),
            retryAfter,
          };
        }
      }

      const forwardedMessage = this.buildForwardMessage(message, actualToolName);
      let result: CoreResult;
      try {
        result = await this.forwardToUpstream(forwardedMessage, context, client, serverConfig, principal);
      } catch (error) {
        if (error instanceof UpstreamIdentityError) {
          this.logger.log(logContext, {
            status: 'error',
            responseSize: 0,
            errorCode: -32000,
            errorMessage: error.message,
          });
          return { body: buildJsonRpcError(message.id, -32000, error.message) };
        }
        throw error;
      }

      // Si la réponse est un flux SSE, bypass le logging normal et retourner directement
      if (result.isStream) {
        this.logger.log(logContext, { status: 'success', responseSize: 0, cacheStatus: 'BYPASS' });
        return { ...result, cacheStatus: 'BYPASS' };
      }

      const bodyStr = JSON.stringify(result.body);

      // Inspecter le body pour distinguer les erreurs des succès dans les logs
      const skipBody = result.body as { error?: { code?: number; message?: string } } | null;
      const skipHasError = !!(skipBody?.error);

      this.logger.log(logContext, {
        status: skipHasError ? 'error' : 'success',
        responseSize: bodyStr.length,
        cacheStatus: 'SKIP',
        ...(skipHasError ? {
          errorCode: skipBody!.error!.code ?? -32603,
          errorMessage: skipBody!.error!.message,
        } : {}),
      });

      return { ...result, cacheStatus: 'SKIP' };
    }

    // Extraction du tenant pour l'isolation multi-tenant.
    //
    // Audit Sprint 3 #4: when authentication is enabled, the authenticated
    // tenant_id is the source of truth. A custom tenant header (e.g.
    // "X-Tenant-Id") must NOT override it — otherwise any client can craft a
    // header naming another tenant and read that tenant's cache entries.
    // The header is only honored when no authentication context exists (i.e.
    // the gateway is in trust-the-caller mode), in which case it serves as
    // an additional partitioning hint.
    let resolvedTenantId: string | undefined;
    if (this.config.tenant_isolation.enabled) {
      const tenantHeader = this.config.tenant_isolation.header.toLowerCase();
      const tenantHeaderValue = context.rawHeaders[tenantHeader];

      const authIsActive = Boolean(this.config.auth) && this.config.auth?.method !== 'none';

      if (tenantHeader === 'authorization') {
        // When auth is enabled, trust the authenticated tenant_id instead of
        // deriving cache isolation from the raw bearer token.
        resolvedTenantId = authIsActive
          ? tenantId
          : (extractTenantId(context.authHeader) ?? tenantId);
      } else if (authIsActive) {
        // Authenticated principal wins; ignore caller-supplied header.
        resolvedTenantId = tenantId;
      } else {
        resolvedTenantId = tenantHeaderValue ?? tenantId;
      }
    }
    const groupId = context.groupHeader ?? undefined;

    // Génération de la clé de cache
    const cacheKey = generateCacheKey({
      serverId: actualServerId,
      toolName: actualToolName,
      args: toolArgs,
      ignoreArgs: policy.ignoreArgs,
      ...(resolvedTenantId !== undefined ? { tenantId: resolvedTenantId } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
    });

    // =========================================================================
    // Hook: before:cache
    // =========================================================================
    pluginCtx.toolName = actualToolName;
    const beforeCacheResult = await this.runHook('before:cache', pluginCtx);
    if (beforeCacheResult) return beforeCacheResult;

    // =========================================================================
    // Étape 4 — Vérification du cache (L1 → L2)
    // =========================================================================
    const cachedEntry = this.cacheStore.get(cacheKey);
    if (cachedEntry) {
      this.metrics.updateCacheEntries(this.cacheStore.size);
      const responseBody = buildJsonRpcResult(message.id, cachedEntry.result);
      const bodyStr = JSON.stringify(responseBody);

      this.logger.log(logContext, {
        status: 'cache_hit',
        responseSize: bodyStr.length,
        cacheStatus: 'HIT',
      });

      return { body: responseBody, cacheStatus: 'HIT' };
    }

    // L2 check (Redis) — seulement si L1 miss et L2 configuré
    if (this.l2Cache) {
      const l2Entry = await this.l2Cache.get(cacheKey);
      if (l2Entry) {
        // Promote L2 hit → L1
        this.cacheStore.set(cacheKey, l2Entry);
        this.metrics.updateCacheEntries(this.cacheStore.size);

        const responseBody = buildJsonRpcResult(message.id, l2Entry.result);
        const bodyStr = JSON.stringify(responseBody);

        this.logger.log(logContext, {
          status: 'cache_hit',
          responseSize: bodyStr.length,
          cacheStatus: 'HIT',
        });

        return { body: responseBody, cacheStatus: 'HIT' };
      }
    }

    // =========================================================================
    // Étape 5 — Rate Limit côté serveur (seulement sur cache miss)
    // =========================================================================
    if (this.config.rate_limits?.enabled && this.rateLimiter) {
      const rlResult = await this.rateLimiter.consumeServerLimits(clientId, actualServerId, actualToolName);
      if (!rlResult.allowed) {
        const blockedBy = rlResult.blocked_by ?? 'server';
        const retryAfter = rlResult.retry_after ?? 60;
        this.metrics.rateLimitRejectionsTotal.inc({
          client: sanitizeMetricLabel(clientId),
          server: sanitizeMetricLabel(actualServerId),
          limit_type: blockedBy,
        });
        this.logger.log(logContext, {
          status: 'error',
          responseSize: 0,
          errorCode: -32000,
          errorMessage: `Rate limit exceeded: ${blockedBy}`,
        });
        return {
          body: buildJsonRpcError(
            message.id,
            -32000,
            `Rate limit exceeded: ${blockedBy}. Retry after ${retryAfter} seconds`,
          ),
          retryAfter,
        };
      }
    }

    // =========================================================================
    // Étape 6 — Déduplication + appel backend
    // =========================================================================
    const forwardedMessage = this.buildForwardMessage(message, actualToolName);

    let toolResult: Record<string, unknown>;
    let wasCoalesced: boolean;

    try {
      const deduped = await this.inflightTracker.deduplicate(
        cacheKey,
        async () => {
          const upstream = await this.forwardToUpstream(forwardedMessage, context, client, serverConfig, principal);
          const body = upstream.body as { result?: Record<string, unknown>; error?: { code?: number; message?: string } };

          if (body?.error) {
            throw new UpstreamRpcError(
              body.error.code ?? JSON_RPC_ERRORS.INTERNAL_ERROR,
              body.error.message ?? 'Upstream error',
            );
          }

          return body?.result ?? {};
        },
      );
      toolResult = deduped.result;
      wasCoalesced = deduped.wasCoalesced;
    } catch (error) {
      if (error instanceof UpstreamIdentityError) {
        this.logger.log(logContext, {
          status: 'error',
          responseSize: 0,
          errorCode: -32000,
          errorMessage: error.message,
        });
        return {
          body: buildJsonRpcError(message.id, -32000, error.message),
        };
      }
      if (error instanceof UpstreamRpcError) {
        this.logger.log(logContext, {
          status: 'error',
          responseSize: 0,
          errorCode: error.code,
          errorMessage: error.rpcMessage,
        });
        return {
          body: buildJsonRpcError(message.id, error.code, error.rpcMessage),
        };
      }
      throw error;
    }

    if (wasCoalesced) {
      this.metrics.dedupCoalescedTotal.inc({
        server: sanitizeMetricLabel(actualServerId),
        tool: sanitizeMetricLabel(actualToolName),
      });
    }

    // =========================================================================
    // Hook: after:upstream
    // =========================================================================
    const afterUpstreamResult = await this.runHook('after:upstream', pluginCtx);
    if (afterUpstreamResult) return afterUpstreamResult;

    // =========================================================================
    // Étape 7 — Mise en cache
    // =========================================================================
    // MCP tool failures surface as a successful JSON-RPC response with
    // `isError: true` in the result body (spec: structured tool errors). These
    // are transient by nature (invalid input, rate-limited upstream, partial
    // outage) and must NOT be cached: a single failure for one client would
    // poison every subsequent caller for the TTL of the policy. Treat them
    // exactly like a SKIP path while still surfacing the body to the caller.
    const isToolError = (toolResult as { isError?: unknown } | null)?.isError === true;
    if (isToolError) {
      this.cacheStore.recordSkip();
      this.metrics.requestsTotal.inc({
        server: sanitizeMetricLabel(actualServerId),
        method: 'tools/call',
        tool: sanitizeMetricLabel(actualToolName),
        status: 'success',
        cache_status: 'SKIP_ERROR',
      });
      const errorBody = buildJsonRpcResult(message.id, toolResult);
      const errorBodyStr = JSON.stringify(errorBody);
      this.logger.log(logContext, {
        status: 'error',
        responseSize: errorBodyStr.length,
        cacheStatus: 'SKIP_ERROR',
        errorCode: -32000,
        errorMessage: 'tool returned isError=true',
      });
      return { body: errorBody, cacheStatus: 'SKIP_ERROR' };
    }

    const entry: CacheEntry = {
      result: toolResult,
      createdAt: Date.now(),
      ttl: policy.ttl ?? serverConfig.cache.default_ttl,
      toolName: actualToolName,
      serverId: actualServerId,
    };
    this.cacheStore.set(cacheKey, entry);
    this.metrics.updateCacheEntries(this.cacheStore.size);

    // Write-through L2 (fire-and-forget)
    if (this.l2Cache) {
      const l2Ttl = entry.ttl * this.l2TtlMultiplier;
      this.l2Cache.set(cacheKey, entry, l2Ttl);
    }

    const responseBody = buildJsonRpcResult(message.id, toolResult);
    const bodyStr = JSON.stringify(responseBody);

    this.logger.log(logContext, {
      status: 'success',
      responseSize: bodyStr.length,
      cacheStatus: 'MISS',
    });

    // =========================================================================
    // Hook: before:response
    // =========================================================================
    const beforeRespResult = await this.runHook('before:response', pluginCtx);
    if (beforeRespResult) return beforeRespResult;

    return { body: responseBody, cacheStatus: 'MISS' };
  }

  /**
   * Gère tools/list avec filtrage ACL.
   */
  private async handleToolsList(
    message: JsonRpcMessage,
    context: RequestContext,
    serverId: string,
    logContext: RequestLogContext,
    clientId: string,
    principal: AuthenticatedPrincipal,
  ): Promise<CoreResult> {
    const profileId = extractProfileIdFromTarget(serverId);
    const profileServerIds = profileId ? this.getProfileServerIdSet(profileId) : null;
    const client = this.router.getClientForServer(serverId);
    if (client && !profileServerIds) {
      const serverConfig = this.config.servers.find((server) => server.id === serverId);
      if (!serverConfig) {
        return {
          body: buildJsonRpcError(message.id, JSON_RPC_ERRORS.INTERNAL_ERROR, `Configuration manquante pour : ${serverId}`),
        };
      }

      let result: CoreResult;
      try {
        result = await this.passthroughToServer(message, context, client, serverConfig, principal);
      } catch (error) {
        if (error instanceof UpstreamIdentityError) {
          return {
            body: buildJsonRpcError(message.id, -32000, error.message),
          };
        }
        throw error;
      }

      // Mise à jour des annotations depuis la réponse
      if (result.body && typeof result.body === 'object') {
        const body = result.body as { result?: { tools?: ToolMetadata[] } };
        const tools = body.result?.tools;
        if (Array.isArray(tools)) {
          this.registry.updateAnnotations(serverId, tools);
        }
      }

      // Filtrage ACL + gouvernance des outils
      let filteredBody = result.body;
      if (result.body && typeof result.body === 'object') {
        const body = result.body as { result?: { tools?: ToolMetadata[] } };
        const tools = body.result?.tools;
        if (Array.isArray(tools)) {
          let allowed = tools;
          if (this.config.acl?.enabled) {
            allowed = filterToolsList(
              clientId,
              serverId,
              allowed,
              this.config.acl.policies,
              this.config.acl.default_action,
            );
          }
          if (this.governanceRuntime.isEnabled()) {
            const workspace = this.governanceRuntime.resolveWorkspace({
              client_id: clientId,
              tenant_id: principal.tenant_id,
            });
            const roles = this.governanceRuntime.getRolesForClient(workspace.id, clientId);
            allowed = allowed.filter((tool) => this.governanceRuntime.canViewTool({
              workspace,
              client_id: clientId,
              roles,
              server_id: serverId,
              tool_name: tool.name,
            }));
          }
          filteredBody = {
            ...(result.body as object),
            result: { ...body.result, tools: allowed },
          };
        }
      }

      const bodyStr = JSON.stringify(filteredBody);
      this.logger.log(logContext, {
        status: 'success',
        responseSize: bodyStr.length,
        cacheStatus: 'BYPASS',
      });

      return { body: filteredBody, cacheStatus: 'BYPASS' };
    }

    // Multi-serveur : agrégation avec filtrage ACL + gouvernance
    let tools: ToolMetadata[];
    const aggregatedTools = this.router.getAggregatedToolsWithServerIds()
      .filter(({ serverId: sid }) => !profileServerIds || profileServerIds.has(sid));
    tools = aggregatedTools
      .filter(({ serverId: sid, toolName }) => {
        if (this.config.acl?.enabled) {
          const decision = evaluateAcl(
            clientId,
            sid,
            toolName,
            this.config.acl.policies,
            this.config.acl.default_action,
          );
          if (!decision.allowed) {
            return false;
          }
        }

        if (this.governanceRuntime.isEnabled()) {
          const workspace = this.governanceRuntime.resolveWorkspace({
            client_id: clientId,
            tenant_id: principal.tenant_id,
          });
          const roles = this.governanceRuntime.getRolesForClient(workspace.id, clientId);
          return this.governanceRuntime.canViewTool({
            workspace,
            client_id: clientId,
            roles,
            server_id: sid,
            tool_name: toolName,
          });
        }

        return true;
      })
      .map(({ namespacedName, toolDef }) => ({ ...toolDef, name: namespacedName }));

    const aggregatedBody = buildJsonRpcResult(message.id, { tools });
    const bodyStr = JSON.stringify(aggregatedBody);

    this.logger.log(logContext, {
      status: 'success',
      responseSize: bodyStr.length,
      cacheStatus: 'BYPASS',
    });

    return { body: aggregatedBody, cacheStatus: 'BYPASS' };
  }

  private enforceApprovalRequirement(
    messageId: JsonRpcMessage['id'],
    context: RequestContext,
    clientId: string,
    workspaceId: string,
    serverId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    source: 'guardrail' | 'governance',
    ruleName: string,
    reason: string,
    logContext: RequestLogContext,
    markGuardrail = false,
  ): CoreResult | null {
    const providedApprovalId = context.rawHeaders[APPROVAL_HEADER];
    if (providedApprovalId) {
      const approved = this.governanceRuntime.verifyApprovalGrant(
        providedApprovalId,
        workspaceId,
        clientId,
        serverId,
        toolName,
        toolArgs,
      );
      if (approved) {
        return null;
      }

      this.logger.log(logContext, {
        status: 'error',
        responseSize: 0,
        errorCode: APPROVAL_REQUIRED_CODE,
        errorMessage: 'Approval token is invalid, expired, or does not match this request',
        ...(markGuardrail ? { guardrailRule: ruleName, guardrailAction: 'require_approval' } : {}),
      });
      return {
        body: buildJsonRpcError(
          messageId,
          APPROVAL_REQUIRED_CODE,
          'Approval token is invalid, expired, or does not match this request',
          {
            workspace_id: workspaceId,
            approval_header: 'X-Conduit-Approval-Id',
          },
        ),
      };
    }

    const approval = this.governanceRuntime.createApprovalRequest({
      source,
      workspace_id: workspaceId,
      requester_client_id: clientId,
      server_id: serverId,
      tool_name: toolName,
      rule_name: ruleName,
      reason,
      trace_id: context.traceId,
      request_fingerprint: buildRequestFingerprint(serverId, toolName, toolArgs),
      tool_args: toolArgs,
    });

    this.logger.log(logContext, {
      status: 'error',
      responseSize: 0,
      errorCode: APPROVAL_REQUIRED_CODE,
      errorMessage: reason,
      ...(markGuardrail ? { guardrailRule: ruleName, guardrailAction: 'require_approval' } : {}),
    });

    return {
      body: buildJsonRpcError(
        messageId,
        APPROVAL_REQUIRED_CODE,
        reason,
        this.buildApprovalErrorData(approval),
      ),
    };
  }

  private buildApprovalErrorData(approval: GovernanceApprovalRequestSummary): Record<string, unknown> {
    return {
      approval_request_id: approval.id,
      status: approval.status,
      workspace_id: approval.workspace_id,
      approval_header: 'X-Conduit-Approval-Id',
      expires_at: approval.expires_at,
    };
  }

  /**
   * Passthrough transparent vers un serveur spécifique.
   */
  private async handlePassthrough(
    message: JsonRpcMessage,
    context: RequestContext,
    serverId: string,
    logContext: RequestLogContext,
    principal: AuthenticatedPrincipal,
  ): Promise<CoreResult> {
    const profileId = extractProfileIdFromTarget(serverId);
    if (profileId) {
      return this.handleProfilePassthrough(message, profileId, logContext);
    }

    const client = this.router.getClientForServer(serverId);
    if (!client) {
      const err = this.router.buildServerUnavailableError(message.id, serverId);
      this.logger.log(logContext, {
        status: 'error',
        responseSize: JSON.stringify(err).length,
        errorCode: JSON_RPC_ERRORS.INTERNAL_ERROR,
      });
      return { body: err };
    }

    const serverConfig = this.config.servers.find((server) => server.id === serverId);
    if (!serverConfig) {
      const err = buildJsonRpcError(message.id, JSON_RPC_ERRORS.INTERNAL_ERROR, `Configuration manquante pour : ${serverId}`);
      this.logger.log(logContext, {
        status: 'error',
        responseSize: JSON.stringify(err).length,
        errorCode: JSON_RPC_ERRORS.INTERNAL_ERROR,
      });
      return { body: err };
    }

    let result: CoreResult;
    try {
      result = await this.passthroughToServer(message, context, client, serverConfig, principal);
    } catch (error) {
      if (error instanceof UpstreamIdentityError) {
        this.logger.log(logContext, {
          status: 'error',
          responseSize: 0,
          errorCode: -32000,
          errorMessage: error.message,
        });
        return { body: buildJsonRpcError(message.id, -32000, error.message) };
      }
      throw error;
    }
    const bodyStr = result.body ? JSON.stringify(result.body) : '';

    this.logger.log(logContext, {
      status: 'success',
      responseSize: bodyStr.length,
      cacheStatus: 'BYPASS',
    });

    return { ...result, cacheStatus: 'BYPASS' };
  }

  private handleProfilePassthrough(
    message: JsonRpcMessage,
    profileId: string,
    logContext: RequestLogContext,
  ): CoreResult {
    if (message.method === 'initialize') {
      const profile = resolveConnectProfile(this.config, profileId);
      const body = buildJsonRpcResult(message.id, {
        protocolVersion: PROFILE_PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: `conduit-profile-${profile.id}`,
          title: `Conduit ${profile.label}`,
          version: PROFILE_SERVER_VERSION,
        },
      });

      this.logger.log(logContext, {
        status: 'success',
        responseSize: JSON.stringify(body).length,
        cacheStatus: 'BYPASS',
      });

      return {
        body,
        cacheStatus: 'BYPASS',
        upstreamSessionId: `conduit-profile-${profile.id}`,
      };
    }

    if (message.method === 'notifications/initialized') {
      const body = buildJsonRpcResult(message.id, { acknowledged: true });
      this.logger.log(logContext, {
        status: 'success',
        responseSize: JSON.stringify(body).length,
        cacheStatus: 'BYPASS',
      });
      return { body, cacheStatus: 'BYPASS' };
    }

    const err = buildJsonRpcError(
      message.id,
      JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `La méthode ${message.method ?? 'unknown'} n'est pas prise en charge sur /mcp/profile/${profileId}`,
    );

    this.logger.log(logContext, {
      status: 'error',
      responseSize: JSON.stringify(err).length,
      errorCode: JSON_RPC_ERRORS.METHOD_NOT_FOUND,
    });

    return { body: err };
  }

  /**
   * Transmet une requête vers un serveur en amont (sans logique de cache).
   */
  private async passthroughToServer(
    message: JsonRpcMessage,
    context: RequestContext,
    client: import('../proxy/mcp-client-interface.js').IMcpClient,
    serverConfig: import('../config/types.js').ServerConfig,
    principal: AuthenticatedPrincipal,
  ): Promise<CoreResult> {
    const extraHeaders = this.buildExtraHeaders(context, serverConfig, principal);
    const response = await client.forward({
      body: message,
      extraHeaders,
      ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    });

    const upstreamSessionId = response.headers['mcp-session-id'];

    if (response.isStream) {
      const result: CoreResult = { body: null, isStream: true };
      if (upstreamSessionId !== undefined) result.upstreamSessionId = upstreamSessionId;
      if (response.rawResponse !== undefined) result.rawResponse = response.rawResponse;
      return result;
    }

    const result: CoreResult = { body: response.body };
    if (upstreamSessionId !== undefined) result.upstreamSessionId = upstreamSessionId;
    return result;
  }

  /**
   * Transmet une requête en amont et retourne le résultat brut.
   */
  private async forwardToUpstream(
    message: JsonRpcMessage,
    context: RequestContext,
    client: import('../proxy/mcp-client-interface.js').IMcpClient,
    serverConfig: import('../config/types.js').ServerConfig,
    principal: AuthenticatedPrincipal,
  ): Promise<CoreResult> {
    try {
      return await this.passthroughToServer(message, context, client, serverConfig, principal);
    } catch (error) {
      this.metrics.errorsTotal.inc({
        server: sanitizeMetricLabel(serverConfig.id),
        type: 'upstream_error',
      });
      throw error;
    }
  }

  /**
   * Construit un message de transmission en remplaçant le nom de l'outil si nécessaire.
   */
  private buildForwardMessage(
    message: JsonRpcMessage,
    actualToolName: string,
  ): JsonRpcMessage {
    if (!message.params) return message;

    const currentName = message.params['name'];
    if (currentName === actualToolName) return message;

    return {
      ...message,
      params: {
        ...message.params,
        name: actualToolName,
      },
    };
  }

  /**
   * Construit les en-têtes supplémentaires à propager en amont.
   */
  private buildExtraHeaders(
    context: RequestContext,
    serverConfig: import('../config/types.js').ServerConfig,
    principal: AuthenticatedPrincipal,
  ): Record<string, string> {
    const extra: Record<string, string> = {
      'X-Conduit-Trace-Id': context.traceId,
    };

    if (context.groupHeader) {
      extra['X-Conduit-Group'] = context.groupHeader;
    }

    try {
      const resolved = this.identityRuntime.resolveUpstreamHeaders(serverConfig, principal);
      Object.assign(extra, resolved.headers);
    } catch (error) {
      if (error instanceof UpstreamIdentityError) {
        throw error;
      }
      throw new UpstreamIdentityError(String(error instanceof Error ? error.message : error));
    }

    // Default: do NOT forward the client's Authorization header upstream.
    // The bearer presented to Conduit (admin key, gateway JWT, API key) is a
    // gateway-scoped credential — leaking it to a third-party MCP server is
    // a credential exfiltration risk. Operators who genuinely want pass-through
    // must opt in per server via `forward_authorization: true`.
    if (
      context.authHeader &&
      !serverConfig.upstream_auth &&
      serverConfig.forward_authorization === true &&
      extra['Authorization'] === undefined
    ) {
      extra['Authorization'] = context.authHeader;
    }

    return extra;
  }

  /** Configure le registre de plugins (appelé depuis gateway.initialize). */
  setPluginRegistry(registry: PluginRegistry): void {
    this.pluginRegistry = registry;
  }

  /** Configure le cache L2 Redis (appelé depuis gateway.initialize). */
  setL2Cache(l2: RedisCacheStore, ttlMultiplier: number): void {
    this.l2Cache = l2;
    this.l2TtlMultiplier = ttlMultiplier;
  }

  /**
   * Construit un PluginContext pour les hooks.
   */
  private buildPluginContext(
    serverId: string,
    message: JsonRpcMessage,
    context: RequestContext,
    clientId: string,
    toolName?: string,
  ): PluginContext {
    const ctx: PluginContext = {
      serverId,
      method: message.method ?? '',
      clientId,
      traceId: context.traceId,
      message,
      extraHeaders: {},
      metadata: {},
    };
    if (toolName !== undefined) ctx.toolName = toolName;
    return ctx;
  }

  /**
   * Exécute un hook si le registre de plugins est configuré.
   * Retourne le CoreResult de court-circuit si un plugin l'exige, sinon undefined.
   */
  private async runHook(
    name: import('../plugins/types.js').HookName,
    ctx: PluginContext,
  ): Promise<CoreResult | undefined> {
    if (!this.pluginRegistry) return undefined;
    const result = await this.pluginRegistry.runHook(name, ctx);
    return result?.response;
  }

  /** Accesseurs pour les tests et l'API d'administration */
  getCacheStore(): CacheStore {
    return this.cacheStore;
  }

  getL2Cache(): RedisCacheStore | null {
    return this.l2Cache;
  }

  getInflightTracker(): InflightTracker {
    return this.inflightTracker;
  }

  private getProfileServerIdSet(profileId: string): Set<string> {
    return new Set(resolveConnectProfile(this.config, profileId).servers.map((server) => server.id));
  }
}
