/**
 * Routes d'administration de la passerelle Conduit.
 * Expose les endpoints /conduit/* pour le monitoring et la gestion.
 */

import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { CacheStore } from '../cache/cache-store.js';
import type { InflightTracker } from '../cache/inflight.js';
import type { LogStore } from '../observability/log-store.js';
import type { ServerRegistry } from '../router/registry.js';
import type { ConduitMetrics } from '../observability/metrics.js';
import type { ConduitGatewayConfig } from '../config/types.js';
import type { LogFilters, RequestStatus } from '../observability/types.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import { evaluateAcl } from '../auth/acl.js';
import { authenticate } from '../auth/authenticator.js';
import { evaluateGuardrails } from '../guardrails/evaluator.js';
import { dashboardCsp, dashboardHtml } from '../dashboard/dashboard.js';
import type { RedisCacheStore } from '../cache/redis-cache.js';
import type { ServerConfig } from '../config/types.js';
import { createMcpClient } from '../proxy/client-factory.js';
import type { HttpRegistryBackend } from '../discovery/http-registry.js';
import type { DiscoveredServer } from '../discovery/types.js';
import { validateServerUrlWithDns, redactUrl } from '../utils/url-validator.js';
import {
  exportConnectProfile,
  getConnectTargetDefinition,
  isRemoteConnectTarget,
  listConnectProfiles,
  listConnectTargets,
  resolveConnectProfile,
  type ConnectScope,
  type ConnectTarget,
} from '../connect/export.js';
import { ConnectInstallSessionStore } from '../connect/install.js';
import { ConnectRemoteSessionStore } from '../connect/remote.js';
import {
  listImportTemplates,
  loadDescriptorFromUrl,
  mergeImportedProfiles,
  normalizeDescriptor,
} from '../connect/descriptor.js';
import { ConnectOfficialRegistryStore } from '../connect/registry.js';
import {
  applySmartRegistryFilters,
  buildSmartRegistryResponse,
  enrichSmartRegistryItem,
  type ConnectRegistryManagedRuntime,
} from '../connect/registry-smart.js';
import {
  isManagedRuntimeServer,
  markManagedRuntimeRelease,
  rollbackManagedRuntime,
  rolloutManagedRuntime,
  summarizeManagedRuntime,
} from '../runtime/managed.js';
import type { IdentityRuntime } from '../identity/runtime.js';
import type { IdentityStore } from '../identity/store.js';
import type {
  AuthenticatedPrincipal,
  ProfileIdentityPreflight,
  ServerIdentityPreflight,
} from '../identity/types.js';
import type { GovernanceRuntime } from '../governance/runtime.js';
import type { GovernanceStore } from '../governance/store.js';

const VERSION = '1.1.0';

/** Security headers applied to all admin responses */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};

function applySecurityHeaders(c: { header: (k: string, v: string) => void }): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    c.header(key, value);
  }
}

/**
 * Constant-time comparison for admin key validation (prevents timing attacks).
 */
