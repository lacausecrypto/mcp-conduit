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
import type { ConduitMetrics } from '../observability/metrics.js';
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
    rateLimiter?: RateLimiter,
  ) {
    this.router = router;
    this.registry = registry;
    this.cacheStore = cacheStore;
    this.inflightTracker = inflightTracker;
    this.logger = logger;
    this.metrics = metrics;
    this.config = config;
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
    let clientId = context.rawHeaders['x-forwarded-for'] ?? 'anonymous';
    let tenantId = 'default';

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
    }

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
        return await this.handleToolCall(message, context, serverId, logContext, clientId, tenantId, pluginCtx);
      }

      if (method === 'tools/list') {
        return await this.handleToolsList(message, context, serverId, logContext, clientId);
      }

      // Passthrough pour toutes les autres méthodes
      return await this.handlePassthrough(message, context, serverId, logContext, clientId);
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
    pluginCtx: PluginContext,
  ): Promise<CoreResult> {
    const toolName = extractToolName(message) ?? '';
    const toolArgs = extractToolArgs(message);

    logContext.toolName = toolName;
    logContext.args = toolArgs;

    // =========================================================================
    // Étape 2 — ACL : vérifier si le client peut appeler cet outil
    // =========================================================================
    if (this.config.acl?.enabled) {
      // Résoudre le vrai serverId et toolName (sans namespace)
      const resolved = this.router.resolveToolCall(toolName);
      const aclServerId = resolved?.serverId ?? serverId;
      const aclToolName = resolved?.toolName ?? toolName;

      const decision = evaluateAcl(
        clientId,
        aclServerId,
        aclToolName,
        this.config.acl.policies,
        this.config.acl.default_action,
      );

      if (!decision.allowed) {
        this.metrics.aclDenialsTotal.inc({ client: clientId, server: aclServerId, tool: aclToolName });
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
            `Access denied: client '${clientId}' is not allowed to call '${aclToolName}' on server '${aclServerId}'`,
          ),
        };
      }
    }

    // =========================================================================
    // Étape 2b — Guardrails : inspecter l'appel d'outil
    // =========================================================================
    if (this.config.guardrails?.enabled) {
      const grServerId = this.router.resolveToolCall(toolName)?.serverId ?? serverId;
      const grToolName = this.router.resolveToolCall(toolName)?.toolName ?? toolName;
      const grDecision = evaluateGuardrails(
        { clientId, serverId: grServerId, toolName: grToolName, toolArgs },
        this.config.guardrails,
      );

      if (grDecision.action === 'block') {
        this.metrics.guardrailActionsTotal.inc({ rule: grDecision.rule_name, action: 'block', tool: grToolName });
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
            server_id: grServerId,
            tool_name: grToolName,
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

      if (grDecision.action === 'alert') {
        this.metrics.guardrailActionsTotal.inc({ rule: grDecision.rule_name, action: 'alert', tool: grToolName });
        if (grDecision.webhook) {
          sendWebhook(grDecision.webhook, {
            event: 'guardrail_alert',
            rule_name: grDecision.rule_name,
            severity: grDecision.severity ?? 'medium',
            client_id: clientId,
            server_id: grServerId,
            tool_name: grToolName,
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
        this.metrics.rateLimitRejectionsTotal.inc({ client: clientId, server: serverId, limit_type: blockedBy });
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

    const directClient = this.router.getClientForServer(serverId);
    if (directClient) {
      // Use resolveToolName (no extra selectReplica) just for namespace stripping
      const resolved = this.router.resolveToolName(toolName);
      if (resolved && resolved.serverId === serverId) {
        routed = { serverId: resolved.serverId, toolName: resolved.toolName, client: directClient };
      } else {
        routed = { serverId, toolName, client: directClient };
      }
    } else {
      routed = this.router.resolveToolCall(toolName);
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

    const actualServerId = routed.serverId;
    const actualToolName = routed.toolName;
    const client = routed.client;

    logContext.serverId = actualServerId;

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
      }
    }

    // Bypass si non-cacheable
    if (!policy.shouldCache || !this.config.cache.enabled) {
      this.cacheStore.recordSkip();
      this.metrics.requestsTotal.inc({
        server: actualServerId,
        method: 'tools/call',
        tool: actualToolName,
        status: 'success',
        cache_status: 'SKIP',
      });

      // Rate Limit côté serveur (cache bypass)
      if (this.config.rate_limits?.enabled && this.rateLimiter) {
        const rlResult = await this.rateLimiter.consumeServerLimits(clientId, actualServerId, actualToolName);
        if (!rlResult.allowed) {
          const blockedBy = rlResult.blocked_by ?? 'server';
          const retryAfter = rlResult.retry_after ?? 60;
          this.metrics.rateLimitRejectionsTotal.inc({ client: clientId, server: actualServerId, limit_type: blockedBy });
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
      const result = await this.forwardToUpstream(forwardedMessage, context, client, actualServerId);

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

    // Extraction du tenant pour l'isolation multi-tenant
    const resolvedTenantId = this.config.tenant_isolation.enabled
      ? extractTenantId(context.authHeader) ?? tenantId
      : undefined;
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
        this.metrics.rateLimitRejectionsTotal.inc({ client: clientId, server: actualServerId, limit_type: blockedBy });
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
          const upstream = await this.forwardToUpstream(forwardedMessage, context, client, actualServerId);
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
      this.metrics.dedupCoalescedTotal.inc({ server: actualServerId, tool: actualToolName });
    }

    // =========================================================================
    // Hook: after:upstream
    // =========================================================================
    const afterUpstreamResult = await this.runHook('after:upstream', pluginCtx);
    if (afterUpstreamResult) return afterUpstreamResult;

    // =========================================================================
    // Étape 7 — Mise en cache
    // =========================================================================
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
  ): Promise<CoreResult> {
    const client = this.router.getClientForServer(serverId);
    if (client) {
      const result = await this.passthroughToServer(message, context, client);

      // Mise à jour des annotations depuis la réponse
      if (result.body && typeof result.body === 'object') {
        const body = result.body as { result?: { tools?: ToolMetadata[] } };
        const tools = body.result?.tools;
        if (Array.isArray(tools)) {
          this.registry.updateAnnotations(serverId, tools);
        }
      }

      // Filtrage ACL des outils
      let filteredBody = result.body;
      if (this.config.acl?.enabled && result.body && typeof result.body === 'object') {
        const body = result.body as { result?: { tools?: ToolMetadata[] } };
        const tools = body.result?.tools;
        if (Array.isArray(tools)) {
          const allowed = filterToolsList(
            clientId,
            serverId,
            tools,
            this.config.acl.policies,
            this.config.acl.default_action,
          );
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

    // Multi-serveur : agrégation avec filtrage ACL
    let tools: ToolMetadata[];
    if (this.config.acl?.enabled) {
      // Filtrer chaque outil par son serveur d'origine
      const aggregated = this.router.getAggregatedToolsWithServerIds();
      tools = aggregated
        .filter(({ serverId: sid, toolName }) => {
          const decision = evaluateAcl(
            clientId,
            sid,
            toolName,
            this.config.acl!.policies,
            this.config.acl!.default_action,
          );
          return decision.allowed;
        })
        .map(({ namespacedName, toolDef }) => ({ ...toolDef, name: namespacedName }));
    } else {
      const aggregatedMsg = this.router.buildAggregatedToolsList(message.id);
      const bodyResult = (aggregatedMsg as { result?: { tools?: ToolMetadata[] } }).result;
      tools = bodyResult?.tools ?? [];
    }

    const aggregated = buildJsonRpcResult(message.id, { tools });
    const bodyStr = JSON.stringify(aggregated);

    this.logger.log(logContext, {
      status: 'success',
      responseSize: bodyStr.length,
      cacheStatus: 'BYPASS',
    });

    return { body: aggregated, cacheStatus: 'BYPASS' };
  }

  /**
   * Passthrough transparent vers un serveur spécifique.
   */
  private async handlePassthrough(
    message: JsonRpcMessage,
    context: RequestContext,
    serverId: string,
    logContext: RequestLogContext,
    _clientId: string,
  ): Promise<CoreResult> {
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

    const result = await this.passthroughToServer(message, context, client);
    const bodyStr = result.body ? JSON.stringify(result.body) : '';

    this.logger.log(logContext, {
      status: 'success',
      responseSize: bodyStr.length,
      cacheStatus: 'BYPASS',
    });

    return { ...result, cacheStatus: 'BYPASS' };
  }

  /**
   * Transmet une requête vers un serveur en amont (sans logique de cache).
   */
  private async passthroughToServer(
    message: JsonRpcMessage,
    context: RequestContext,
    client: import('../proxy/mcp-client-interface.js').IMcpClient,
  ): Promise<CoreResult> {
    const extraHeaders = this.buildExtraHeaders(context);
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
    serverId: string,
  ): Promise<CoreResult> {
    try {
      return await this.passthroughToServer(message, context, client);
    } catch (error) {
      this.metrics.errorsTotal.inc({
        server: serverId,
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
  private buildExtraHeaders(context: RequestContext): Record<string, string> {
    const extra: Record<string, string> = {
      'X-Conduit-Trace-Id': context.traceId,
    };

    if (context.authHeader) {
      extra['Authorization'] = context.authHeader;
    }

    if (context.groupHeader) {
      extra['X-Conduit-Group'] = context.groupHeader;
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
}
