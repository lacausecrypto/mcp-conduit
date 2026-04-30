/**
 * Audit Sprint 3 #4 — tenant fallback hardening.
 *
 * When tenant_isolation is enabled with a custom header (e.g. X-Tenant-Id),
 * the previous implementation honored the caller-supplied header even when
 * authentication was active. That let any client read another tenant's
 * cache by sending `X-Tenant-Id: victim-tenant`. The fix: when auth is
 * configured, the authenticated principal's tenant_id is the source of
 * truth and the header is ignored.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { resetMetrics } from '../../src/observability/metrics.js';
import { startMockMcpServer, type MockMcpServer } from './mock-mcp-server.js';
import { sendMcpRequest, makeToolCallMessage } from './setup.js';

interface Ctx {
  gateway: ConduitGateway;
  app: Hono;
  mock: MockMcpServer;
}

async function buildGatewayWithAuth(authActive: boolean): Promise<Ctx> {
  const mock = await startMockMcpServer(0);
  const config: ConduitGatewayConfig = {
    gateway: { port: 0, host: '127.0.0.1' },
    router: {
      namespace_strategy: 'none',
      health_check: {
        enabled: false, interval_seconds: 60, timeout_ms: 1000,
        unhealthy_threshold: 3, healthy_threshold: 1,
      },
      load_balancing: 'round-robin',
    },
    servers: [
      {
        id: 'test-server',
        url: mock.url,
        cache: { default_ttl: 300 },
      },
    ],
    cache: { enabled: true, l1: { max_entries: 1000, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: true, header: 'X-Tenant-Id' },
    observability: {
      log_args: false, log_responses: false, redact_fields: [],
      retention_days: 1, db_path: ':memory:',
    },
    metrics: { enabled: false, port: 0 },
    admin: { allow_unauthenticated: true },
    ...(authActive ? {
      auth: {
        method: 'api-key' as const,
        api_keys: [
          { key: 'sk-alice', client_id: 'alice', tenant_id: 'tenant-alice' },
          { key: 'sk-bob', client_id: 'bob', tenant_id: 'tenant-bob' },
        ],
      },
    } : {}),
  };
  resetMetrics();
  const gateway = new ConduitGateway(config);
  await gateway.initialize();
  return { gateway, app: gateway.createApp(), mock };
}

describe('Tenant fallback hardening (audit Sprint 3 #4)', () => {
  describe('with auth configured', () => {
    let ctx: Ctx;
    beforeAll(async () => { ctx = await buildGatewayWithAuth(true); });
    afterAll(async () => { ctx.gateway.stop(); await ctx.mock.close(); });

    it('ignores X-Tenant-Id header sent by an authenticated caller', async () => {
      // Alice authenticates as tenant-alice but tries to spoof tenant-bob
      // through the custom header. The cache key MUST be partitioned by
      // tenant-alice — bob's cached entries (if any) must not be reachable.
      ctx.gateway.getCacheStore().clear();
      ctx.mock.resetCallCounts();

      // First, populate cache for Alice (her real tenant)
      const aliceMsg = makeToolCallMessage('get_contact', { id: 'X' });
      const r1 = await sendMcpRequest(ctx.app, 'test-server', aliceMsg, {
        Authorization: 'Bearer sk-alice',
      });
      expect(r1.status).toBe(200);
      expect(r1.headers.get('x-conduit-cache-status')).toBe('MISS');

      // Same Alice request, but lying about the tenant via header — should
      // still hit Alice's cache slot (auth wins over header).
      const r2 = await sendMcpRequest(ctx.app, 'test-server', aliceMsg, {
        Authorization: 'Bearer sk-alice',
        'X-Tenant-Id': 'tenant-bob',
      });
      expect(r2.headers.get('x-conduit-cache-status')).toBe('HIT');
      // Backend was called only once (Alice's first call) — the spoofed
      // header did not pivot Alice into a fresh tenant slot.
      expect(ctx.mock.getCallCount('tools/call')).toBe(1);
    });

    it('does not let a spoofed header read another tenant\'s cached entry', async () => {
      ctx.gateway.getCacheStore().clear();
      ctx.mock.resetCallCounts();

      // Bob populates cache for his real tenant
      const msg = makeToolCallMessage('get_contact', { id: 'shared-key' });
      await sendMcpRequest(ctx.app, 'test-server', msg, {
        Authorization: 'Bearer sk-bob',
      });
      const bobCalls = ctx.mock.getCallCount('tools/call');

      // Alice tries to read Bob's cache by claiming his tenant via header.
      const r = await sendMcpRequest(ctx.app, 'test-server', msg, {
        Authorization: 'Bearer sk-alice',
        'X-Tenant-Id': 'tenant-bob',
      });
      // Cache must be MISS (Alice gets her own slot, can't piggyback on Bob).
      expect(r.headers.get('x-conduit-cache-status')).toBe('MISS');
      expect(ctx.mock.getCallCount('tools/call')).toBe(bobCalls + 1);
    });
  });

  describe('without auth (auth.method === "none")', () => {
    let ctx: Ctx;
    beforeAll(async () => { ctx = await buildGatewayWithAuth(false); });
    afterAll(async () => { ctx.gateway.stop(); await ctx.mock.close(); });

    it('still honors X-Tenant-Id when there is no authenticated principal', async () => {
      // Backwards-compat: when the operator runs without auth, the header
      // remains the only signal — partitioning by it is still safer than
      // a single shared cache.
      ctx.gateway.getCacheStore().clear();
      ctx.mock.resetCallCounts();

      const msg = makeToolCallMessage('get_contact', { id: 'noauth' });

      const r1 = await sendMcpRequest(ctx.app, 'test-server', msg, {
        'X-Tenant-Id': 'tenant-x',
      });
      expect(r1.headers.get('x-conduit-cache-status')).toBe('MISS');

      const r2 = await sendMcpRequest(ctx.app, 'test-server', msg, {
        'X-Tenant-Id': 'tenant-y',
      });
      // Different X-Tenant-Id → different cache slot → MISS again
      expect(r2.headers.get('x-conduit-cache-status')).toBe('MISS');
      expect(ctx.mock.getCallCount('tools/call')).toBe(2);
    });
  });
});