function verifyAdminKey(provided: string, expected: string): boolean {
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function createAdminRouter(
  cacheStore: CacheStore,
  inflightTracker: InflightTracker,
  logStore: LogStore,
  registry: ServerRegistry,
  metrics: ConduitMetrics,
  config: ConduitGatewayConfig,
  rateLimiter?: RateLimiter,
  redisLimiter?: { ping(): Promise<boolean> },
  onReload?: (configPath?: string) => Promise<{ reloaded: string[]; skipped: string[]; errors: string[] }>,
  l2Cache?: RedisCacheStore,
  httpDiscovery?: HttpRegistryBackend,
  identityRuntime?: IdentityRuntime,
  identityStore?: IdentityStore,
  governanceRuntime?: GovernanceRuntime,
  governanceStore?: GovernanceStore,
): Hono {
  const app = new Hono();
  const connectInstallSessions = new ConnectInstallSessionStore();
  const connectRemoteSessions = new ConnectRemoteSessionStore();
  const officialRegistry = new ConnectOfficialRegistryStore(config);

  const adminKey = config.admin?.key;
  const allowPrivateNetworks = config.admin?.allow_private_networks === true;

  // =========================================================================
  // Security middleware — applied to ALL admin routes
  // =========================================================================

  // Request timeout — prevent admin operations from hanging indefinitely
  const ADMIN_TIMEOUT_MS = 30_000;
  app.use('*', async (c, next) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ADMIN_TIMEOUT_MS);
    try {
      await next();
    } finally {
      clearTimeout(timer);
    }
  });

  // Security headers on every response
  app.use('*', async (c, next) => {
    applySecurityHeaders(c);
    await next();
  });

  // Optional admin key authentication (runs BEFORE CSRF check so that
  // unauthenticated requests receive 401, not 403)
  if (adminKey) {
    const _adminKey = adminKey; // capture for closure
    app.use('*', async (c, next) => {
      // /conduit/health is always accessible (Kubernetes probes must not require auth)
      // /conduit/dashboard is always accessible (the HTML itself carries no secrets)
      if (
        c.req.path === '/conduit/health' ||
        c.req.path === '/health' ||
        c.req.path === '/conduit/dashboard' ||
        c.req.path.startsWith('/conduit/dashboard/') ||
        c.req.path.startsWith('/conduit/connect/install/bundles/') ||
        c.req.path.startsWith('/connect/install/bundles/') ||
        c.req.path.startsWith('/conduit/connect/remote/bundles/') ||
        c.req.path.startsWith('/connect/remote/bundles/')
      ) {
        return next();
      }

      const authHeader = c.req.header('authorization');
      const provided = authHeader?.startsWith('Bearer ')
        ? authHeader.slice(7)
        : (c.req.header('x-admin-key') ?? '');

      if (!verifyAdminKey(provided, _adminKey)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      return next();
    });
  }

  // CSRF protection for state-changing requests (POST, PUT, DELETE).
  // Requires a custom header that cannot be sent by simple cross-origin
  // requests (triggers a CORS preflight that will be blocked). We also
  // enforce a fixed whitelist of values so that a caller cannot blindly
  // echo back an arbitrary string — this narrows the contract that admin
  // clients must meet and surfaces misconfigured proxies explicitly.
  const CSRF_ALLOWED_VALUES = new Set(['1', 'true']);
  app.use('*', async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      const csrfHeader = c.req.header('x-conduit-admin');
      if (!csrfHeader) {
        return c.json(
          { error: 'Missing X-Conduit-Admin header (CSRF protection)' },
          403,
        );
      }
      if (!CSRF_ALLOWED_VALUES.has(csrfHeader.trim().toLowerCase())) {
        return c.json(
          { error: 'Invalid X-Conduit-Admin header value (expected "1" or "true")' },
          403,
        );
      }
    }
    return next();
  });

  // =========================================================================
  // Santé et statut
  // =========================================================================

  async function addServersToConduit(
    servers: ServerConfig[],
    options: { replaceExisting?: boolean } = {},
  ): Promise<{
    importedServers: string[];
    updatedServers: string[];
    skippedServers: { id: string; reason: string }[];
  }> {
    const importedServers: string[] = [];
    const updatedServers: string[] = [];
    const skippedServers: { id: string; reason: string }[] = [];

    for (const server of servers) {
      const existing = registry.getServerInfo(server.id);
      if (existing && !options.replaceExisting) {
        skippedServers.push({ id: server.id, reason: 'already exists' });
        continue;
      }

      if (server.url && server.transport !== 'stdio') {
        const urlCheck = await validateServerUrlWithDns(server.url, allowPrivateNetworks);
        if (!urlCheck.valid) {
          skippedServers.push({ id: server.id, reason: `invalid server URL: ${urlCheck.error}` });
          continue;
        }
      }

      try {
        if (existing && options.replaceExisting) {
          registry.removeServer(server.id);
          const existingIndex = config.servers.findIndex((candidate) => candidate.id === server.id);
          if (existingIndex >= 0) {
            config.servers.splice(existingIndex, 1);
          }
        }

        const client = createMcpClient(server);
        await registry.addServer(server, client);
        config.servers.push(server);
        if (existing && options.replaceExisting) {
          updatedServers.push(server.id);
        } else {
          importedServers.push(server.id);
        }
      } catch (error) {
        skippedServers.push({ id: server.id, reason: String(error instanceof Error ? error.message : error) });
      }
    }

    return { importedServers, updatedServers, skippedServers };
  }

  function ensureRegistryProfile(
    profileId: string,
    serverIds: string[],
    plan: { source: { name: string; strategy: string } },
  ): { profileId: string; profilesUpdated: string[] } {
    if (serverIds.length === 0) {
      return { profileId, profilesUpdated: [] };
    }

    const profiles = mergeImportedProfiles(config, [{
      id: profileId,
      label: profileId,
      description: `Servers imported from ${plan.source.name} via ${plan.source.strategy}.`,
      server_ids: serverIds,
    }]);

    return {
      profileId,
      profilesUpdated: profiles.upserted,
    };
  }

  async function deployManagedRuntimeServer(
    previous: ServerConfig,
    next: ServerConfig,
  ): Promise<{
    ok: boolean;
    current: ServerConfig;
    rolledBack: boolean;
    reason?: string;
  }> {
    const deployment = await addServersToConduit([next], {
      replaceExisting: true,
    });

    if (deployment.skippedServers.length > 0 || (deployment.updatedServers.length === 0 && deployment.importedServers.length === 0)) {
      await addServersToConduit([previous], { replaceExisting: true });
      return {
        ok: false,
        current: previous,
        rolledBack: true,
        reason: deployment.skippedServers[0]?.reason ?? 'rollout failed before health validation',
      };
    }

    const deployed = registry.getServerInfo(next.id);
    const gateEnabled = next.managed_runtime?.health_gate?.enabled !== false;
    if (gateEnabled && (!deployed || !deployed.health.healthy)) {
      const autoRollback = next.managed_runtime?.health_gate?.auto_rollback !== false;
      if (autoRollback) {
        await addServersToConduit([previous], { replaceExisting: true });
      }
      return {
        ok: false,
        current: autoRollback ? previous : next,
        rolledBack: autoRollback,
        reason: 'health gate failed after rollout',
      };
    }

    return {
      ok: true,
      current: next,
      rolledBack: false,
    };
  }

  function normalizePreflightPrincipal(
    source: Record<string, unknown>,
  ): { principal?: AuthenticatedPrincipal; error?: string } {
    const clientId = typeof source['client_id'] === 'string' && source['client_id'].trim()
      ? source['client_id'].trim()
      : undefined;
    const tenantId = typeof source['tenant_id'] === 'string' && source['tenant_id'].trim()
      ? source['tenant_id'].trim()
      : undefined;

    if ((clientId && !tenantId) || (!clientId && tenantId)) {
      return { error: 'client_id and tenant_id must be provided together' };
    }

    if (!clientId || !tenantId) {
      return {};
    }

    return {
      principal: {
        client_id: clientId,
        tenant_id: tenantId,
      },
    };
  }

  function resolveGovernanceWorkspaceId(
    source: Record<string, unknown>,
    principal?: AuthenticatedPrincipal,
  ): string {
    if (typeof source['workspace_id'] === 'string' && source['workspace_id'].trim()) {
      return source['workspace_id'].trim();
    }
    if (principal && governanceRuntime) {
      return governanceRuntime.resolveWorkspace(principal).id;
    }
    if (principal && identityRuntime) {
      return identityRuntime.resolveWorkspace(principal.tenant_id).id;
    }
    return config.identity?.default_workspace_id ?? 'default';
  }

  async function evaluateRegistryGovernance(
    source: Record<string, unknown>,
    serverName: string,
    version = 'latest',
    installModeHint?: string,
  ): Promise<{
    workspace_id: string;
    client_id?: string;
    roles: string[];
    decision: ReturnType<NonNullable<GovernanceRuntime>['evaluateRegistryPolicy']>;
  } | null> {
    if (!governanceRuntime?.isEnabled()) {
      return null;
    }

    const principalResult = normalizePreflightPrincipal(source);
    if (principalResult.error) {
      throw new Error(principalResult.error);
    }

    const workspaceId = resolveGovernanceWorkspaceId(source, principalResult.principal);
    const clientId = principalResult.principal?.client_id;
    const roles = clientId ? governanceRuntime.getRolesForClient(workspaceId, clientId) : [];
    const registryEntry = await officialRegistry.getLibraryItem(serverName, version);
    const packageTypes = registryEntry?.item.package_types ?? [];
    const installMode = installModeHint ?? registryEntry?.item.install_mode;
    const decision = governanceRuntime.evaluateRegistryPolicy({
      workspace_id: workspaceId,
      ...(clientId ? { client_id: clientId } : {}),
      roles,
      server_name: serverName,
      package_types: packageTypes,
      ...(installMode ? { install_mode: installMode } : {}),
    });

    return {
      workspace_id: workspaceId,
      ...(clientId ? { client_id: clientId } : {}),
      roles,
      decision,
    };
  }

  function buildFallbackServerPreflight(server: ServerConfig): ServerIdentityPreflight {
    const transport = server.transport ?? 'http';
    const requirement = server.upstream_auth?.connected_account;
    const forwardIdentityMode = server.upstream_auth?.forward_identity?.mode ?? 'none';

    if (!requirement) {
      return {
        server_id: server.id,
        transport,
        status: 'none',
        ready: true,
        blocking: false,
        forward_identity_mode: forwardIdentityMode,
      };
    }

    const binding = requirement.binding ?? 'client-or-workspace';
    const required = requirement.required !== false;
    return {
      server_id: server.id,
      transport,
      status: 'identity-disabled',
      ready: !required,
      blocking: required,
      forward_identity_mode: forwardIdentityMode,
      connected_account: {
        provider: requirement.provider,
        binding,
        required,
        resolved: false,
        status: 'identity-disabled',
        message: `Identity runtime is unavailable for server "${server.id}"`,
      },
    };
  }

  function buildServerIdentityPreflight(
    serverId: string,
    principal?: AuthenticatedPrincipal,
  ): ServerIdentityPreflight {
    const server = config.servers.find((candidate) => candidate.id === serverId);
    if (!server) {
      throw new Error(`Unknown server "${serverId}"`);
    }

    return identityRuntime
      ? identityRuntime.getServerPreflight(server, principal)
      : buildFallbackServerPreflight(server);
  }

  function buildProfileIdentityPreflight(
    profileId: string,
    principal?: AuthenticatedPrincipal,
  ): ProfileIdentityPreflight {
    const profile = resolveConnectProfile(config, profileId);

    if (identityRuntime) {
      return identityRuntime.getProfilePreflight(
        profile.id,
        profile.label,
        profile.servers,
        principal,
      );
    }

    const serverRequirements = profile.servers.map((server) => buildFallbackServerPreflight(server));
    return {
      profile_id: profile.id,
      profile_label: profile.label,
      ready: serverRequirements.every((requirement) => !requirement.blocking),
      blocking_count: serverRequirements.filter((requirement) => requirement.blocking).length,
      server_requirements: serverRequirements,
    };
  }

  /**
   * GET /conduit/health — Liveness probe.
   * Always returns 200 as long as the process is running.
   * Kubernetes should use this for livenessProbe.
   */
  app.get('/health', async (c) => {
    const backends = registry.getHealthStatus().map((h) => ({
      id: h.serverId,
      healthy: h.healthy,
      latency_ms: h.latencyMs,
      last_checked: h.lastChecked > 0 ? new Date(h.lastChecked).toISOString() : null,
    }));

    const anyBackendHealthy = backends.length === 0 || backends.some((b) => b.healthy);
    const dbWritable = logStore.ping();

    // Redis status — only present when Redis rate limiting is configured
    let redisStatus: { connected: boolean } | null = null;
    if (redisLimiter) {
      const connected = await redisLimiter.ping();
      redisStatus = { connected };
    }

    const status = anyBackendHealthy && dbWritable ? 'ok' : 'degraded';

    return c.json({
      status,
      uptime_seconds: process.uptime(),
      db_writable: dbWritable,
      backends,
      ...(redisStatus !== null ? { redis: redisStatus } : {}),
    }, status === 'ok' ? 200 : 503);
  });

  /**
   * GET /conduit/readyz — Readiness probe.
   * Returns 200 only when the gateway has at least one healthy backend
   * AND the database is writable. Kubernetes should use this for readinessProbe.
   */
  app.get('/readyz', (c) => {
    const backends = registry.getHealthStatus();
    const anyHealthy = backends.some((b) => b.healthy);
    const dbWritable = logStore.ping();

    if (!anyHealthy || !dbWritable) {
      return c.json({
        ready: false,
        backends_healthy: anyHealthy,
        db_writable: dbWritable,
      }, 503);
    }

    return c.json({ ready: true });
  });

  app.get('/version', (c) => {
    return c.json({
      version: VERSION,
      node_version: process.version,
    });
  });

  app.get('/settings', (c) => {
    const healthStatus = registry.getHealthStatus();
    const connectProfiles = listConnectProfiles(config);
    const httpServers = config.servers.filter((server) => server.transport !== 'stdio').length;
    const stdioServers = config.servers.filter((server) => server.transport === 'stdio').length;
    const replicaCount = config.servers.reduce((total, server) => total + (server.replicas?.length ?? 0), 0);
    const circuitBreaker = config.router.circuit_breaker;
    const otel = config.observability.opentelemetry;
    const discoveryBackends = config.discovery?.backends ?? [];
    const customProfiles = config.connect?.profiles ?? [];
    const pluginItems = config.plugins ?? [];

    return c.json({
      version: VERSION,
      node_version: process.version,
      runtime: {
        uptime_seconds: process.uptime(),
        reload_available: Boolean(onReload),
        backends_healthy: healthStatus.filter((backend) => backend.healthy).length,
        backends_total: healthStatus.length,
      },
      gateway: {
        host: config.gateway.host,
        port: config.gateway.port,
        tls_enabled: Boolean(config.gateway.tls?.enabled),
        mtls_enabled: Boolean(config.gateway.tls?.ca_path),
        min_tls_version: config.gateway.tls?.min_version ?? 'TLSv1.2',
        metrics_enabled: config.metrics.enabled,
        metrics_port: config.metrics.port,
      },
      routing: {
        namespace_strategy: config.router.namespace_strategy,
        load_balancing: config.router.load_balancing ?? 'round-robin',
        health_check: {
          enabled: config.router.health_check.enabled,
          interval_seconds: config.router.health_check.interval_seconds,
          timeout_ms: config.router.health_check.timeout_ms,
          unhealthy_threshold: config.router.health_check.unhealthy_threshold,
          healthy_threshold: config.router.health_check.healthy_threshold,
        },
        circuit_breaker: {
          enabled: Boolean(circuitBreaker?.enabled),
          failure_threshold: circuitBreaker?.failure_threshold ?? 5,
          reset_timeout_ms: circuitBreaker?.reset_timeout_ms ?? 30_000,
          half_open_max_requests: circuitBreaker?.half_open_max_requests ?? 1,
          success_threshold: circuitBreaker?.success_threshold ?? 2,
        },
      },
      security: {
        admin_key_enabled: Boolean(config.admin?.key),
        auth_method: config.auth?.method ?? 'none',
        identity_enabled: Boolean(config.identity?.enabled),
        governance_enabled: Boolean(config.governance?.enabled),
        tenant_isolation_enabled: config.tenant_isolation.enabled,
        tenant_header: config.tenant_isolation.header,
        acl_enabled: Boolean(config.acl?.enabled),
        acl_default_action: config.acl?.default_action ?? 'allow',
        acl_policies: config.acl?.policies.length ?? 0,
        guardrails_enabled: Boolean(config.guardrails?.enabled),
        guardrails_default_action: config.guardrails?.default_action ?? 'allow',
        guardrails_rules: config.guardrails?.rules.length ?? 0,
      },
      caching: {
        enabled: config.cache.enabled,
        l1_max_entries: config.cache.l1.max_entries,
        l1_max_entry_size_kb: config.cache.l1.max_entry_size_kb,
        l2_enabled: Boolean(config.cache.l2?.enabled),
        l2_ttl_multiplier: config.cache.l2?.default_ttl_multiplier ?? 3,
        l2_key_prefix: config.cache.l2?.key_prefix ?? 'conduit:cache:',
        l2_max_entry_size_kb: config.cache.l2?.max_entry_size_kb ?? 512,
      },
      observability: {
        log_args: config.observability.log_args,
        log_responses: config.observability.log_responses,
        redact_fields_count: config.observability.redact_fields.length,
        retention_days: config.observability.retention_days,
        database_mode: config.observability.db_path === ':memory:' ? 'in-memory' : 'file-backed',
        opentelemetry_enabled: Boolean(otel?.enabled),
        otel_service_name: otel?.service_name ?? null,
        otel_sample_rate: otel?.sample_rate ?? 1,
      },
      rate_limits: {
        enabled: Boolean(config.rate_limits?.enabled),
        backend: config.rate_limits?.backend ?? 'memory',
        has_global_limit: Boolean(config.rate_limits?.global),
        has_client_limit: Boolean(config.rate_limits?.per_client),
        overrides: config.rate_limits?.overrides?.length ?? 0,
        queue_enabled: Boolean(config.rate_limits?.queue?.enabled),
      },
      connect: {
        profiles: connectProfiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          server_count: profile.server_ids.length,
        })),
        custom_profiles: customProfiles.length,
        registry_enabled: Boolean(config.connect?.registry),
        registry_cache_ttl_seconds: config.connect?.registry?.cache_ttl_seconds ?? null,
        registry_latest_only: Boolean(config.connect?.registry?.latest_only),
        managed_runtime_enabled: config.connect?.managed_runtime?.enabled ?? false,
        managed_runtime_root_dir: config.connect?.managed_runtime?.root_dir ?? null,
        managed_runtime_default_channel: config.connect?.managed_runtime?.default_channel ?? null,
        managed_runtime_auto_rollback: config.connect?.managed_runtime?.auto_rollback ?? null,
      },
      identity: {
        enabled: identityRuntime?.isEnabled() ?? false,
        db_writable: identityStore?.ping() ?? false,
        workspaces: identityRuntime?.listWorkspaces().length ?? 0,
        templates: identityRuntime?.listConnectionTemplates().length ?? 0,
      },
      governance: {
        enabled: governanceRuntime?.isEnabled() ?? false,
        db_writable: governanceStore?.ping() ?? false,
        role_bindings: config.governance?.role_bindings?.length ?? 0,
        tool_policies: config.governance?.tool_policies?.length ?? 0,
        registry_policies: config.governance?.registry_policies?.length ?? 0,
        approvals_pending: governanceStore?.listApprovalRequests({ status: 'pending', limit: 1_000 }).length ?? 0,
      },
      servers: {
        total: config.servers.length,
        http: httpServers,
        stdio: stdioServers,
        replicas: replicaCount,
      },
      discovery: {
        enabled: Boolean(config.discovery?.enabled),
        poll_interval_seconds: config.discovery?.poll_interval_seconds ?? null,
        stale_timeout_seconds: config.discovery?.stale_timeout_seconds ?? null,
        backends: discoveryBackends.map((backend) => backend.type),
      },
      plugins: {
        count: pluginItems.length,
        items: pluginItems.map((plugin) => ({
          name: plugin.name,
          hooks: plugin.hooks.length,
        })),
      },
    });
  });

  // =========================================================================
  // Identity & credentials
  // =========================================================================

  app.get('/identity/settings', (c) => {
    return c.json({
      enabled: identityRuntime?.isEnabled() ?? false,
      has_store: Boolean(identityStore),
      db_writable: identityStore?.ping() ?? false,
      default_workspace_id: config.identity?.default_workspace_id ?? null,
      workspaces: identityRuntime?.listWorkspaces() ?? [],
      templates: identityRuntime?.listConnectionTemplates() ?? [],
    });
  });

  app.get('/identity/workspaces', (c) => {
    return c.json({
      enabled: identityRuntime?.isEnabled() ?? false,
      workspaces: identityRuntime?.listWorkspaces() ?? [],
    });
  });

  app.get('/identity/templates', (c) => {
    return c.json({
      templates: identityRuntime?.listConnectionTemplates() ?? [],
    });
  });

  app.get('/identity/accounts', (c) => {
    if (!identityStore) {
      return c.json({ enabled: false, accounts: [] });
    }

    const query = c.req.query();
    const accounts = identityStore.listConnectedAccounts({
      ...(query['workspace_id'] ? { workspace_id: query['workspace_id'] } : {}),
      ...(query['provider'] ? { provider: query['provider'] } : {}),
      ...(query['client_id'] ? { client_id: query['client_id'] } : {}),
      ...(query['tenant_id'] ? { tenant_id: query['tenant_id'] } : {}),
      ...(query['include_revoked'] ? { include_revoked: query['include_revoked'] === 'true' } : {}),
    });

    return c.json({
      enabled: true,
      count: accounts.length,
      accounts,
    });
  });

  app.post('/identity/accounts', async (c) => {
    if (!identityStore || !identityRuntime?.isEnabled()) {
      return c.json({ error: 'Identity plane is disabled' }, 400);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const workspaceId = typeof body['workspace_id'] === 'string'
      ? body['workspace_id']
      : typeof body['tenant_id'] === 'string'
        ? identityRuntime.resolveWorkspace(body['tenant_id']).id
        : (config.identity?.default_workspace_id ?? 'default');

    try {
      const account = identityStore.createConnectedAccount({
        workspace_id: workspaceId,
        provider: String(body['provider'] ?? ''),
        ...(typeof body['client_id'] === 'string' ? { client_id: body['client_id'] } : {}),
        ...(typeof body['tenant_id'] === 'string' ? { tenant_id: body['tenant_id'] } : {}),
        ...(typeof body['label'] === 'string' ? { label: body['label'] } : {}),
        access_token: String(body['access_token'] ?? ''),
        ...(typeof body['refresh_token'] === 'string' ? { refresh_token: body['refresh_token'] } : {}),
        ...(typeof body['token_type'] === 'string' ? { token_type: body['token_type'] } : {}),
        ...(body['metadata'] && typeof body['metadata'] === 'object' && !Array.isArray(body['metadata'])
          ? { metadata: body['metadata'] as Record<string, unknown> }
          : {}),
        ...(body['replace_existing'] !== undefined ? { replace_existing: body['replace_existing'] !== false } : {}),
      });
      return c.json(account, 201);
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  app.post('/identity/accounts/:id/revoke', (c) => {
    if (!identityStore) {
      return c.json({ error: 'Identity plane is disabled' }, 400);
    }

    const id = c.req.param('id');
    const account = identityStore.revokeConnectedAccount(id);
    if (!account) {
      return c.json({ error: `Connected account "${id}" not found` }, 404);
    }

    return c.json({
      revoked: true,
      account,
    });
  });

  app.get('/identity/preflight/server/:id', (c) => {
    const principalResult = normalizePreflightPrincipal(c.req.query());
    if (principalResult.error) {
      return c.json({ error: principalResult.error }, 400);
    }

    try {
      const server = buildServerIdentityPreflight(c.req.param('id'), principalResult.principal);
      return c.json({
        enabled: identityRuntime?.isEnabled() ?? false,
        principal: principalResult.principal ?? null,
        server,
      });
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 404);
    }
  });

  app.get('/identity/preflight/profile/:id', (c) => {
    const principalResult = normalizePreflightPrincipal(c.req.query());
    if (principalResult.error) {
      return c.json({ error: principalResult.error }, 400);
    }

    try {
      const profile = buildProfileIdentityPreflight(c.req.param('id'), principalResult.principal);
      return c.json({
        enabled: identityRuntime?.isEnabled() ?? false,
        principal: principalResult.principal ?? null,
        profile,
      });
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 404);
    }
  });

  // =========================================================================
  // Governance plane
  // =========================================================================

  app.get('/governance/settings', (c) => {
    return c.json({
      enabled: governanceRuntime?.isEnabled() ?? false,
      has_store: Boolean(governanceStore),
      db_writable: governanceStore?.ping() ?? false,
      registry_default_action: config.governance?.registry_default_action ?? 'allow',
      role_bindings: config.governance?.role_bindings ?? [],
      tool_policies: config.governance?.tool_policies ?? [],
      registry_policies: config.governance?.registry_policies ?? [],
      approvals: config.governance?.approvals ?? null,
      quotas: config.governance?.quotas ?? null,
    });
  });

  app.get('/governance/roles', (c) => {
    const query = c.req.query();
    const workspaceId = typeof query['workspace_id'] === 'string' && query['workspace_id']
      ? query['workspace_id']
      : undefined;
    const clientId = typeof query['client_id'] === 'string' && query['client_id']
      ? query['client_id']
      : undefined;

    return c.json({
      enabled: governanceRuntime?.isEnabled() ?? false,
      bindings: governanceRuntime?.listRoleBindings(workspaceId) ?? [],
      ...(workspaceId && clientId
        ? { resolved: governanceRuntime?.getRoleSummary(workspaceId, clientId) ?? { workspace_id: workspaceId, client_id: clientId, roles: [] } }
        : {}),
    });
  });

  app.get('/governance/quotas/workspace/:id', async (c) => {
    const workspaceId = c.req.param('id');
    if (!governanceRuntime?.isEnabled()) {
      return c.json({ workspace_id: workspaceId, enabled: false, limits: [] });
    }
    return c.json(await governanceRuntime.getWorkspaceQuota(workspaceId));
  });

  app.get('/governance/approvals', (c) => {
    if (!governanceStore || !governanceRuntime?.isEnabled()) {
      return c.json({ enabled: false, approvals: [] });
    }

    const query = c.req.query();
    const approvals = governanceRuntime.listApprovalRequests({
      ...(typeof query['workspace_id'] === 'string' ? { workspace_id: query['workspace_id'] } : {}),
      ...(typeof query['status'] === 'string' ? { status: query['status'] as 'pending' | 'approved' | 'rejected' | 'expired' } : {}),
      ...(typeof query['requester_client_id'] === 'string' ? { requester_client_id: query['requester_client_id'] } : {}),
      ...(typeof query['approver_client_id'] === 'string' ? { approver_client_id: query['approver_client_id'] } : {}),
      ...(typeof query['source'] === 'string' ? { source: query['source'] as 'guardrail' | 'governance' } : {}),
      ...(typeof query['limit'] === 'string' ? { limit: Number(query['limit']) } : {}),
      ...(typeof query['offset'] === 'string' ? { offset: Number(query['offset']) } : {}),
    });

    return c.json({
      enabled: true,
      count: approvals.length,
      approvals,
    });
  });

  /**
   * When the gateway is configured with identity-aware auth (jwt or api-key),
   * an approval decision must be tied to the authenticated principal — not
   * just to a client_id string in the body. Without this binding, anyone with
   * the admin token could approve as anyone else (cf. audit Sprint 3 #2).
   *
   * Returns the principal to forward to the governance runtime, or null if
   * auth is configured but the request was not authenticated.
   */
  async function resolveApproverPrincipal(
    c: import('hono').Context,
  ): Promise<{ principal?: { client_id: string; tenant_id: string }; error?: string }> {
    if (!config.auth || config.auth.method === 'none') {
      // Admin-key-only mode: trust the body. The audit explicitly notes this
      // is a weaker posture; operators are encouraged to enable auth.method.
      return {};
    }

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const authResult = await authenticate(headers, config.auth);
    if (!authResult.authenticated) {
      return { error: authResult.error ?? 'Approver identity authentication required' };
    }
    return { principal: { client_id: authResult.client_id, tenant_id: authResult.tenant_id } };
  }

  app.post('/governance/approvals/:id/approve', async (c) => {
    if (!governanceRuntime?.isEnabled()) {
      return c.json({ error: 'Governance plane is disabled' }, 400);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const approverClientId = typeof body['approver_client_id'] === 'string' ? body['approver_client_id'] : null;
    if (!approverClientId) {
      return c.json({ error: 'approver_client_id is required' }, 400);
    }

    const approver = await resolveApproverPrincipal(c);
    if (approver.error) {
      return c.json({ error: approver.error }, 401);
    }

    try {
      const decision = governanceRuntime.decideApproval(
        c.req.param('id'),
        approverClientId,
        'approved',
        typeof body['note'] === 'string' ? body['note'] : undefined,
        approver.principal ? { authenticatedPrincipal: approver.principal } : {},
      );
      return c.json(decision);
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  app.post('/governance/approvals/:id/reject', async (c) => {
    if (!governanceRuntime?.isEnabled()) {
      return c.json({ error: 'Governance plane is disabled' }, 400);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const approverClientId = typeof body['approver_client_id'] === 'string' ? body['approver_client_id'] : null;
    if (!approverClientId) {
      return c.json({ error: 'approver_client_id is required' }, 400);
    }

    const approver = await resolveApproverPrincipal(c);
    if (approver.error) {
      return c.json({ error: approver.error }, 401);
    }

    try {
      const decision = governanceRuntime.decideApproval(
        c.req.param('id'),
        approverClientId,
        'rejected',
        typeof body['note'] === 'string' ? body['note'] : undefined,
        approver.principal ? { authenticatedPrincipal: approver.principal } : {},
      );
      return c.json(decision);
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  app.get('/governance/audit', (c) => {
    if (!governanceStore || !governanceRuntime?.isEnabled()) {
      return c.json({ enabled: false, events: [] });
    }

    const query = c.req.query();
    const events = governanceRuntime.listAuditEvents({
      ...(typeof query['workspace_id'] === 'string' ? { workspace_id: query['workspace_id'] } : {}),
      ...(typeof query['actor_client_id'] === 'string' ? { actor_client_id: query['actor_client_id'] } : {}),
      ...(typeof query['action'] === 'string' ? { action: query['action'] } : {}),
      ...(typeof query['outcome'] === 'string' ? { outcome: query['outcome'] as 'success' | 'denied' | 'pending' | 'error' } : {}),
      ...(typeof query['limit'] === 'string' ? { limit: Number(query['limit']) } : {}),
      ...(typeof query['offset'] === 'string' ? { offset: Number(query['offset']) } : {}),
    });

    return c.json({
      enabled: true,
      count: events.length,
      events,
    });
  });

  // =========================================================================
  // Connect exports
  // =========================================================================

  app.get('/connect/catalog', (c) => {
    const principalResult = normalizePreflightPrincipal(c.req.query());
    if (principalResult.error) {
      return c.json({ error: principalResult.error }, 400);
    }

    const profiles = listConnectProfiles(config);
    return c.json({
      profiles,
      targets: listConnectTargets(),
      identity: {
        enabled: identityRuntime?.isEnabled() ?? false,
        principal: principalResult.principal ?? null,
        profiles: profiles.map((profile) => buildProfileIdentityPreflight(profile.id, principalResult.principal)),
      },
      governance: {
        enabled: governanceRuntime?.isEnabled() ?? false,
      },
    });
  });

  app.get('/connect/import/catalog', (c) => {
    return c.json({
      templates: listImportTemplates(),
    });
  });

  app.get('/connect/registry/library', async (c) => {
    const query = c.req.query();
    try {
      const snapshot = await officialRegistry.listResolvedLibrary();
      const principalResult = normalizePreflightPrincipal(query);
      if (principalResult.error) {
        return c.json({ error: principalResult.error }, 400);
      }
      const workspaceId = resolveGovernanceWorkspaceId(query, principalResult.principal);
      const roles = governanceRuntime?.isEnabled() && principalResult.principal
        ? governanceRuntime.getRolesForClient(workspaceId, principalResult.principal.client_id)
        : [];
      const targets = listConnectTargets();
      const profileMembership = new Map<string, string[]>();
      for (const profile of listConnectProfiles(config)) {
        for (const serverId of profile.server_ids) {
          const existing = profileMembership.get(serverId) ?? [];
          existing.push(profile.id);
          profileMembership.set(serverId, existing);
        }
      }

      const enrichedItems = snapshot.items.map((resolution) => {
        const managed = registry.getServerInfo(resolution.item.conduit_id);
        const managedRuntime: ConnectRegistryManagedRuntime | undefined = managed
          ? {
            managed: true,
            healthy: managed.health.healthy,
            tool_count: managed.tools.length,
            latency_ms: managed.health.latencyMs,
            ...(managed.health.lastChecked > 0 ? { last_checked: new Date(managed.health.lastChecked).toISOString() } : {}),
            profile_ids: profileMembership.get(resolution.item.conduit_id) ?? [],
          }
          : undefined;
        const governanceDecision = governanceRuntime?.isEnabled()
          ? governanceRuntime.evaluateRegistryPolicy({
            workspace_id: workspaceId,
            ...(principalResult.principal ? { client_id: principalResult.principal.client_id } : {}),
            roles,
            server_name: resolution.item.name,
            package_types: resolution.item.package_types,
            install_mode: resolution.item.install_mode,
          })
          : undefined;

        return enrichSmartRegistryItem({
          item: resolution.item,
          raw: resolution.raw,
          targets,
          ...(managedRuntime ? { managedRuntime } : {}),
          ...(governanceRuntime?.isEnabled()
            ? {
              policy: {
                workspace_id: workspaceId,
                roles,
                ...(governanceDecision ? { decision: governanceDecision } : {}),
              },
            }
            : {}),
        });
      });

      const limitRaw = query['limit'] ? Number(query['limit']) : 24;
      const offsetRaw = query['offset'] ? Number(query['offset']) : 0;
      const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.trunc(limitRaw))) : 24;
      const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;
      const filtered = applySmartRegistryFilters(enrichedItems, {
        ...(query['search'] ? { search: query['search'] } : {}),
        ...(query['status'] ? { status: query['status'] } : {}),
        ...(query['install_mode'] ? { install_mode: query['install_mode'] as 'remote' | 'package' | 'hybrid' } : {}),
        ...(query['readiness'] ? { readiness: query['readiness'] as 'ready' | 'needs-config' | 'manual' | 'blocked' } : {}),
        ...(query['package_type'] ? { package_type: query['package_type'] as 'npm' | 'pypi' | 'nuget' | 'oci' | 'mcpb' | 'unknown' } : {}),
        ...(query['min_score'] ? { min_score: Number(query['min_score']) } : {}),
        ...(query['auto_importable'] ? { auto_importable: query['auto_importable'] === 'true' } : {}),
        ...(query['verified_publisher'] ? { verified_publisher: query['verified_publisher'] === 'true' } : {}),
        ...(query['runtime_status'] ? { runtime_status: query['runtime_status'] as 'not-imported' | 'healthy' | 'unhealthy' } : {}),
        ...(query['policy_fit'] ? { policy_fit: query['policy_fit'] as 'allowed' | 'blocked' } : {}),
        ...(query['target'] ? { target: query['target'] as ConnectTarget } : {}),
        ...(query['sort'] ? { sort: query['sort'] as 'relevance' | 'trust' | 'updated' | 'published' | 'name' | 'runtime' } : {}),
      });
      const result = buildSmartRegistryResponse({
        snapshot,
        items: enrichedItems,
        filtered,
        limit,
        offset,
        targets,
      });

      return c.json({
        ...result,
        ...(governanceRuntime?.isEnabled()
          ? {
            governance: {
              workspace_id: workspaceId,
              ...(principalResult.principal ? { client_id: principalResult.principal.client_id } : {}),
              roles,
            },
          }
          : {}),
      });
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 502);
    }
  });

  app.post('/connect/registry/refresh', async (c) => {
    try {
      const result = await officialRegistry.refresh(true);
      return c.json(result);
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 502);
    }
  });

  app.get('/connect/export', (c) => {
    const query = c.req.query();
    const principalResult = normalizePreflightPrincipal(query);
    if (principalResult.error) {
      return c.json({ error: principalResult.error }, 400);
    }
    const target = query['target'] as ConnectTarget | undefined;
    const profile = query['profile'] ?? 'default';
    const scope = (query['scope'] ?? 'user') as ConnectScope;
    const baseUrl = query['base_url'] ?? new URL(c.req.url).origin;

    try {
      const result = exportConnectProfile(config, {
        target: target as ConnectTarget,
        profile,
        scope,
        baseUrl,
      });
      return c.json({
        ...result,
        identity_preflight: buildProfileIdentityPreflight(profile, principalResult.principal),
      });
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  app.post('/connect/install/session', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const target = body['target'];
    const profile = body['profile'];
    const scope = body['scope'];
    const baseUrl = body['base_url'];
    const authSecret = body['auth_secret'];
    const principalResult = normalizePreflightPrincipal(body);

    if (principalResult.error) {
      return c.json({ error: principalResult.error }, 400);
    }

    if (typeof target !== 'string') {
      return c.json({ error: 'target is required' }, 400);
    }

    if (isRemoteConnectTarget(target as ConnectTarget)) {
      return c.json({ error: 'Use /conduit/connect/remote/session for remote connector targets' }, 400);
    }

    try {
      const session = connectInstallSessions.createSession(config, {
        target: target as ConnectTarget,
        profile: typeof profile === 'string' ? profile : 'default',
        scope: typeof scope === 'string' ? scope as ConnectScope : 'user',
        baseUrl: typeof baseUrl === 'string' ? baseUrl : new URL(c.req.url).origin,
        bundleBaseUrl: new URL(c.req.url).origin,
        identityPreflight: buildProfileIdentityPreflight(
          typeof profile === 'string' ? profile : 'default',
          principalResult.principal,
        ),
        ...(typeof authSecret === 'string' ? { authSecret } : {}),
      });

      return c.json(session, 201);
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  app.get('/connect/install/bundles/:token', (c) => {
    const token = c.req.param('token');
    const bundle = connectInstallSessions.getBundle(token);
    if (!bundle) {
      return c.json({ error: 'Install bundle not found or expired' }, 404);
    }

    return c.json(bundle);
  });

  app.post('/connect/remote/session', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const target = body['target'];
    const profile = body['profile'];
    const scope = body['scope'];
    const baseUrl = body['base_url'];
    const principalResult = normalizePreflightPrincipal(body);

    if (principalResult.error) {
      return c.json({ error: principalResult.error }, 400);
    }

    if (typeof target !== 'string') {
      return c.json({ error: 'target is required' }, 400);
    }

    if (!isRemoteConnectTarget(target as ConnectTarget)) {
      return c.json({ error: 'Remote session target must be a remote connector' }, 400);
    }

    try {
      const session = connectRemoteSessions.createSession(config, {
        target: target as ConnectTarget,
        profile: typeof profile === 'string' ? profile : 'default',
        scope: typeof scope === 'string' ? scope as ConnectScope : 'user',
        baseUrl: typeof baseUrl === 'string' ? baseUrl : new URL(c.req.url).origin,
        bundleBaseUrl: new URL(c.req.url).origin,
        identityPreflight: buildProfileIdentityPreflight(
          typeof profile === 'string' ? profile : 'default',
          principalResult.principal,
        ),
      });

      return c.json(session, 201);
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  app.get('/connect/remote/bundles/:token', (c) => {
    const token = c.req.param('token');
    const bundle = connectRemoteSessions.getBundle(token);
    if (!bundle) {
      return c.json({ error: 'Remote bundle not found or expired' }, 404);
    }

    return c.json(bundle);
  });

  app.post('/connect/import', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    let descriptorImport;
    try {
      if (typeof body['descriptor_url'] === 'string') {
        descriptorImport = await loadDescriptorFromUrl(body['descriptor_url'], {
          allowPrivateNetworks,
        });
      } else if (body['descriptor'] !== undefined) {
        descriptorImport = normalizeDescriptor(body['descriptor']);
      } else {
        return c.json({ error: 'descriptor_url or descriptor is required' }, 400);
      }
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
    }

      const { importedServers, skippedServers } = await addServersToConduit(descriptorImport.servers);

    const profileId = typeof body['profile_id'] === 'string' ? body['profile_id'] : null;
    const importedProfiles = descriptorImport.profiles.map((profile) => ({
      ...profile,
      server_ids: profile.server_ids.filter((serverId) => importedServers.includes(serverId) || Boolean(registry.getServerInfo(serverId))),
    }));

    if (profileId && importedServers.length > 0) {
      importedProfiles.push({
        id: profileId,
        label: profileId,
        description: `Servers imported into profile "${profileId}".`,
        server_ids: importedServers,
      });
    }

    const profiles = mergeImportedProfiles(config, importedProfiles);

    return c.json({
      descriptor: {
        name: descriptorImport.name,
        ...(descriptorImport.description ? { description: descriptorImport.description } : {}),
      },
      imported_servers: importedServers,
      skipped_servers: skippedServers,
      profiles_updated: profiles.upserted,
    }, importedServers.length > 0 ? 201 : 200);
  });

  app.post('/connect/registry/import', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const serverName = typeof body['server_name'] === 'string' ? body['server_name'] : null;
    const version = typeof body['version'] === 'string' ? body['version'] : 'latest';
    const profileId = typeof body['profile_id'] === 'string' ? body['profile_id'] : null;
    const strategy = body['strategy'] === 'proxy-remote' || body['strategy'] === 'conduit-host-package'
      ? body['strategy']
      : undefined;
    const principalResult = normalizePreflightPrincipal(body);
    if (principalResult.error) {
      return c.json({ error: principalResult.error }, 400);
    }
    if (!serverName) {
      return c.json({ error: 'server_name is required' }, 400);
    }

    try {
      const registryGovernance = await evaluateRegistryGovernance(body, serverName, version, strategy === 'conduit-host-package' ? 'package' : strategy === 'proxy-remote' ? 'remote' : undefined);
      if (registryGovernance && !registryGovernance.decision.allowed) {
        governanceRuntime?.audit({
          workspace_id: registryGovernance.workspace_id,
          action: 'registry_import_denied',
          resource_type: 'registry_server',
          resource_id: serverName,
          outcome: 'denied',
          ...(registryGovernance.client_id ? { actor_client_id: registryGovernance.client_id } : {}),
          details: {
            policy_name: registryGovernance.decision.policy_name,
          },
        });
        return c.json({
          error: registryGovernance.decision.reason,
          governance: registryGovernance,
        }, 403);
      }

      const plan = await officialRegistry.createImportPlan(serverName, version, {
        ...(strategy ? { strategy } : {}),
        ...normalizeStringMapBody(body['variables'], 'variables'),
        ...normalizeStringMapBody(body['headers'], 'headers'),
        ...normalizeStringMapBody(body['env'], 'env'),
      });
      const { importedServers, updatedServers, skippedServers } = await addServersToConduit([plan.server]);

      const profileServers = [plan.server.id].filter((serverId) => importedServers.includes(serverId) || updatedServers.includes(serverId) || Boolean(registry.getServerInfo(serverId)));
      const profiles = profileId && profileServers.length > 0
        ? mergeImportedProfiles(config, [{
          id: profileId,
          label: profileId,
          description: `Servers imported from the official registry into profile "${profileId}".`,
          server_ids: profileServers,
        }])
        : { upserted: [] as string[] };

      return c.json({
        source: plan.source,
        imported_servers: importedServers,
        updated_servers: updatedServers,
        skipped_servers: skippedServers,
        profiles_updated: profiles.upserted,
        server_identity_preflight: buildServerIdentityPreflight(plan.server.id, principalResult.principal),
        ...(registryGovernance ? { governance: registryGovernance } : {}),
      }, importedServers.length > 0 ? 201 : 200);
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  app.post('/connect/registry/install', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const serverName = typeof body['server_name'] === 'string' ? body['server_name'] : null;
    const version = typeof body['version'] === 'string' ? body['version'] : 'latest';
    const target = typeof body['target'] === 'string' ? body['target'] as ConnectTarget : null;
    const scope = typeof body['scope'] === 'string' ? body['scope'] as ConnectScope : 'user';
    const authSecret = typeof body['auth_secret'] === 'string' ? body['auth_secret'] : undefined;
    const strategy = body['strategy'] === 'proxy-remote' || body['strategy'] === 'conduit-host-package'
      ? body['strategy']
      : undefined;
    const baseUrl = typeof body['base_url'] === 'string' ? body['base_url'] : new URL(c.req.url).origin;
    const profileIdInput = typeof body['profile_id'] === 'string' ? body['profile_id'] : null;
    const principalResult = normalizePreflightPrincipal(body);

    if (principalResult.error) {
      return c.json({ error: principalResult.error }, 400);
    }

    if (!serverName) {
      return c.json({ error: 'server_name is required' }, 400);
    }

    if (!target) {
      return c.json({ error: 'target is required' }, 400);
    }

    try {
      const registryGovernance = await evaluateRegistryGovernance(body, serverName, version, strategy === 'conduit-host-package' ? 'package' : strategy === 'proxy-remote' ? 'remote' : undefined);
      if (registryGovernance && !registryGovernance.decision.allowed) {
        governanceRuntime?.audit({
          workspace_id: registryGovernance.workspace_id,
          action: 'registry_install_denied',
          resource_type: 'registry_server',
          resource_id: serverName,
          outcome: 'denied',
          ...(registryGovernance.client_id ? { actor_client_id: registryGovernance.client_id } : {}),
          details: {
            policy_name: registryGovernance.decision.policy_name,
            target,
          },
        });
        return c.json({
          error: registryGovernance.decision.reason,
          governance: registryGovernance,
        }, 403);
      }

      const plan = await officialRegistry.createImportPlan(serverName, version, {
        ...(strategy ? { strategy } : {}),
        ...normalizeStringMapBody(body['variables'], 'variables'),
        ...normalizeStringMapBody(body['headers'], 'headers'),
        ...normalizeStringMapBody(body['env'], 'env'),
      });

      const { importedServers, updatedServers, skippedServers } = await addServersToConduit([plan.server], {
        replaceExisting: true,
      });

      const effectiveProfileId = profileIdInput ?? `registry-${plan.server.id}`;
      const profileServers = [plan.server.id].filter((serverId) => importedServers.includes(serverId) || updatedServers.includes(serverId) || Boolean(registry.getServerInfo(serverId)));
      const profileResult = ensureRegistryProfile(effectiveProfileId, profileServers, plan);
      const identityPreflight = buildProfileIdentityPreflight(profileResult.profileId, principalResult.principal);
      const distributionSession = isRemoteConnectTarget(target)
        ? connectRemoteSessions.createSession(config, {
          target,
          profile: profileResult.profileId,
          scope,
          baseUrl,
          bundleBaseUrl: new URL(c.req.url).origin,
          identityPreflight,
        })
        : connectInstallSessions.createSession(config, {
          target,
          profile: profileResult.profileId,
          scope,
          baseUrl,
          bundleBaseUrl: new URL(c.req.url).origin,
          identityPreflight,
          ...(authSecret ? { authSecret } : {}),
        });

      return c.json({
        source: plan.source,
        profile_id: profileResult.profileId,
        imported_servers: importedServers,
        updated_servers: updatedServers,
        skipped_servers: skippedServers,
        profiles_updated: profileResult.profilesUpdated,
        server_identity_preflight: buildServerIdentityPreflight(plan.server.id, principalResult.principal),
        identity_preflight: identityPreflight,
        target_delivery: getConnectTargetDefinition(target).delivery,
        ...(registryGovernance ? { governance: registryGovernance } : {}),
        ...(isRemoteConnectTarget(target)
          ? { remote_session: distributionSession }
          : { install_session: distributionSession }),
      }, 201);
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  app.get('/runtime/managed/servers', (c) => {
    const items = registry.getAllServers()
      .map((serverInfo) => summarizeManagedRuntime(serverInfo))
      .filter((item): item is NonNullable<typeof item> => item !== null);

    return c.json({
      total: items.length,
      items,
    });
  });

  app.get('/runtime/managed/servers/:id', (c) => {
    const serverInfo = registry.getServerInfo(c.req.param('id'));
    if (!serverInfo || !isManagedRuntimeServer(serverInfo.config)) {
      return c.json({ error: 'Managed runtime server not found' }, 404);
    }

    return c.json(summarizeManagedRuntime(serverInfo));
  });

  app.post('/runtime/managed/servers/:id/rollout', async (c) => {
    const serverId = c.req.param('id');
    const currentInfo = registry.getServerInfo(serverId);
    if (!currentInfo || !isManagedRuntimeServer(currentInfo.config)) {
      return c.json({ error: 'Managed runtime server not found' }, 404);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const version = typeof body['version'] === 'string' && body['version'].trim()
      ? body['version'].trim()
      : null;
    if (!version) {
      return c.json({ error: 'version is required' }, 400);
    }

    try {
      const rollout = rolloutManagedRuntime(currentInfo.config, {
        version,
        ...(typeof body['channel'] === 'string' ? { channel: body['channel'] as NonNullable<ServerConfig['managed_runtime']>['channel'] } : {}),
        ...(body['env'] && typeof body['env'] === 'object' && !Array.isArray(body['env'])
          ? { env: Object.fromEntries(Object.entries(body['env'] as Record<string, unknown>).map(([key, value]) => [key, String(value)])) }
          : {}),
        ...(typeof body['notes'] === 'string' ? { notes: body['notes'] } : {}),
        ...(typeof body['command'] === 'string' ? { command: body['command'] } : {}),
        ...(Array.isArray(body['args']) ? { args: body['args'].map(String) } : {}),
      });

      const result = await deployManagedRuntimeServer(currentInfo.config, rollout.server);
      if (!result.ok) {
        return c.json({
          error: result.reason,
          rolled_back: result.rolledBack,
          runtime: summarizeManagedRuntime(registry.getServerInfo(serverId) ?? currentInfo) ?? null,
        }, 409);
      }

      const finalized = markManagedRuntimeRelease(rollout.server, rollout.release.id, 'healthy');
      const currentIndex = config.servers.findIndex((server) => server.id === serverId);
      if (currentIndex >= 0) {
        config.servers[currentIndex] = finalized;
      }
      const registryInfo = registry.getServerInfo(serverId);
      if (registryInfo) {
        registryInfo.config = finalized;
      }

      return c.json({
        rollout: {
          server_id: serverId,
          release_id: rollout.release.id,
          version: rollout.release.version,
          channel: rollout.release.channel,
        },
        runtime: summarizeManagedRuntime(registry.getServerInfo(serverId) ?? currentInfo),
      }, 200);
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  app.post('/runtime/managed/servers/:id/rollback', async (c) => {
    const serverId = c.req.param('id');
    const currentInfo = registry.getServerInfo(serverId);
    if (!currentInfo || !isManagedRuntimeServer(currentInfo.config)) {
      return c.json({ error: 'Managed runtime server not found' }, 404);
    }

    let body: Record<string, unknown> = {};
    try {
      if ((c.req.header('content-type') ?? '').includes('application/json')) {
        body = await c.req.json<Record<string, unknown>>();
      }
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const rollback = rollbackManagedRuntime(
        currentInfo.config,
        typeof body['release_id'] === 'string' ? body['release_id'] : undefined,
      );
      const result = await deployManagedRuntimeServer(currentInfo.config, rollback);
      if (!result.ok) {
        return c.json({
          error: result.reason,
          rolled_back: result.rolledBack,
          runtime: summarizeManagedRuntime(registry.getServerInfo(serverId) ?? currentInfo) ?? null,
        }, 409);
      }

      const activeReleaseId = rollback.managed_runtime?.active_release_id;
      const finalized = activeReleaseId
        ? markManagedRuntimeRelease(rollback, activeReleaseId, 'healthy')
        : rollback;
      const currentIndex = config.servers.findIndex((server) => server.id === serverId);
      if (currentIndex >= 0) {
        config.servers[currentIndex] = finalized;
      }
      const registryInfo = registry.getServerInfo(serverId);
      if (registryInfo) {
        registryInfo.config = finalized;
      }

      return c.json({
        rollback: {
          server_id: serverId,
          release_id: finalized.managed_runtime?.active_release_id ?? null,
        },
        runtime: summarizeManagedRuntime(registry.getServerInfo(serverId) ?? currentInfo),
      }, 200);
    } catch (error) {
      return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
    }
  });

  // =========================================================================
  // Config hot-reload
  // =========================================================================

  /**
   * POST /conduit/config/reload
   * Triggers the same reload as SIGHUP: re-reads the config file and applies
   * hot-reloadable changes (ACL, rate limits, cache TTLs, observability).
   * Returns a report of what was reloaded, skipped, and any errors.
   */
  app.post('/config/reload', async (c) => {
    if (!onReload) {
      return c.json({ error: 'Reload not available' }, 501);
    }
    const result = await onReload();
    const status = result.errors.length > 0 ? 500 : 200;
    return c.json({
      reloaded: result.reloaded,
      skipped: result.skipped,
      errors: result.errors,
      reloaded_at: new Date().toISOString(),
    }, status);
  });

  // =========================================================================
  // Logs
  // =========================================================================

  app.get('/logs', (c) => {
    const query = c.req.query();

    const filters: LogFilters = {};
    if (query['server']) filters.server = query['server'];
    if (query['tool']) filters.tool = query['tool'];
    if (query['status']) filters.status = query['status'] as RequestStatus;
    if (query['from']) filters.from = query['from'];
    if (query['to']) filters.to = query['to'];
    if (query['trace_id']) filters.trace_id = query['trace_id'];
    if (query['client_id']) filters.client_id = query['client_id'];

    const limitStr = query['limit'];
    const offsetStr = query['offset'];
    if (limitStr) {
      const parsed = parseInt(limitStr, 10);
      if (!isNaN(parsed) && parsed > 0) filters.limit = parsed;
    }
    if (offsetStr) {
      const parsed = parseInt(offsetStr, 10);
      if (!isNaN(parsed) && parsed >= 0) filters.offset = parsed;
    }

    const logs = logStore.getAll(filters);

    return c.json({
      count: logs.length,
      offset: filters.offset ?? 0,
      limit: filters.limit ?? 50,
      logs,
    });
  });

  app.get('/logs/trace/:traceId', (c) => {
    const traceId = c.req.param('traceId');
    const logs = logStore.getByTraceId(traceId);
    return c.json({ trace_id: traceId, count: logs.length, logs });
  });

  // =========================================================================
  // Statistiques
  // =========================================================================

  app.get('/stats', (c) => {
    const stats = logStore.getStats();
    const cacheStats = cacheStore.getStats();

    return c.json({
      requests: stats,
      cache: cacheStats,
      inflight: inflightTracker.size,
      servers: config.servers.map((s) => s.id),
    });
  });

  app.get('/stats/server/:id', (c) => {
    const serverId = c.req.param('id');
    const serverInfo = registry.getServerInfo(serverId);

    if (!serverInfo) {
      return c.json({ error: `Serveur introuvable : ${serverId}` }, 404);
    }

    const filters: LogFilters = { server: serverId, limit: 1000 };
    const recentLogs = logStore.getAll(filters);
    const totalRequests = recentLogs.length;
    const errors = recentLogs.filter((l) => l.status === 'error').length;
    const cacheHits = recentLogs.filter((l) => l.cache_status === 'HIT').length;

    return c.json({
      server_id: serverId,
      url: serverInfo.config.url,
      healthy: serverInfo.health.healthy,
      latency_ms: serverInfo.health.latencyMs,
      tools_count: serverInfo.tools.length,
      total_requests: totalRequests,
      error_rate: totalRequests > 0 ? errors / totalRequests : 0,
      cache_hit_rate: totalRequests > 0 ? cacheHits / totalRequests : 0,
    });
  });

  app.get('/stats/tool/:name', (c) => {
    const toolName = c.req.param('name');
    const filters: LogFilters = { tool: toolName, limit: 1000 };
    const logs = logStore.getAll(filters);
    const totalRequests = logs.length;
    const errors = logs.filter((l) => l.status === 'error').length;
    const cacheHits = logs.filter((l) => l.cache_status === 'HIT').length;
    const durations = logs.map((l) => l.duration_ms).filter((d) => d > 0);
    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

    return c.json({
      tool_name: toolName,
      total_requests: totalRequests,
      error_rate: totalRequests > 0 ? errors / totalRequests : 0,
      cache_hit_rate: totalRequests > 0 ? cacheHits / totalRequests : 0,
      avg_duration_ms: avgDuration,
    });
  });

  app.get('/stats/client/:id', (c) => {
    const clientId = c.req.param('id');
    const filters: LogFilters = { client_id: clientId, limit: 1000 };
    const logs = logStore.getAll(filters);
    const totalRequests = logs.length;
    const errors = logs.filter((l) => l.status === 'error').length;

    return c.json({
      client_id: clientId,
      total_requests: totalRequests,
      error_rate: totalRequests > 0 ? errors / totalRequests : 0,
    });
  });

  // =========================================================================
  // Cache
  // =========================================================================

  app.get('/cache/stats', (c) => {
    const l1Stats = cacheStore.getStats();
    const l2Stats = l2Cache?.getStats() ?? null;
    return c.json({ l1: l1Stats, ...(l2Stats ? { l2: l2Stats } : {}) });
  });

  app.delete('/cache/l2/flush', async (c) => {
    if (!l2Cache) {
      return c.json({ flushed: false, reason: 'L2 cache not configured' });
    }
    const count = await l2Cache.flush();
    return c.json({ flushed: true, deleted_count: count, flushed_at: new Date().toISOString() });
  });

  app.delete('/cache/server/:id', (c) => {
    const serverId = c.req.param('id');
    const count = cacheStore.deleteByServer(serverId);
    metrics.updateCacheEntries(cacheStore.size);
    return c.json({ server_id: serverId, deleted_count: count });
  });

  app.delete('/cache/key/:key', (c) => {
    const key = c.req.param('key');
    const deleted = cacheStore.delete(key);
    return c.json({ deleted, key });
  });

  // =========================================================================
  // Métriques Prometheus
  // =========================================================================

  app.get('/metrics', async (c) => {
    try {
      const metricsText = await metrics.getMetrics();
      return c.text(metricsText, 200, {
        'Content-Type': 'text/plain; version=0.0.4',
      });
    } catch {
      return c.json({ error: 'Erreur lors de la collecte des métriques' }, 500);
    }
  });

  // =========================================================================
  // Serveurs backends
  // =========================================================================

  app.get('/servers', (c) => {
    // Replica/server URLs may carry embedded credentials when the operator
    // chose to encode auth as `https://user:pw@host`. Returning them verbatim
    // through an admin endpoint is a credential leak (cf. audit Sprint 3 #3).
    // redactUrl() preserves enough of the URL to be useful for debugging
    // while removing username/password.
    const servers = registry.getAllServers().map((s) => ({
      id: s.config.id,
      url: redactUrl(s.config.url),
      healthy: s.health.healthy,
      latency_ms: s.health.latencyMs,
      tools_count: s.tools.length,
      tools: s.tools.map((t) => t.name),
      replicas: s.replicas.map((r, idx) => ({
        index: idx,
        url: redactUrl(r.url),
        healthy: r.health.healthy,
        latency_ms: r.health.latencyMs,
        active_connections: r.client.activeConnections,
      })),
    }));

    return c.json({ servers });
  });

  app.post('/servers/:id/refresh', async (c) => {
    const serverId = c.req.param('id');
    const serverInfo = registry.getServerInfo(serverId);

    if (!serverInfo) {
      return c.json({ error: `Serveur introuvable : ${serverId}` }, 404);
    }

    await registry.refreshServer(serverId);

    const updated = registry.getServerInfo(serverId);
    return c.json({
      server_id: serverId,
      tools_count: updated?.tools.length ?? 0,
      refreshed_at: new Date().toISOString(),
    });
  });

  /**
   * POST /conduit/servers — Register a new server dynamically.
   * Body: ServerConfig JSON (id, url, transport?, command?, cache, etc.)
   */
  app.post('/servers', async (c) => {
    let body: ServerConfig;
    try {
      body = await c.req.json() as ServerConfig;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.id || typeof body.id !== 'string') {
      return c.json({ error: 'Missing or invalid "id" field' }, 400);
    }

    if (registry.getServerInfo(body.id)) {
      return c.json({ error: `Server "${body.id}" already exists` }, 409);
    }

    // SSRF prevention: validate server URL
    if (body.url && body.transport !== 'stdio') {
      const urlCheck = await validateServerUrlWithDns(body.url, allowPrivateNetworks);
      if (!urlCheck.valid) {
        return c.json({ error: `Invalid server URL: ${urlCheck.error}` }, 400);
      }
    }

    // Ensure cache defaults
    if (!body.cache) {
      body.cache = { default_ttl: 0 };
    }

    try {
      const client = createMcpClient(body);
      await registry.addServer(body, client);
      config.servers.push(body);

      const info = registry.getServerInfo(body.id);
      return c.json({
        server_id: body.id,
        tools_count: info?.tools.length ?? 0,
        registered_at: new Date().toISOString(),
      }, 201);
    } catch (err) {
      return c.json({ error: `Failed to register server: ${String(err)}` }, 500);
    }
  });

  /**
   * DELETE /conduit/servers/:id — Unregister a server dynamically.
   */
  app.delete('/servers/:id', (c) => {
    const serverId = c.req.param('id');

    if (!registry.getServerInfo(serverId)) {
      return c.json({ error: `Serveur introuvable : ${serverId}` }, 404);
    }

    registry.removeServer(serverId);
    const idx = config.servers.findIndex((s) => s.id === serverId);
    if (idx !== -1) config.servers.splice(idx, 1);

    return c.json({
      server_id: serverId,
      removed: true,
      removed_at: new Date().toISOString(),
    });
  });

  app.get('/dedup/inflight', (c) => {
    const snapshot = inflightTracker.getInflightSnapshot();
    return c.json({ count: snapshot.length, inflight: snapshot });
  });

  // =========================================================================
  // ACL — Phase 2
  // =========================================================================

  /**
   * GET /conduit/acl/check?client=X&server=Y&tool=Z
   * Teste une politique ACL sans effectuer d'appel réel.
   */
  app.get('/acl/check', (c) => {
    const query = c.req.query();
    const client = query['client'] ?? '';
    const server = query['server'] ?? '';
    const tool = query['tool'] ?? '';

    if (!client || !server || !tool) {
      return c.json({ error: 'Paramètres requis : client, server, tool' }, 400);
    }

    if (!config.acl?.enabled) {
      return c.json({
        allowed: true,
        policy: '',
        reason: 'ACL désactivé',
      });
    }

    const decision = evaluateAcl(
      client,
      server,
      tool,
      config.acl.policies,
      config.acl.default_action,
    );

    return c.json({
      allowed: decision.allowed,
      policy: decision.policy_name,
      reason: decision.reason,
    });
  });

  // =========================================================================
  // Guardrails IA
  // =========================================================================

  /**
   * GET /conduit/guardrails/rules — Liste toutes les règles guardrails configurées
   */
  app.get('/guardrails/rules', (c) => {
    applySecurityHeaders(c);
    if (!config.guardrails?.enabled) {
      return c.json({ enabled: false, rules: [] });
    }
    return c.json({
      enabled: true,
      default_action: config.guardrails.default_action,
      rules: config.guardrails.rules,
    });
  });

  /**
   * GET /conduit/guardrails/check?client=X&server=Y&tool=Z&args={}
   * Teste un appel d'outil contre les guardrails sans effectuer l'appel réel.
   */
  app.get('/guardrails/check', (c) => {
    applySecurityHeaders(c);
    const query = c.req.query();
    const client = query['client'] ?? '';
    const server = query['server'] ?? '';
    const tool = query['tool'] ?? '';
    const argsStr = query['args'] ?? '{}';

    if (!client || !server || !tool) {
      return c.json({ error: 'Paramètres requis : client, server, tool' }, 400);
    }

    if (!config.guardrails?.enabled) {
      return c.json({ action: 'allow', rule_name: '', reason: 'Guardrails désactivés' });
    }

    let args: Record<string, unknown>;
    try { args = JSON.parse(argsStr); } catch { args = {}; }

    const decision = evaluateGuardrails(
      { clientId: client, serverId: server, toolName: tool, toolArgs: args },
      config.guardrails,
    );

    return c.json(decision);
  });

  /**
   * GET /conduit/guardrails/stats — Statistiques des actions guardrails depuis les logs
   */
  app.get('/guardrails/stats', (c) => {
    applySecurityHeaders(c);
    const logs = logStore.getAll({ limit: 10000 });
    const guardrailLogs = logs.filter((l) => l.guardrail_rule);

    const byRule: Record<string, { blocks: number; alerts: number }> = {};
    for (const log of guardrailLogs) {
      const rule = log.guardrail_rule!;
      if (!byRule[rule]) byRule[rule] = { blocks: 0, alerts: 0 };
      if (log.guardrail_action === 'block') byRule[rule]!.blocks++;
      if (log.guardrail_action === 'alert') byRule[rule]!.alerts++;
    }

    return c.json({
      total_actions: guardrailLogs.length,
      total_blocks: guardrailLogs.filter((l) => l.guardrail_action === 'block').length,
      total_alerts: guardrailLogs.filter((l) => l.guardrail_action === 'alert').length,
      by_rule: byRule,
    });
  });

  // =========================================================================
  // Rate Limits — Phase 3
  // =========================================================================

  /**
   * GET /conduit/limits — Tous les buckets de rate limit avec utilisation actuelle
   */
  app.get('/limits', (c) => {
    if (!rateLimiter) {
      return c.json({ enabled: false, buckets: [] });
    }

    const buckets = rateLimiter.getAllBuckets();
    return c.json({ enabled: true, buckets });
  });

  /**
   * GET /conduit/limits/client/:id — Quota détaillé pour un client spécifique
   */
  app.get('/limits/client/:id', async (c) => {
    const clientId = c.req.param('id');

    if (!rateLimiter) {
      return c.json({ client_id: clientId, enabled: false, limits: [] });
    }

    const quota = await rateLimiter.getClientQuota(clientId);
    return c.json({ client_id: clientId, enabled: true, ...quota });
  });

  /**
   * DELETE /conduit/limits/reset — Remet à zéro tous les compteurs
   */
  app.delete('/limits/reset', (c) => {
    if (!rateLimiter) {
      return c.json({ reset: false, reason: 'Rate limiting désactivé' });
    }

    rateLimiter.resetAll();
    return c.json({ reset: true, reset_at: new Date().toISOString() });
  });

  /**
   * DELETE /conduit/limits/client/:id/reset — Remet à zéro les compteurs d'un client
   */
  app.delete('/limits/client/:id/reset', (c) => {
    const clientId = c.req.param('id');

    if (!rateLimiter) {
      return c.json({ reset: false, reason: 'Rate limiting désactivé' });
    }

    rateLimiter.resetClient(clientId);
    return c.json({ reset: true, client_id: clientId, reset_at: new Date().toISOString() });
  });

  // =========================================================================
  // Circuit Breakers — Feature 3
  // =========================================================================

  /**
   * GET /conduit/circuits — State of all circuit breakers
   */
  app.get('/circuits', (c) => {
    const states = registry.getCircuitBreakerStates();
    return c.json({
      count: states.length,
      circuits: states,
    });
  });

  /**
   * POST /conduit/circuits/:serverId/reset — Force reset all circuit breakers for a server
   */
  app.post('/circuits/:serverId/reset', (c) => {
    const serverId = c.req.param('serverId');
    const serverInfo = registry.getServerInfo(serverId);

    if (!serverInfo) {
      return c.json({ error: `Serveur introuvable : ${serverId}` }, 404);
    }

    const reset = registry.resetCircuitBreaker(serverId);
    return c.json({
      server_id: serverId,
      reset,
      reset_at: new Date().toISOString(),
    });
  });

  // =========================================================================
  // Service Discovery — HTTP Registration
  // =========================================================================

  if (httpDiscovery) {
    const _httpDiscovery = httpDiscovery;

    /**
     * POST /conduit/discover/register — Self-registration endpoint.
     * MCP servers call this periodically as a heartbeat.
     */
    app.post('/discover/register', async (c) => {
      let body: DiscoveredServer;
      try {
        body = await c.req.json() as DiscoveredServer;
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }

      if (!body.id || !body.url) {
        return c.json({ error: 'Missing required fields: id, url' }, 400);
      }

      // SSRF prevention
      const urlCheck = await validateServerUrlWithDns(body.url, allowPrivateNetworks);
      if (!urlCheck.valid) {
        return c.json({ error: `Invalid URL: ${urlCheck.error}` }, 400);
      }

      // Limit max registrations to prevent memory DoS
      if (_httpDiscovery.size >= 1000) {
        return c.json({ error: 'Maximum registration limit (1000) reached' }, 429);
      }

      _httpDiscovery.register(body);
      return c.json({ registered: true, server_id: body.id });
    });

    /**
     * DELETE /conduit/discover/deregister/:id — Manual deregistration.
     */
    app.delete('/discover/deregister/:id', (c) => {
      const serverId = c.req.param('id');
      const removed = _httpDiscovery.deregister(serverId);
      return c.json({ deregistered: removed, server_id: serverId });
    });

    /**
     * GET /conduit/discover/status — Current discovery registrations.
     */
    app.get('/discover/status', async (c) => {
      const servers = await _httpDiscovery.poll();
      return c.json({ count: servers.length, servers });
    });
  }

  // =========================================================================
  // Dashboard SPA — Phase 6
  // =========================================================================

  /**
   * GET /conduit/dashboard — serve the dashboard SPA shell.
   * No authentication required — the HTML itself is static and carries no
   * secrets. The browser asks for the admin key only when the admin API
   * actually returns 401, and the key stays in memory for the current tab.
   */
  app.get('/dashboard', (c) => {
    c.header('Content-Security-Policy', dashboardCsp);
    return c.html(dashboardHtml);
  });

  /** Catch-all so client-side navigation within the SPA always gets the shell */
  app.get('/dashboard/*', (c) => {
    c.header('Content-Security-Policy', dashboardCsp);
    return c.html(dashboardHtml);
  });

  /**
   * POST /conduit/circuits/:serverId/replicas/:replicaIdx/reset — Reset a specific replica's circuit
   */
  app.post('/circuits/:serverId/replicas/:replicaIdx/reset', (c) => {
    const serverId = c.req.param('serverId');
    const replicaIdx = parseInt(c.req.param('replicaIdx'), 10);

    if (isNaN(replicaIdx)) {
      return c.json({ error: 'Invalid replica index' }, 400);
    }

    const serverInfo = registry.getServerInfo(serverId);
    if (!serverInfo) {
      return c.json({ error: `Serveur introuvable : ${serverId}` }, 404);
    }

    const reset = registry.resetReplicaCircuitBreaker(serverId, replicaIdx);
    if (!reset) {
      return c.json({ error: `No circuit breaker for replica ${replicaIdx} of ${serverId}` }, 404);
    }

    return c.json({
      server_id: serverId,
      replica_index: replicaIdx,
      reset: true,
      reset_at: new Date().toISOString(),
    });
  });

  return app;
}

function normalizeStringMapBody(
  value: unknown,
  label: 'variables' | 'headers' | 'env',
): Partial<Record<typeof label, Record<string, string>>> {
  if (value === undefined) {
    return {};
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object of string values`);
  }

  const result = Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      if (typeof entryValue !== 'string') {
        throw new Error(`${label}.${key} must be a string`);
      }
      return [key, entryValue];
    }),
  );

  return { [label]: result } as Partial<Record<typeof label, Record<string, string>>>;
}
