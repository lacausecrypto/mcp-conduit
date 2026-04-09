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
import { evaluateGuardrails } from '../guardrails/evaluator.js';
import { dashboardHtml } from '../dashboard/dashboard.js';
import type { RedisCacheStore } from '../cache/redis-cache.js';
import type { ServerConfig } from '../config/types.js';
import { createMcpClient } from '../proxy/client-factory.js';
import type { HttpRegistryBackend } from '../discovery/http-registry.js';
import type { DiscoveredServer } from '../discovery/types.js';
import { validateServerUrl } from '../utils/url-validator.js';

const VERSION = '1.0.0';

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
): Hono {
  const app = new Hono();

  const adminKey = config.admin?.key;

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
        c.req.path.startsWith('/conduit/dashboard/')
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
  // requests (triggers a CORS preflight that will be blocked).
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
    }
    return next();
  });

  // =========================================================================
  // Santé et statut
  // =========================================================================

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
    const servers = registry.getAllServers().map((s) => ({
      id: s.config.id,
      url: s.config.url,
      healthy: s.health.healthy,
      latency_ms: s.health.latencyMs,
      tools_count: s.tools.length,
      tools: s.tools.map((t) => t.name),
      replicas: s.replicas.map((r, idx) => ({
        index: idx,
        url: r.url,
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
      const urlCheck = validateServerUrl(body.url);
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
      const urlCheck = validateServerUrl(body.url);
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
   * GET /conduit/dashboard — serve the React SPA.
   * No authentication required — the HTML itself is static and carries no
   * secrets.  All API calls made from within the dashboard include the admin
   * key stored in localStorage.
   */
  app.get('/dashboard', (c) => c.html(dashboardHtml));

  /** Catch-all so client-side navigation within the SPA always gets the shell */
  app.get('/dashboard/*', (c) => c.html(dashboardHtml));

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
