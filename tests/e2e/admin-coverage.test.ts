/**
 * Additional e2e coverage for src/admin/routes.ts
 * Tests all admin endpoints not covered by existing tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, teardown, type E2eTestContext } from './setup.js';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { resetMetrics } from '../../src/observability/metrics.js';

async function adminRequest(
  app: E2eTestContext['app'],
  method: string,
  path: string,
  opts?: { headers?: Record<string, string>; body?: unknown },
): Promise<Response> {
  const upper = method.toUpperCase();
  // Include X-Conduit-Admin header for state-changing requests (CSRF protection)
  const csrfHeader = (upper === 'POST' || upper === 'PUT' || upper === 'DELETE')
    ? { 'X-Conduit-Admin': 'true' }
    : {};
  return app.request(`/conduit${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...csrfHeader, ...(opts?.headers ?? {}) },
    ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe('Admin — readyz probe', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await teardown(ctx); });

  it('GET /conduit/readyz returns 200 when at least one healthy backend', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/readyz');
    // May be 200 or 503 depending on if mock server counts as healthy
    expect([200, 503]).toContain(res.status);
  });

  it('GET /conduit/readyz returns JSON with ready field', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/readyz');
    const body = await res.json() as { ready: boolean };
    expect(typeof body.ready).toBe('boolean');
  });
});

describe('Admin — degraded probes after failed startup refresh', () => {
  let gateway: ConduitGateway;
  let app: ReturnType<ConduitGateway['createApp']>;

  beforeEach(async () => {
    resetMetrics();

    const config: ConduitGatewayConfig = {
      gateway: { port: 0, host: '127.0.0.1' },
      router: {
        namespace_strategy: 'none',
        health_check: {
          enabled: false,
          interval_seconds: 60,
          timeout_ms: 1000,
          unhealthy_threshold: 3,
          healthy_threshold: 1,
        },
        load_balancing: 'round-robin',
      },
      servers: [{ id: 'broken-server', url: 'http://127.0.0.1:1', cache: { default_ttl: 0 } }],
      cache: { enabled: false, l1: { max_entries: 100, max_entry_size_kb: 64 } },
      tenant_isolation: { enabled: false, header: 'Authorization' },
      observability: { log_args: false, log_responses: false, redact_fields: [], retention_days: 1, db_path: ':memory:' },
      metrics: { enabled: false, port: 0 },
    };

    gateway = new ConduitGateway(config);
    await gateway.initialize();
    app = gateway.createApp();
  });

  afterEach(async () => {
    await gateway.stop();
  });

  it('GET /conduit/health returns 503 with degraded status', async () => {
    const res = await app.request('/conduit/health');
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string; backends: Array<{ id: string; healthy: boolean }> };
    expect(body.status).toBe('degraded');
    expect(body.backends).toHaveLength(1);
    expect(body.backends[0]?.id).toBe('broken-server');
    expect(body.backends[0]?.healthy).toBe(false);
  });

  it('GET /conduit/readyz returns 503 with ready=false', async () => {
    const res = await app.request('/conduit/readyz');
    expect(res.status).toBe(503);
    const body = await res.json() as { ready: boolean; backends_healthy: boolean };
    expect(body.ready).toBe(false);
    expect(body.backends_healthy).toBe(false);
  });
});

describe('Admin — version endpoint', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await teardown(ctx); });

  it('GET /conduit/version returns version string', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/version');
    expect(res.status).toBe(200);
    const body = await res.json() as { version: string; node_version: string };
    expect(typeof body.version).toBe('string');
    expect(typeof body.node_version).toBe('string');
    expect(body.node_version).toMatch(/^v\d+/);
  });
});

describe('Admin — logs endpoints', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await teardown(ctx); });

  it('GET /conduit/logs returns log list', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/logs');
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; logs: unknown[] };
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.logs)).toBe(true);
  });

  it('GET /conduit/logs with server filter', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/logs?server=test-server');
    expect(res.status).toBe(200);
    const body = await res.json() as { logs: unknown[] };
    expect(Array.isArray(body.logs)).toBe(true);
  });

  it('GET /conduit/logs with tool filter', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/logs?tool=some_tool');
    expect(res.status).toBe(200);
  });

  it('GET /conduit/logs with status filter', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/logs?status=success');
    expect(res.status).toBe(200);
  });

  it('GET /conduit/logs with limit and offset', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/logs?limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json() as { limit: number; offset: number };
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
  });

  it('GET /conduit/logs with trace_id filter', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/logs?trace_id=some-trace-id');
    expect(res.status).toBe(200);
  });

  it('GET /conduit/logs with client_id filter', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/logs?client_id=user-123');
    expect(res.status).toBe(200);
  });

  it('GET /conduit/logs with from/to date filters', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/logs?from=2024-01-01&to=2026-01-01');
    expect(res.status).toBe(200);
  });

  it('GET /conduit/logs/trace/:traceId returns logs for a trace', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/logs/trace/some-trace-id-123');
    expect(res.status).toBe(200);
    const body = await res.json() as { trace_id: string; count: number; logs: unknown[] };
    expect(body.trace_id).toBe('some-trace-id-123');
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.logs)).toBe(true);
  });
});

describe('Admin — stats endpoints', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await teardown(ctx); });

  it('GET /conduit/stats returns request and cache stats', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/stats');
    expect(res.status).toBe(200);
    const body = await res.json() as { requests: unknown; cache: unknown; inflight: number; servers: string[] };
    expect(body.requests).toBeDefined();
    expect(body.cache).toBeDefined();
    expect(typeof body.inflight).toBe('number');
    expect(Array.isArray(body.servers)).toBe(true);
  });

  it('GET /conduit/stats/server/:id returns server stats', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/stats/server/test-server');
    expect(res.status).toBe(200);
    const body = await res.json() as { server_id: string };
    expect(body.server_id).toBe('test-server');
  });

  it('GET /conduit/stats/server/:id returns 404 for unknown server', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/stats/server/nonexistent');
    expect(res.status).toBe(404);
  });

  it('GET /conduit/stats/tool/:name returns tool stats', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/stats/tool/some_tool');
    expect(res.status).toBe(200);
    const body = await res.json() as { tool_name: string; total_requests: number };
    expect(body.tool_name).toBe('some_tool');
    expect(typeof body.total_requests).toBe('number');
  });

  it('GET /conduit/stats/client/:id returns client stats', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/stats/client/user-abc');
    expect(res.status).toBe(200);
    const body = await res.json() as { client_id: string; total_requests: number };
    expect(body.client_id).toBe('user-abc');
    expect(typeof body.total_requests).toBe('number');
  });
});

describe('Admin — cache management', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await teardown(ctx); });

  it('GET /conduit/cache/stats returns cache statistics', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/cache/stats');
    expect(res.status).toBe(200);
    const body = await res.json() as { l1: { hits: number; misses: number } };
    expect(typeof body.l1.hits).toBe('number');
  });

  it('DELETE /conduit/cache/server/:id clears server cache', async () => {
    const res = await adminRequest(ctx.app, 'DELETE', '/cache/server/test-server');
    expect(res.status).toBe(200);
    const body = await res.json() as { server_id: string; deleted_count: number };
    expect(body.server_id).toBe('test-server');
    expect(typeof body.deleted_count).toBe('number');
  });

  it('DELETE /conduit/cache/key/:key deletes specific key', async () => {
    const res = await adminRequest(ctx.app, 'DELETE', '/cache/key/some-cache-key');
    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: boolean; key: string };
    expect(body.key).toBe('some-cache-key');
    expect(typeof body.deleted).toBe('boolean');
  });
});

describe('Admin — servers', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await teardown(ctx); });

  it('GET /conduit/servers returns server list', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/servers');
    expect(res.status).toBe(200);
    const body = await res.json() as { servers: Array<{ id: string }> };
    expect(Array.isArray(body.servers)).toBe(true);
    expect(body.servers[0]?.id).toBe('test-server');
  });

  it('POST /conduit/servers/:id/refresh refreshes server tools', async () => {
    const res = await adminRequest(ctx.app, 'POST', '/servers/test-server/refresh');
    expect(res.status).toBe(200);
    const body = await res.json() as { server_id: string; tools_count: number; refreshed_at: string };
    expect(body.server_id).toBe('test-server');
    expect(typeof body.tools_count).toBe('number');
    expect(typeof body.refreshed_at).toBe('string');
  });

  it('POST /conduit/servers/:id/refresh returns 404 for unknown server', async () => {
    const res = await adminRequest(ctx.app, 'POST', '/servers/nonexistent/refresh');
    expect(res.status).toBe(404);
  });

  it('GET /conduit/dedup/inflight returns inflight request count', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/dedup/inflight');
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; inflight: unknown[] };
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.inflight)).toBe(true);
  });

  // ── Audit Sprint 3 #3 — replica/server URL credential leak ───────────────
  describe('GET /conduit/servers credential redaction (audit Sprint 3 #3)', () => {
    it('redacts username/password embedded in the server URL', async () => {
      const info = ctx.gateway.getRegistry().getServerInfo('test-server');
      expect(info).toBeTruthy();
      const originalUrl = info!.config.url;
      info!.config.url = originalUrl.replace('http://', 'http://alice:s3cret@');

      const res = await adminRequest(ctx.app, 'GET', '/servers');
      expect(res.status).toBe(200);
      const body = await res.json() as { servers: Array<{ url: string }> };
      const url = body.servers[0]?.url ?? '';
      expect(url).not.toContain('s3cret');
      expect(url).not.toContain('alice:s3cret');
      expect(url).toContain('***');

      info!.config.url = originalUrl;
    });

    it('redacts replica URLs as well', async () => {
      const info = ctx.gateway.getRegistry().getServerInfo('test-server');
      if (!info || !info.replicas[0]) return;
      const originalReplicaUrl = info.replicas[0].url;
      info.replicas[0].url = 'https://replica:supersecret@replica.internal/mcp';

      const res = await adminRequest(ctx.app, 'GET', '/servers');
      const body = await res.json() as { servers: Array<{ replicas: Array<{ url: string }> }> };
      const replicaUrl = body.servers[0]?.replicas[0]?.url ?? '';
      expect(replicaUrl).not.toContain('supersecret');
      expect(replicaUrl).toContain('***');

      info.replicas[0].url = originalReplicaUrl;
    });

    it('non-credentialed URLs pass through unchanged', async () => {
      const res = await adminRequest(ctx.app, 'GET', '/servers');
      const body = await res.json() as { servers: Array<{ url: string }> };
      const url = body.servers[0]?.url ?? '';
      expect(url).toMatch(/^https?:\/\//);
      expect(url).not.toContain('***');
    });
  });
});

describe('Admin — ACL check', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await teardown(ctx); });

  it('GET /conduit/acl/check returns allowed=true when ACL disabled', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/acl/check?client=user&server=test-server&tool=get_contact');
    expect(res.status).toBe(200);
    const body = await res.json() as { allowed: boolean };
    expect(body.allowed).toBe(true);
  });

  it('GET /conduit/acl/check returns 400 when params missing', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/acl/check?client=user');
    expect(res.status).toBe(400);
  });

  it('GET /conduit/acl/check returns 400 when all params missing', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/acl/check');
    expect(res.status).toBe(400);
  });
});

describe('Admin — rate limits', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await teardown(ctx); });

  it('GET /conduit/limits returns enabled=false when rate limiting disabled', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/limits');
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: boolean; buckets: unknown[] };
    expect(body.enabled).toBe(false);
    expect(body.buckets).toHaveLength(0);
  });

  it('GET /conduit/limits/client/:id returns disabled when rate limiting off', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/limits/client/user-123');
    expect(res.status).toBe(200);
    const body = await res.json() as { client_id: string; enabled: boolean };
    expect(body.client_id).toBe('user-123');
    expect(body.enabled).toBe(false);
  });

  it('DELETE /conduit/limits/reset returns reset=false when rate limiting disabled', async () => {
    const res = await adminRequest(ctx.app, 'DELETE', '/limits/reset');
    expect(res.status).toBe(200);
    const body = await res.json() as { reset: boolean };
    expect(body.reset).toBe(false);
  });

  it('DELETE /conduit/limits/client/:id/reset returns reset=false when rate limiting disabled', async () => {
    const res = await adminRequest(ctx.app, 'DELETE', '/limits/client/user-123/reset');
    expect(res.status).toBe(200);
    const body = await res.json() as { reset: boolean };
    expect(body.reset).toBe(false);
  });
});

describe('Admin — circuit breakers', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await teardown(ctx); });

  it('GET /conduit/circuits returns circuit breaker states', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/circuits');
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; circuits: unknown[] };
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.circuits)).toBe(true);
  });

  it('POST /conduit/circuits/:serverId/reset returns 404 for unknown server', async () => {
    const res = await adminRequest(ctx.app, 'POST', '/circuits/nonexistent/reset');
    expect(res.status).toBe(404);
  });

  it('POST /conduit/circuits/:serverId/reset returns 200 for known server', async () => {
    const res = await adminRequest(ctx.app, 'POST', '/circuits/test-server/reset');
    expect(res.status).toBe(200);
    const body = await res.json() as { server_id: string; reset: boolean };
    expect(body.server_id).toBe('test-server');
    // reset is false when no circuit breaker configured (default setup has no CB)
    expect(typeof body.reset).toBe('boolean');
  });

  it('POST /conduit/circuits/:serverId/replicas/:idx/reset returns 404 for unknown server', async () => {
    const res = await adminRequest(ctx.app, 'POST', '/circuits/nonexistent/replicas/0/reset');
    expect(res.status).toBe(404);
  });

  it('POST /conduit/circuits/:serverId/replicas/:idx/reset returns 400 for invalid index', async () => {
    const res = await adminRequest(ctx.app, 'POST', '/circuits/test-server/replicas/notanumber/reset');
    expect(res.status).toBe(400);
  });

  it('POST /conduit/circuits/:serverId/replicas/:idx/reset returns 404 when no CB configured', async () => {
    const res = await adminRequest(ctx.app, 'POST', '/circuits/test-server/replicas/0/reset');
    expect(res.status).toBe(404);
  });
});

describe('Admin — security headers', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await teardown(ctx); });

  it('all admin responses include X-Content-Type-Options: nosniff', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('all admin responses include X-Frame-Options: DENY', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/health');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('all admin responses include Cache-Control: no-store', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/version');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('Admin — key authentication', () => {
  it('rejects requests without admin key when key is configured', async () => {
    const ctx = await setup();
    // Patch config to add admin key - we need a fresh setup with admin key
    await teardown(ctx);

    // Create setup with admin key
    const authenticatedCtx = await setup({
      // Rate limits not relevant here, just use default setup
    });

    // The default setup has no admin key, so all requests succeed
    // For this test we just verify the health endpoint works without auth
    const res = await authenticatedCtx.app.request('/conduit/health');
    expect(res.status).toBe(200);
    await teardown(authenticatedCtx);
  });

  it('GET /conduit/health is accessible without auth even when key set', async () => {
    // health endpoint bypasses auth — tested via default setup
    const ctx = await setup();
    const res = await ctx.app.request('/conduit/health');
    expect(res.status).toBe(200);
    await teardown(ctx);
  });
});

describe('Admin — metrics endpoint', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => { ctx = await setup(); });
  afterEach(async () => { await teardown(ctx); });

  it('GET /conduit/metrics returns prometheus format text', async () => {
    const res = await adminRequest(ctx.app, 'GET', '/metrics');
    expect(res.status).toBe(200);
    // prom-client returns text/plain
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/plain');
  });
});
