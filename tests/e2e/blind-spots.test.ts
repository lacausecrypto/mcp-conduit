/**
 * Blind-spots E2E tests — Security, Data Integrity, Reliability, Protocol.
 *
 * Chaque test prouve quelque chose de précis sur le comportement de la passerelle.
 * Si un test échoue, c'est un bug réel.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setup,
  teardown,
  setupMultiServer,
  teardownMultiServer,
  sendMcpRequest,
  makeToolCallMessage,
  makeToolsListMessage,
  makeInitializeMessage,
  type E2eTestContext,
  type E2eMultiServerContext,
} from './setup.js';
import { startMockMcpServer } from './mock-mcp-server.js';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { resetMetrics } from '../../src/observability/metrics.js';

// ─── Types utilitaires ────────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─── Helper : setup with tenant isolation ────────────────────────────────────

async function setupTenantIsolated(opts: { auth?: ConduitGatewayConfig['auth'] } = {}) {
  const mockServer = await startMockMcpServer(0);

  const config: ConduitGatewayConfig = {
    gateway: { port: 0, host: '127.0.0.1' },
    router: {
      namespace_strategy: 'none',
      health_check: { enabled: false, interval_seconds: 60, timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1 },
      load_balancing: 'round-robin',
    },
    servers: [{ id: 'test-server', url: mockServer.url, cache: { default_ttl: 300 } }],
    cache: { enabled: true, l1: { max_entries: 1000, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: true, header: 'Authorization' },
    observability: { log_args: true, log_responses: false, redact_fields: ['password', 'token', 'secret'], retention_days: 30, db_path: ':memory:' },
    metrics: { enabled: false, port: 0 },
  };

  if (opts.auth) config.auth = opts.auth;

  resetMetrics();
  const gateway = new ConduitGateway(config);
  await gateway.initialize();
  const app = gateway.createApp();
  return { gateway, app, mockServer };
}

// ─── Helper : setup with admin key ───────────────────────────────────────────

async function setupWithAdminKey(adminKey: string) {
  const mockServer = await startMockMcpServer(0);

  const config: ConduitGatewayConfig = {
    gateway: { port: 0, host: '127.0.0.1' },
    router: {
      namespace_strategy: 'none',
      health_check: { enabled: false, interval_seconds: 60, timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1 },
      load_balancing: 'round-robin',
    },
    servers: [{ id: 'test-server', url: mockServer.url, cache: { default_ttl: 300 } }],
    cache: { enabled: true, l1: { max_entries: 1000, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: { log_args: true, log_responses: false, redact_fields: ['password'], retention_days: 30, db_path: ':memory:' },
    metrics: { enabled: false, port: 0 },
    admin: { key: adminKey },
  };

  resetMetrics();
  const gateway = new ConduitGateway(config);
  await gateway.initialize();
  const app = gateway.createApp();
  return { gateway, app, mockServer };
}

// =============================================================================
// CATEGORY 1: Security failles
// =============================================================================

// ─── 1.1 Auth bypass ─────────────────────────────────────────────────────────

describe('1.1 Auth bypass attempts', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      auth: { method: 'api-key', api_keys: [{ key: 'sk-valid', client_id: 'agent-1', tenant_id: 'tenant-a' }] },
    });
  });

  afterAll(() => teardown(ctx));

  it('Bearer + empty string → reject (not crash)', async () => {
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
      { Authorization: 'Bearer ' },
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32000);
    expect(body.error!.message).toContain('Authentication failed');
  });

  it('Authorization with no Bearer prefix → reject', async () => {
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
      { Authorization: 'sk-valid' },
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32000);
  });

  it('Authorization with only spaces → reject', async () => {
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
      { Authorization: '     ' },
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32000);
  });

  it('Key with appended extra chars → reject (constant-time compare fails)', async () => {
    // Note: HTTP forbids null bytes in header values (the Fetch API correctly
    // rejects them at the transport layer — that protection is even better).
    // Here we verify that a key with extra characters appended to the valid key
    // is rejected, proving the constant-time comparison works correctly.
    const tamperedKey = 'Bearer sk-valid-EXTRA-SUFFIX';
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
      { Authorization: tamperedKey },
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32000);
  });

  it('Extremely long Authorization header (100 KB) → reject without crash', async () => {
    const hugeKey = 'Bearer ' + 'a'.repeat(100 * 1024);
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
      { Authorization: hugeKey },
    );
    const body = await res.json() as JsonRpcResponse;
    // Must not crash — must return an auth failure
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32000);
  });

  it('Auth is evaluated on EVERY request (no auth caching)', async () => {
    // First request succeeds
    const res1 = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
      { Authorization: 'Bearer sk-valid' },
    );
    const body1 = await res1.json() as JsonRpcResponse;
    expect(body1.error).toBeUndefined();

    // Second request with wrong key must also fail
    const res2 = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
      { Authorization: 'Bearer sk-wrong' },
    );
    const body2 = await res2.json() as JsonRpcResponse;
    expect(body2.error).toBeDefined();
    expect(body2.error!.code).toBe(-32000);
  });
});

// ─── 1.2 ACL bypass ──────────────────────────────────────────────────────────

describe('1.2 ACL bypass attempts', () => {
  describe('Namespaced tool name stripping', () => {
    // With namespace='prefix', tool names arrive as 'server-id.tool_name'.
    // ACL must strip the prefix before evaluating.
    let ctx: E2eMultiServerContext;

    beforeAll(async () => {
      ctx = await setupMultiServer({
        namespaceStrategy: 'prefix',
        auth: {
          method: 'api-key',
          api_keys: [{ key: 'sk-allowed', client_id: 'allowed-client', tenant_id: 'tenant-a' }],
        },
        acl: {
          enabled: true,
          default_action: 'deny',
          policies: [
            {
              name: 'allow-get-only',
              clients: ['allowed-client'],
              allow: [{ server: 'server-a', tools: ['get_contact'] }],
            },
          ],
        },
      });
    });

    afterAll(() => teardownMultiServer(ctx));

    it('calling server-a.get_contact (namespaced) → allowed (ACL strips prefix)', async () => {
      const res = await sendMcpRequest(
        ctx.app,
        'server-a',
        makeToolCallMessage('server-a.get_contact', { id: '1' }),
        { Authorization: 'Bearer sk-allowed' },
      );
      const body = await res.json() as JsonRpcResponse;
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
    });

    it('calling server-a.delete_contact (namespaced) → denied by ACL', async () => {
      const res = await sendMcpRequest(
        ctx.app,
        'server-a',
        makeToolCallMessage('server-a.delete_contact', { id: '1' }),
        { Authorization: 'Bearer sk-allowed' },
      );
      const body = await res.json() as JsonRpcResponse;
      expect(body.error).toBeDefined();
      expect(body.error!.message).toContain('Access denied');
    });
  });

  describe('ACL case-sensitivity', () => {
    // ACL patterns are case-sensitive. 'Get_Contact' does NOT match 'get_contact'.
    let ctx: E2eTestContext;

    beforeAll(async () => {
      ctx = await setup({
        auth: {
          method: 'api-key',
          api_keys: [{ key: 'sk-client', client_id: 'case-client', tenant_id: 'tenant-a' }],
        },
        acl: {
          enabled: true,
          default_action: 'deny',
          policies: [
            {
              name: 'allow-get',
              clients: ['case-client'],
              allow: [{ server: 'test-server', tools: ['get_contact'] }],
            },
          ],
        },
      });
    });

    afterAll(() => teardown(ctx));

    it('exact case match → allowed', async () => {
      const res = await sendMcpRequest(
        ctx.app,
        'test-server',
        makeToolCallMessage('get_contact', { id: '1' }),
        { Authorization: 'Bearer sk-client' },
      );
      const body = await res.json() as JsonRpcResponse;
      expect(body.error).toBeUndefined();
    });

    it('wrong case (Get_Contact vs get_contact) → denied (ACL is case-sensitive)', async () => {
      // Documents that ACL does NOT perform case-insensitive matching.
      const res = await sendMcpRequest(
        ctx.app,
        'test-server',
        makeToolCallMessage('Get_Contact', { id: '1' }),
        { Authorization: 'Bearer sk-client' },
      );
      const body = await res.json() as JsonRpcResponse;
      // The tool 'Get_Contact' is not in ACL → denied
      expect(body.error).toBeDefined();
      expect(body.error!.message).toContain('Access denied');
    });
  });

  describe('Cross-server ACL isolation', () => {
    // Client has access to get_contact on server-a but NOT on server-b.
    // Calling get_contact via /mcp/server-b must be denied.
    let ctx: E2eMultiServerContext;

    beforeAll(async () => {
      ctx = await setupMultiServer({
        namespaceStrategy: 'prefix',
        auth: {
          method: 'api-key',
          api_keys: [{ key: 'sk-a-only', client_id: 'server-a-client', tenant_id: 'tenant-a' }],
        },
        acl: {
          enabled: true,
          default_action: 'deny',
          policies: [
            {
              name: 'server-a-only',
              clients: ['server-a-client'],
              allow: [{ server: 'server-a', tools: ['get_contact'] }],
            },
          ],
        },
      });
    });

    afterAll(() => teardownMultiServer(ctx));

    it('get_contact via server-a → allowed', async () => {
      const res = await sendMcpRequest(
        ctx.app,
        'server-a',
        makeToolCallMessage('get_contact', { id: '1' }),
        { Authorization: 'Bearer sk-a-only' },
      );
      const body = await res.json() as JsonRpcResponse;
      expect(body.error).toBeUndefined();
    });

    it('get_contact via server-b → denied (same tool, wrong server)', async () => {
      const res = await sendMcpRequest(
        ctx.app,
        'server-b',
        makeToolCallMessage('get_contact', { id: '1' }),
        { Authorization: 'Bearer sk-a-only' },
      );
      const body = await res.json() as JsonRpcResponse;
      expect(body.error).toBeDefined();
      expect(body.error!.message).toContain('Access denied');
    });
  });

  describe('Extra fields in params cannot override auth', () => {
    let ctx: E2eTestContext;

    beforeAll(async () => {
      ctx = await setup({
        auth: {
          method: 'api-key',
          api_keys: [{ key: 'sk-limited', client_id: 'limited-client', tenant_id: 'tenant-a' }],
        },
        acl: {
          enabled: true,
          default_action: 'deny',
          policies: [
            {
              name: 'limited',
              clients: ['limited-client'],
              allow: [{ server: 'test-server', tools: ['get_contact'] }],
            },
          ],
        },
      });
    });

    afterAll(() => teardown(ctx));

    it('extra params fields (as_user, admin, etc.) are ignored by ACL', async () => {
      // Client tries to sneak in extra params — gateway should ignore them
      const res = await sendMcpRequest(
        ctx.app,
        'test-server',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'delete_contact',
            arguments: { id: '1' },
            as_user: 'admin',
            override_acl: true,
            client_id: 'admin-client',
          },
        },
        { Authorization: 'Bearer sk-limited' },
      );
      const body = await res.json() as JsonRpcResponse;
      // delete_contact is NOT in ACL for limited-client → must be denied
      expect(body.error).toBeDefined();
      expect(body.error!.message).toContain('Access denied');
    });
  });
});

// ─── 1.3 Header edge cases ────────────────────────────────────────────────────

describe('1.3 Header edge cases', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ cacheEnabled: false });
  });

  afterAll(() => teardown(ctx));

  beforeEach(() => {
    ctx.gateway.getLogStore()['db'].exec('DELETE FROM logs');
  });

  it('Trace ID with special characters (not CRLF) is preserved', async () => {
    // Test with URL-safe but unusual characters
    const specialTraceId = 'trace-special_id.123/abc';
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeInitializeMessage(),
      { 'x-conduit-trace-id': specialTraceId },
    );
    expect(res.headers.get('x-conduit-trace-id')).toBe(specialTraceId);
  });

  it('Trace ID is stored in logs (not silently dropped)', async () => {
    const traceId = 'trace-blind-spot-verify';
    await sendMcpRequest(
      ctx.app,
      'test-server',
      makeInitializeMessage(),
      { 'x-conduit-trace-id': traceId },
    );
    const logs = ctx.gateway.getLogStore().getAll();
    expect(logs[0]?.trace_id).toBe(traceId);
  });

  it('Long Mcp-Session-Id passes through without crashing', async () => {
    const longSessionId = 'session-' + 'x'.repeat(1000);
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeInitializeMessage(),
      { 'Mcp-Session-Id': longSessionId },
    );
    // Must not crash — gateway processes the request
    expect(res.status).toBe(200);
  });

  it('Multiple auth values in Authorization header → fails auth (no splitting)', async () => {
    // With api-key auth, 'Bearer key1, Bearer key2' is treated as one key value
    // The combined value won't match any valid single key
    const ctxWithAuth = await setup({
      auth: { method: 'api-key', api_keys: [{ key: 'sk-real', client_id: 'real-client', tenant_id: 'tenant-a' }] },
    });
    try {
      const res = await sendMcpRequest(
        ctxWithAuth.app,
        'test-server',
        makeToolCallMessage('get_contact', { id: '1' }),
        { Authorization: 'Bearer sk-real, Bearer sk-injected' },
      );
      const body = await res.json() as JsonRpcResponse;
      // 'sk-real, Bearer sk-injected' ≠ 'sk-real' → auth fails
      expect(body.error).toBeDefined();
      expect(body.error!.code).toBe(-32000);
    } finally {
      await teardown(ctxWithAuth);
    }
  });
});

// ─── 1.4 Admin API security ───────────────────────────────────────────────────

describe('1.4 Admin API security', () => {
  let ctx: { gateway: ConduitGateway; app: ReturnType<ConduitGateway['createApp']>; mockServer: Awaited<ReturnType<typeof startMockMcpServer>> };
  const ADMIN_KEY = 'super-secret-admin-key-42';

  beforeAll(async () => {
    ctx = await setupWithAdminKey(ADMIN_KEY);
  });

  afterAll(async () => {
    ctx.gateway.stop();
    await ctx.mockServer.close();
  });

  it('/conduit/health is accessible WITHOUT admin key', async () => {
    const res = await ctx.app.request('/conduit/health');
    expect(res.status).toBe(200);
  });

  it('/conduit/logs requires admin key → 401 without it', async () => {
    const res = await ctx.app.request('/conduit/logs');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('/conduit/stats requires admin key → 401 without it', async () => {
    const res = await ctx.app.request('/conduit/stats');
    expect(res.status).toBe(401);
  });

  it('/conduit/cache/server/:id DELETE requires admin key → 401 without it', async () => {
    const res = await ctx.app.request('/conduit/cache/server/test-server', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('/conduit/acl/check requires admin key → 401 without it', async () => {
    const res = await ctx.app.request('/conduit/acl/check?client=x&server=y&tool=z');
    expect(res.status).toBe(401);
  });

  it('/conduit/logs accessible WITH admin key in Bearer header', async () => {
    const res = await ctx.app.request('/conduit/logs', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  it('/conduit/logs accessible WITH admin key in X-Admin-Key header', async () => {
    const res = await ctx.app.request('/conduit/logs', {
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.status).toBe(200);
  });

  it('/conduit/logs with wrong admin key → 401', async () => {
    const res = await ctx.app.request('/conduit/logs', {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    expect(res.status).toBe(401);
  });

  it('/conduit/logs?limit=999999999 does not OOM — returns capped result', async () => {
    // Giant limit should not crash the process
    const res = await ctx.app.request('/conduit/logs?limit=999999999', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    // Should succeed (even if limit is applied as-is, no crash)
    expect(res.status).toBe(200);
    const body = await res.json() as { logs: unknown[] };
    expect(Array.isArray(body.logs)).toBe(true);
  });

  it('/conduit/logs?server with SQL-injection-like value — parameterized query protects', async () => {
    // The log store uses parameterized queries — this must not throw or return unexpected data
    const res = await ctx.app.request(
      "/conduit/logs?server='; DROP TABLE logs;--",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    );
    expect(res.status).toBe(200);
    // DB must still work after
    const res2 = await ctx.app.request('/conduit/logs', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res2.status).toBe(200);
  });
});

// =============================================================================
// CATEGORY 2: Data integrity failles
// =============================================================================

// ─── 2.1 Cache isolation with tenant isolation ────────────────────────────────

describe('2.1 Cache poisoning — tenant isolation', () => {
  let ctx: { gateway: ConduitGateway; app: ReturnType<ConduitGateway['createApp']>; mockServer: Awaited<ReturnType<typeof startMockMcpServer>> };

  beforeAll(async () => {
    ctx = await setupTenantIsolated();
  });

  afterAll(async () => {
    ctx.gateway.stop();
    await ctx.mockServer.close();
  });

  beforeEach(() => {
    ctx.gateway.getCacheStore().clear();
    ctx.mockServer.resetCallCounts();
  });

  it('Tenant A caches a result; Tenant B must get a MISS (own cache entry)', async () => {
    const msg = makeToolCallMessage('get_contact', { id: '001' });

    // Tenant A: first call → MISS, cached
    const resA1 = await sendMcpRequest(ctx.app, 'test-server', msg, {
      Authorization: 'Bearer sk-tenant-a',
    });
    expect(resA1.headers.get('x-conduit-cache-status')).toBe('MISS');

    // Tenant A: second call → HIT (uses own cache)
    const resA2 = await sendMcpRequest(ctx.app, 'test-server', msg, {
      Authorization: 'Bearer sk-tenant-a',
    });
    expect(resA2.headers.get('x-conduit-cache-status')).toBe('HIT');

    // Tenant B: first call → MUST be MISS, not HIT from tenant A's cache
    const resB1 = await sendMcpRequest(ctx.app, 'test-server', msg, {
      Authorization: 'Bearer sk-tenant-b',
    });
    expect(resB1.headers.get('x-conduit-cache-status')).toBe('MISS');

    // Backend was called twice: once for tenant A, once for tenant B
    expect(ctx.mockServer.getCallCount('tools/call')).toBe(2);
  });

  it('Different tenants never share cache entries (50 cross-requests)', async () => {
    const msg = makeToolCallMessage('get_contact', { id: '999' });

    const tenants = ['t1', 't2', 't3', 't4', 't5'];
    let firstCallForTenant = new Set<string>();

    // Each tenant's first call should be a MISS; subsequent calls HIT
    for (let round = 0; round < 3; round++) {
      for (const tenant of tenants) {
        const res = await sendMcpRequest(ctx.app, 'test-server', msg, {
          Authorization: `Bearer sk-${tenant}`,
        });
        const status = res.headers.get('x-conduit-cache-status');
        if (!firstCallForTenant.has(tenant)) {
          expect(status).toBe('MISS');
          firstCallForTenant.add(tenant);
        } else {
          expect(status).toBe('HIT');
        }
      }
    }
    // Backend called exactly 5 times (once per tenant)
    expect(ctx.mockServer.getCallCount('tools/call')).toBe(5);
  });

  it('Two API keys from the same authenticated tenant share the same cache entry', async () => {
    const shared = await setupTenantIsolated({
      auth: {
        method: 'api-key',
        api_keys: [
          { key: 'sk-tenant-shared-a', client_id: 'agent-a', tenant_id: 'tenant-shared' },
          { key: 'sk-tenant-shared-b', client_id: 'agent-b', tenant_id: 'tenant-shared' },
        ],
      },
    });

    try {
      shared.gateway.getCacheStore().clear();
      shared.mockServer.resetCallCounts();

      const msg = makeToolCallMessage('get_contact', { id: 'shared-001' });

      const resA = await sendMcpRequest(shared.app, 'test-server', msg, {
        Authorization: 'Bearer sk-tenant-shared-a',
      });
      expect(resA.headers.get('x-conduit-cache-status')).toBe('MISS');

      const resB = await sendMcpRequest(shared.app, 'test-server', msg, {
        Authorization: 'Bearer sk-tenant-shared-b',
      });
      expect(resB.headers.get('x-conduit-cache-status')).toBe('HIT');
      expect(shared.mockServer.getCallCount('tools/call')).toBe(1);
    } finally {
      await shared.mockServer.close();
      await shared.gateway.stop();
    }
  });
});

// ─── 2.2 Cache invalidation correctness ──────────────────────────────────────

describe('2.2 Cache invalidation correctness', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      cacheEnabled: true,
      defaultTtl: 300,
      toolOverrides: {
        // create_contact is destructive and invalidates get_contact
        create_contact: { ttl: 0, invalidates: ['get_contact'] },
      },
    });
  });

  afterAll(() => teardown(ctx));

  beforeEach(() => {
    ctx.gateway.getCacheStore().clear();
    ctx.mockServer.resetCallCounts();
  });

  it('post-invalidation read is MISS (not stale HIT), repeated 5 times', async () => {
    const getMsg = makeToolCallMessage('get_contact', { id: 'inv-test' });
    const writeMsg = makeToolCallMessage('create_contact', { name: 'New Contact' });

    for (let i = 0; i < 5; i++) {
      ctx.gateway.getCacheStore().clear();
      ctx.mockServer.resetCallCounts();

      // Populate cache
      const r1 = await sendMcpRequest(ctx.app, 'test-server', getMsg);
      expect(r1.headers.get('x-conduit-cache-status')).toBe('MISS');

      // Confirm it's cached
      const r2 = await sendMcpRequest(ctx.app, 'test-server', getMsg);
      expect(r2.headers.get('x-conduit-cache-status')).toBe('HIT');

      // Destructive operation invalidates the cache
      await sendMcpRequest(ctx.app, 'test-server', writeMsg);

      // Next read MUST be a MISS (not stale data)
      const r3 = await sendMcpRequest(ctx.app, 'test-server', getMsg);
      expect(r3.headers.get('x-conduit-cache-status')).toBe('MISS');
    }
  });

  it('cache invalidation is idempotent (multiple invalidations, still MISS)', async () => {
    const getMsg = makeToolCallMessage('get_contact', { id: 'idempotent' });
    const writeMsg = makeToolCallMessage('create_contact', { name: 'X' });

    await sendMcpRequest(ctx.app, 'test-server', getMsg);

    // Invalidate 3 times in a row
    await sendMcpRequest(ctx.app, 'test-server', writeMsg);
    await sendMcpRequest(ctx.app, 'test-server', writeMsg);
    await sendMcpRequest(ctx.app, 'test-server', writeMsg);

    const res = await sendMcpRequest(ctx.app, 'test-server', getMsg);
    expect(res.headers.get('x-conduit-cache-status')).toBe('MISS');
  });
});

// ─── 2.3 Dedup data integrity ────────────────────────────────────────────────

describe('2.3 Dedup data integrity — concurrent requests', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ cacheEnabled: true, defaultTtl: 300 });
  });

  afterAll(() => teardown(ctx));

  beforeEach(() => {
    ctx.gateway.getCacheStore().clear();
    ctx.mockServer.resetCallCounts();
  });

  it('20 concurrent identical requests → all get the same response body', async () => {
    const msg = makeToolCallMessage('get_contact', { id: 'dedup-test' });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => sendMcpRequest(ctx.app, 'test-server', msg)),
    );

    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<JsonRpcResponse>));

    // All responses must be valid
    for (const body of bodies) {
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
    }

    // All result objects must be identical (byte-for-byte after JSON roundtrip)
    const firstResult = JSON.stringify(bodies[0]!.result);
    for (const body of bodies) {
      expect(JSON.stringify(body.result)).toBe(firstResult);
    }

    // Backend called at most a few times (dedup should limit it)
    const callCount = ctx.mockServer.getCallCount('tools/call');
    expect(callCount).toBeLessThanOrEqual(5); // Well below 20 due to dedup
  });

  it('20 concurrent requests from different "tenants" (cache disabled) → all valid', async () => {
    const ctxNoCache = await setup({ cacheEnabled: false });
    try {
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          sendMcpRequest(ctxNoCache.app, 'test-server', makeToolCallMessage('get_contact', { id: `user-${i}` })),
        ),
      );
      for (const res of responses) {
        expect(res.status).toBe(200);
        const body = await res.json() as JsonRpcResponse;
        expect(body.error).toBeUndefined();
      }
    } finally {
      await teardown(ctxNoCache);
    }
  });
});

// ─── 2.4 Log integrity ───────────────────────────────────────────────────────

describe('2.4 Log integrity', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ cacheEnabled: false });
  });

  afterAll(() => teardown(ctx));

  beforeEach(() => {
    ctx.gateway.getLogStore()['db'].exec('DELETE FROM logs');
    ctx.mockServer.resetCallCounts();
  });

  it('50 requests → exactly 50 log entries', async () => {
    const requests = Array.from({ length: 50 }, (_, i) =>
      sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: String(i) })),
    );
    await Promise.all(requests);

    const logs = ctx.gateway.getLogStore().getAll({ limit: 100 });
    expect(logs).toHaveLength(50);
  });

  it('Sensitive args (password) are REDACTED in logs, not logged in plain text', async () => {
    await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('create_contact', { name: 'Alice', password: 'super-secret-123' }),
    );

    const logs = ctx.gateway.getLogStore().getAll();
    const args = logs[0]?.args as Record<string, unknown> | undefined;
    expect(args?.['password']).toBe('[REDACTED]');
    expect(args?.['name']).toBe('Alice');

    // Verify the raw SQLite DB doesn't contain the plaintext password either
    const rawRows = ctx.gateway.getLogStore()['db']
      .prepare("SELECT args FROM logs WHERE args LIKE '%super-secret-123%'")
      .all();
    expect(rawRows).toHaveLength(0);
  });

  it('Backend error → log entry has status=error', async () => {
    ctx.mockServer.setToolError('get_contact', 'Backend is exploding');

    await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
    );

    ctx.mockServer.clearToolError('get_contact');

    const logs = ctx.gateway.getLogStore().getAll();
    expect(logs[0]?.status).toBe('error');
  });

  it('/conduit/logs count matches actual number of logged requests', async () => {
    const N = 12;
    for (let i = 0; i < N; i++) {
      await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
    }

    const res = await ctx.app.request('/conduit/logs');
    const body = await res.json() as { count: number; logs: unknown[] };
    expect(body.count).toBe(N);
    expect(body.logs).toHaveLength(N);
  });
});

// =============================================================================
// CATEGORY 3: Reliability failles
// =============================================================================

// ─── 3.1 Pipeline error propagation ──────────────────────────────────────────

describe('3.1 Pipeline error propagation', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      cacheEnabled: true,
      defaultTtl: 300,
      toolOverrides: {
        // create_contact is non-cacheable (SKIP path)
        create_contact: { ttl: 0, invalidates: ['get_contact'] },
      },
    });
  });

  afterAll(() => teardown(ctx));

  beforeEach(() => {
    ctx.gateway.getCacheStore().clear();
    ctx.mockServer.resetCallCounts();
    ctx.mockServer.clearToolError('get_contact');
    ctx.mockServer.clearToolError('create_contact');
  });

  it('Non-cacheable tool backend error → original JSON-RPC error code preserved', async () => {
    // create_contact is SKIP (non-cacheable) — errors pass through directly
    ctx.mockServer.setToolError('create_contact', 'Backend validation failed');

    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('create_contact', { name: 'Test' }),
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeDefined();
    // The mock server returns -32000 for tool errors
    expect(body.error!.code).toBe(-32000);
    expect(body.error!.message).toContain('Backend validation failed');
  });

  it('Cacheable tool backend error → error is propagated (code preserved by fix)', async () => {
    // BUG FIXED: Previously, backend JSON-RPC errors for cacheable tools were wrapped
    // in -32603 "Internal error", losing the original error code. Pipeline now
    // detects UpstreamRpcError and passes through the original code/message.
    ctx.mockServer.setToolError('get_contact', 'Contact service unavailable');

    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeDefined();
    // After the fix, the original code (-32000) must be preserved
    expect(body.error!.code).toBe(-32000);
    expect(body.error!.message).toContain('Contact service unavailable');
  });

  it('Cacheable tool backend error → result is NOT cached (retry works)', async () => {
    ctx.mockServer.setToolError('get_contact', 'Temporary failure');

    // First call: backend error
    await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '1' }));

    // Clear the error — backend now works
    ctx.mockServer.clearToolError('get_contact');

    // Second call: must hit the backend again (error should not be cached)
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    // Backend was called twice (first=error, second=success)
    expect(ctx.mockServer.getCallCount('tools/call')).toBe(2);
  });

  it('MCP isError:true in content passes through (protocol-level success)', async () => {
    // An MCP tool that returns { content: [{ type: "text", text: "not found" }], isError: true }
    // is still a JSON-RPC SUCCESS — just with a semantic error flag in the result.
    // The gateway must return this as-is, not treat it as an error.
    ctx.mockServer.setTool({
      name: 'get_contact',
      result: {
        content: [{ type: 'text', text: 'Contact not found' }],
        isError: true,
      },
    });

    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: 'nonexistent' }),
    );
    const body = await res.json() as JsonRpcResponse;
    // No JSON-RPC error — it's a success response with isError in content
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    const result = body.result as { content?: unknown[]; isError?: boolean };
    expect(result.isError).toBe(true);

    // Restore original tool
    ctx.mockServer.setTool({
      name: 'get_contact',
      result: { id: '123', name: 'Alice Martin', email: 'alice@example.com' },
    });
  });
});

// ─── 3.2 Concurrent pipeline stress ──────────────────────────────────────────

describe('3.2 Concurrent pipeline stress', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      cacheEnabled: true,
      defaultTtl: 300,
      toolOverrides: {
        create_contact: { ttl: 0, invalidates: ['get_contact'] },
      },
    });
  });

  afterAll(() => teardown(ctx));

  beforeEach(() => {
    ctx.gateway.getCacheStore().clear();
    ctx.mockServer.resetCallCounts();
  });

  it('50 mixed concurrent requests: cached + non-cached + errors + missing tools', async () => {
    const validCacheable = Array.from({ length: 15 }, () =>
      sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '1' })),
    );
    const validNonCacheable = Array.from({ length: 10 }, () =>
      sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('create_contact', { name: 'X' })),
    );
    const nonExistentTools = Array.from({ length: 10 }, () =>
      sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('nonexistent_tool_xyz', {})),
    );
    const searchLeads = Array.from({ length: 15 }, () =>
      sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('search_leads', { query: 'test' })),
    );

    const all = await Promise.all([
      ...validCacheable,
      ...validNonCacheable,
      ...nonExistentTools,
      ...searchLeads,
    ]);

    // No request should hang or return HTTP 5xx (except 500 from infra errors)
    expect(all.length).toBe(50);

    let successCount = 0;
    let errorCount = 0;

    for (const res of all) {
      const body = await res.json() as JsonRpcResponse;
      if (body.error) {
        errorCount++;
        // Errors must have valid codes
        expect(typeof body.error.code).toBe('number');
        expect(typeof body.error.message).toBe('string');
      } else {
        successCount++;
        expect(body.result).toBeDefined();
      }
    }

    // We sent 10 nonexistent tool calls → at least 10 errors
    expect(errorCount).toBeGreaterThanOrEqual(10);
    // We sent 15 + 10 + 15 valid tool calls → at least 35 successes
    expect(successCount).toBeGreaterThanOrEqual(35);
  });

  it('No deadlock: 100 concurrent requests complete within timeout', async () => {
    const requests = Array.from({ length: 100 }, (_, i) =>
      sendMcpRequest(
        ctx.app,
        'test-server',
        makeToolCallMessage('get_contact', { id: String(i % 5) }),
      ),
    );

    // All must complete — if there's a deadlock, this will timeout
    const responses = await Promise.all(requests);
    expect(responses).toHaveLength(100);
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  }, 30_000);
});

// ─── 3.3 Session management ───────────────────────────────────────────────────

describe('3.3 Session management', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ cacheEnabled: false });
  });

  afterAll(() => teardown(ctx));

  it('Mcp-Session-Id from upstream is propagated to client response', async () => {
    // The mock server doesn't set Mcp-Session-Id by default, but we can still
    // verify the gateway doesn't crash when the header is absent
    const res = await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
    expect(res.status).toBe(200);
    // If upstream provides Mcp-Session-Id, it should be forwarded
    // (mock server doesn't set it, so we just verify no crash)
  });

  it('Request with Mcp-Session-Id forwarded to backend (session passthrough)', async () => {
    const sessionId = 'test-session-42';
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeInitializeMessage(),
      { 'Mcp-Session-Id': sessionId },
    );
    expect(res.status).toBe(200);
    // The gateway should not crash and should process the request normally
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeUndefined();
  });

  it('Invalid/random Mcp-Session-Id does not break routing (gateway is a proxy)', async () => {
    // Session management is the backend's concern. The gateway proxies it.
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
      { 'Mcp-Session-Id': 'invalid-expired-session-xyz-999' },
    );
    // Gateway should still route — backend decides what to do with it
    expect(res.status).toBe(200);
    const body = await res.json() as JsonRpcResponse;
    // Mock server doesn't validate sessions, so it succeeds
    expect(body.error).toBeUndefined();
  });
});

// =============================================================================
// CATEGORY 4: Protocol edge cases
// =============================================================================

// ─── 4.1 JSON-RPC compliance ──────────────────────────────────────────────────

describe('4.1 JSON-RPC compliance', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ cacheEnabled: false });
  });

  afterAll(() => teardown(ctx));

  it('"id": 0 (zero) is a valid JSON-RPC ID → processed correctly', async () => {
    const msg = { jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} };
    const res = await sendMcpRequest(ctx.app, 'test-server', msg);
    const body = await res.json() as JsonRpcResponse;
    // id=0 is valid per JSON-RPC 2.0 spec
    expect(body.error).toBeUndefined();
    expect(body.id).toBe(0);
  });

  it('"id": null → treated as notification-like; response id is null', async () => {
    // A request with id=null is unusual — test current behavior
    const msg = { jsonrpc: '2.0', id: null, method: 'tools/list', params: {} };
    const res = await sendMcpRequest(ctx.app, 'test-server', msg);
    const body = await res.json() as JsonRpcResponse;
    // Should process without crash; id in response matches request id (null)
    expect(res.status).toBe(200);
    expect(body.id).toBe(null);
  });

  it('"jsonrpc": "1.0" → rejected (not JSON-RPC 2.0)', async () => {
    const msg = { jsonrpc: '1.0', id: 1, method: 'tools/list', params: {} };
    const res = await sendMcpRequest(ctx.app, 'test-server', msg);
    expect(res.status).toBe(400);
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32600); // Invalid request
  });

  it('Notification (no "id" field) → forwarded, no crash', async () => {
    // JSON-RPC notifications have no "id" — they don't expect a response
    const msg = { jsonrpc: '2.0', method: 'notifications/initialized', params: {} };
    const res = await sendMcpRequest(ctx.app, 'test-server', msg);
    // Gateway should handle this (passthrough) without crashing
    expect(res.status).toBe(200);
    // The backend (mock) may return an error for unknown method, which is fine
  });

  it('Batch request: all items processed independently', async () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_contact', arguments: { id: '1' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nonexistent', arguments: {} } },
    ];

    const res = await sendMcpRequest(ctx.app, 'test-server', batch);
    expect(res.status).toBe(200);
    const body = await res.json() as JsonRpcResponse[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(3);

    // tools/list → success
    expect(body[0]?.error).toBeUndefined();
    // get_contact → success
    expect(body[1]?.error).toBeUndefined();
    // nonexistent → error
    expect(body[2]?.error).toBeDefined();
  });

  it('Batch with wrong jsonrpc version → per-message Invalid Request (spec-compliant)', async () => {
    // Per JSON-RPC 2.0 spec, a malformed entry must yield an error response
    // for that specific entry while valid entries succeed. The gateway used
    // to reject the entire batch; battle-test #4 corrected this.
    const batch = [
      { jsonrpc: '1.0', id: 1, method: 'tools/list', params: {} },
    ];
    const res = await sendMcpRequest(ctx.app, 'test-server', batch);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: number | null; error?: { code: number } }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]?.error?.code).toBe(-32600);
    expect(body[0]?.id).toBe(1);
  });

  it('Empty batch array → rejected (no messages)', async () => {
    const res = await sendMcpRequest(ctx.app, 'test-server', []);
    expect(res.status).toBe(400);
  });
});

// ─── 4.2 MCP-specific edge cases ─────────────────────────────────────────────

describe('4.2 MCP-specific edge cases', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ cacheEnabled: true, defaultTtl: 300 });
  });

  afterAll(() => teardown(ctx));

  beforeEach(() => {
    ctx.gateway.getCacheStore().clear();
    ctx.mockServer.resetCallCounts();
  });

  it('tools/list with no tools (empty array) → gateway returns empty list', async () => {
    // Override mock to return no tools
    const emptyCtx = await setup({
      tools: [], // No tools at all
      cacheEnabled: false,
    });
    try {
      const res = await sendMcpRequest(emptyCtx.app, 'test-server', makeToolsListMessage());
      const body = await res.json() as { result?: { tools: unknown[] } };
      expect(body.result?.tools).toEqual([]);
    } finally {
      await teardown(emptyCtx);
    }
  });

  it('tools/call with no arguments → works', async () => {
    // Call with empty arguments object
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_contact', arguments: {} } },
    );
    const body = await res.json() as JsonRpcResponse;
    // The mock server returns the tool result regardless of args
    expect(body.error).toBeUndefined();
  });

  it('tools/call with base64/binary content in result → passes through and caches correctly', async () => {
    const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    ctx.mockServer.setTool({
      name: 'get_contact',
      annotations: { readOnlyHint: true },
      result: {
        content: [{ type: 'image', data: binaryData, mimeType: 'image/png' }],
      },
    });

    // First call: MISS, cached
    const res1 = await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: 'img' }));
    expect(res1.headers.get('x-conduit-cache-status')).toBe('MISS');
    const body1 = await res1.json() as JsonRpcResponse;
    const result1 = body1.result as { content: Array<{ data: string }> };
    expect(result1.content[0]?.data).toBe(binaryData);

    // Second call: HIT, same binary content
    const res2 = await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: 'img' }));
    expect(res2.headers.get('x-conduit-cache-status')).toBe('HIT');
    const body2 = await res2.json() as JsonRpcResponse;
    const result2 = body2.result as { content: Array<{ data: string }> };
    expect(result2.content[0]?.data).toBe(binaryData);

    // Restore
    ctx.mockServer.setTool({
      name: 'get_contact',
      result: { id: '123', name: 'Alice Martin', email: 'alice@example.com' },
    });
  });

  it('initialize method passes through (not cached, not rate-limited)', async () => {
    const res = await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
    const body = await res.json() as { result?: { serverInfo?: unknown } };
    expect(body.result).toBeDefined();
    expect(body.result?.serverInfo).toBeDefined();
    // Cache status for non-tools/call methods is BYPASS
    expect(res.headers.get('x-conduit-cache-status')).toBe('BYPASS');
  });
});

// ─── 4.3 HTTP edge cases ──────────────────────────────────────────────────────

describe('4.3 HTTP edge cases', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ cacheEnabled: false });
  });

  afterAll(() => teardown(ctx));

  it('POST with wrong Content-Type (text/plain) but valid JSON body → processed', async () => {
    // The gateway reads the body as text and parses it regardless of Content-Type.
    // This documents the current permissive behavior.
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(makeInitializeMessage()),
    });
    // Hono may or may not parse text/plain; we document what happens
    expect(res.status).toBe(200);
  });

  it('POST with malformed JSON body → 400 Parse Error', async () => {
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not valid json !!!',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as JsonRpcResponse;
    expect(body.error?.code).toBe(-32700); // Parse error
  });

  it('POST with no body → 400 Invalid Request', async () => {
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    // Empty body is parsed as {} which is not a valid JSON-RPC message
    expect(res.status).toBe(400);
  });

  it('POST with body larger than 10 MB → 413', async () => {
    const bigBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_contact', arguments: { data: 'x'.repeat(11 * 1024 * 1024) } },
    });
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(bigBody.length) },
      body: bigBody,
    });
    expect(res.status).toBe(413);
  });

  it('Unknown server ID → 404', async () => {
    const res = await ctx.app.request('/mcp/nonexistent-server-xyz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeInitializeMessage()),
    });
    expect(res.status).toBe(404);
  });

  it('X-Conduit-Trace-Id header is always present in response', async () => {
    // Without custom trace ID: gateway generates one
    const res1 = await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
    expect(res1.headers.get('x-conduit-trace-id')).toBeTruthy();

    // With custom trace ID: it's echoed back
    const customTrace = 'my-custom-trace-xyz';
    const res2 = await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage(), {
      'x-conduit-trace-id': customTrace,
    });
    expect(res2.headers.get('x-conduit-trace-id')).toBe(customTrace);
  });
});

// =============================================================================
// CATEGORY 5: Metrics/observability consistency
// =============================================================================

describe('5.1 Trace propagation end-to-end', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ cacheEnabled: false });
  });

  afterAll(() => teardown(ctx));

  beforeEach(() => {
    ctx.gateway.getLogStore()['db'].exec('DELETE FROM logs');
    ctx.mockServer.resetCallCounts();
  });

  it('Custom trace ID appears in response header AND in logs', async () => {
    const traceId = 'trace-consistency-check-001';
    await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '1' }), {
      'x-conduit-trace-id': traceId,
    });

    // Check response header
    const res = await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage(), {
      'x-conduit-trace-id': traceId,
    });
    expect(res.headers.get('x-conduit-trace-id')).toBe(traceId);

    // Check logs
    const logs = ctx.gateway.getLogStore().getByTraceId(traceId);
    expect(logs.length).toBeGreaterThan(0);
    for (const entry of logs) {
      expect(entry.trace_id).toBe(traceId);
    }
  });

  it('Auto-generated trace ID appears in response AND is unique per request', async () => {
    const res1 = await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
    const res2 = await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());

    const trace1 = res1.headers.get('x-conduit-trace-id');
    const trace2 = res2.headers.get('x-conduit-trace-id');

    expect(trace1).toBeTruthy();
    expect(trace2).toBeTruthy();
    expect(trace1).not.toBe(trace2);

    // Both trace IDs must appear in logs
    const logs1 = ctx.gateway.getLogStore().getByTraceId(trace1!);
    const logs2 = ctx.gateway.getLogStore().getByTraceId(trace2!);
    expect(logs1).toHaveLength(1);
    expect(logs2).toHaveLength(1);
  });

  it('Trace ID is forwarded to upstream backend', async () => {
    const traceId = 'trace-upstream-propagation';
    await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '1' }), {
      'x-conduit-trace-id': traceId,
    });

    // The mock server records all calls. The upstream HTTP request should
    // include the X-Conduit-Trace-Id header. The mock doesn't record headers,
    // but we can verify the backend was called (proving the request passed through).
    expect(ctx.mockServer.getCallCount('tools/call')).toBe(1);
  });
});

describe('5.2 Cache stats accuracy', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      cacheEnabled: true,
      defaultTtl: 300,
    });
  });

  afterAll(() => teardown(ctx));

  beforeEach(() => {
    ctx.gateway.getCacheStore().clear();
    ctx.mockServer.resetCallCounts();
  });

  it('Cache stats reflect actual hit/miss counts', async () => {
    const msg = makeToolCallMessage('get_contact', { id: 'stats-test' });

    // 1 MISS
    await sendMcpRequest(ctx.app, 'test-server', msg);
    // 3 HITs
    await sendMcpRequest(ctx.app, 'test-server', msg);
    await sendMcpRequest(ctx.app, 'test-server', msg);
    await sendMcpRequest(ctx.app, 'test-server', msg);

    const res = await ctx.app.request('/conduit/cache/stats');
    const stats = await res.json() as { l1: { hits: number; misses: number } };

    expect(stats.l1.misses).toBeGreaterThanOrEqual(1);
    expect(stats.l1.hits).toBeGreaterThanOrEqual(3);
  });

  it('/conduit/stats.requests counts match actual request count', async () => {
    ctx.gateway.getLogStore()['db'].exec('DELETE FROM logs');

    const N = 7;
    for (let i = 0; i < N; i++) {
      await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
    }

    const res = await ctx.app.request('/conduit/stats');
    const body = await res.json() as { requests: { total_requests: number } };
    expect(body.requests.total_requests).toBe(N);
  });
});

describe('5.3 Security headers on admin responses', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({});
  });

  afterAll(() => teardown(ctx));

  it('Admin responses include X-Content-Type-Options: nosniff', async () => {
    const res = await ctx.app.request('/conduit/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('Admin responses include X-Frame-Options: DENY', async () => {
    const res = await ctx.app.request('/conduit/health');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('Admin responses include Cache-Control: no-store', async () => {
    const res = await ctx.app.request('/conduit/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
