/**
 * Tests e2e pour le rate limiting.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setup,
  teardown,
  sendMcpRequest,
  makeToolCallMessage,
  makeToolsListMessage,
  type E2eTestContext,
} from './setup.js';
import type { AuthConfig, AclConfig } from '../../src/auth/types.js';
import type { RateLimitConfig } from '../../src/rate-limit/types.js';

interface JsonRpcResponse {
  error?: { code: number; message: string };
  result?: unknown;
}

const API_KEY_AUTH: AuthConfig = {
  method: 'api-key',
  api_keys: [
    { key: 'sk-a', client_id: 'client-a', tenant_id: 'tenant-a' },
    { key: 'sk-b', client_id: 'client-b', tenant_id: 'tenant-b' },
  ],
};

// ============================================================================
// Tests : limites client basiques
// ============================================================================

describe('Rate Limit — limite client basique', () => {
  let ctx: E2eTestContext;

  const RATE_LIMITS: RateLimitConfig = {
    enabled: true,
    per_client: { requests_per_minute: 3 },
  };

  beforeAll(async () => {
    ctx = await setup({ auth: API_KEY_AUTH, rate_limits: RATE_LIMITS, defaultTtl: 0 });
  });

  afterAll(() => teardown(ctx));

  beforeEach(() => {
    ctx.gateway.getRateLimiter()?.resetAll();
  });

  it('les N premières requêtes réussissent, la N+1 est rejetée', async () => {
    const msg = makeToolCallMessage('get_contact', { id: '1' });
    const headers = { Authorization: 'Bearer sk-a' };

    for (let i = 0; i < 3; i++) {
      const res = await sendMcpRequest(ctx.app, 'test-server', msg, headers);
      const body = await res.json() as JsonRpcResponse;
      expect(body.error).toBeUndefined();
    }

    const last = await sendMcpRequest(ctx.app, 'test-server', msg, headers);
    const lastBody = await last.json() as JsonRpcResponse;
    expect(lastBody.error?.code).toBe(-32000);
    expect(lastBody.error?.message).toContain('Rate limit exceeded');
  });

  it('erreur de rate limit contient "Retry after"', async () => {
    const msg = makeToolCallMessage('get_contact', { id: '1' });
    const headers = { Authorization: 'Bearer sk-a' };

    for (let i = 0; i < 3; i++) {
      await sendMcpRequest(ctx.app, 'test-server', msg, headers);
    }

    const res = await sendMcpRequest(ctx.app, 'test-server', msg, headers);
    const body = await res.json() as JsonRpcResponse;
    expect(body.error?.message).toMatch(/Retry after/i);
  });

  it('réponse avec Retry-After header', async () => {
    const msg = makeToolCallMessage('get_contact', { id: '1' });
    const headers = { Authorization: 'Bearer sk-a' };

    for (let i = 0; i < 3; i++) {
      await sendMcpRequest(ctx.app, 'test-server', msg, headers);
    }

    const res = await sendMcpRequest(ctx.app, 'test-server', msg, headers);
    expect(res.headers.get('Retry-After')).not.toBeNull();
  });

  it('clients différents ont des limites indépendantes', async () => {
    const msg = makeToolCallMessage('get_contact', { id: '1' });

    // Épuiser la limite de client-a
    for (let i = 0; i < 3; i++) {
      await sendMcpRequest(ctx.app, 'test-server', msg, { Authorization: 'Bearer sk-a' });
    }
    const ra = await sendMcpRequest(ctx.app, 'test-server', msg, { Authorization: 'Bearer sk-a' });
    const bodyA = await ra.json() as JsonRpcResponse;
    expect(bodyA.error?.code).toBe(-32000);

    // client-b n'est pas affecté
    const rb = await sendMcpRequest(ctx.app, 'test-server', msg, { Authorization: 'Bearer sk-b' });
    const bodyB = await rb.json() as JsonRpcResponse;
    expect(bodyB.error).toBeUndefined();
  });
});

// ============================================================================
// Tests : rate limiting désactivé
// ============================================================================

describe('Rate Limit — désactivé', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      auth: API_KEY_AUTH,
      rate_limits: { enabled: false },
      defaultTtl: 0,
    });
  });

  afterAll(() => teardown(ctx));

  it('toutes les requêtes passent sans limite', async () => {
    const msg = makeToolCallMessage('get_contact', { id: '1' });
    const headers = { Authorization: 'Bearer sk-a' };

    for (let i = 0; i < 20; i++) {
      const res = await sendMcpRequest(ctx.app, 'test-server', msg, headers);
      const body = await res.json() as JsonRpcResponse;
      expect(body.error).toBeUndefined();
    }
  });
});

// ============================================================================
// Tests : limite par serveur
// ============================================================================

describe('Rate Limit — par serveur', () => {
  let ctx: E2eTestContext;

  const RATE_LIMITS: RateLimitConfig = {
    enabled: true,
    overrides: [
      {
        server: 'test-server',
        requests_per_minute: 2,
        per_tool: {
          search_leads: { requests_per_minute: 1 },
        },
      },
    ],
  };

  beforeAll(async () => {
    ctx = await setup({ auth: API_KEY_AUTH, rate_limits: RATE_LIMITS, defaultTtl: 0, cacheEnabled: false });
  });

  afterAll(() => teardown(ctx));

  beforeEach(() => {
    ctx.gateway.getRateLimiter()?.resetAll();
  });

  it('limite par serveur partagée entre outils', async () => {
    const headers = { Authorization: 'Bearer sk-a' };

    await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', {}), headers);
    await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', {}), headers);

    const res = await sendMcpRequest(
      ctx.app, 'test-server', makeToolCallMessage('search_leads', { query: 'x' }), headers,
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error?.code).toBe(-32000);
  });

  it('override par outil plus restrictif', async () => {
    const headers = { Authorization: 'Bearer sk-b' };

    // search_leads a une limite de 1/min
    await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('search_leads', {}), headers);

    const res = await sendMcpRequest(
      ctx.app, 'test-server', makeToolCallMessage('search_leads', {}), headers,
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error?.code).toBe(-32000);
  });
});

// ============================================================================
// Tests : cache + rate limit
// ============================================================================

describe('Rate Limit — les hits de cache ne comptent pas les limites serveur', () => {
  let ctx: E2eTestContext;

  const RATE_LIMITS: RateLimitConfig = {
    enabled: true,
    overrides: [{ server: 'test-server', requests_per_minute: 1 }],
  };

  beforeAll(async () => {
    ctx = await setup({
      auth: API_KEY_AUTH,
      rate_limits: RATE_LIMITS,
      defaultTtl: 300, // TTL élevé pour forcer le cache
    });
  });

  afterAll(() => teardown(ctx));

  beforeEach(() => {
    ctx.gateway.getRateLimiter()?.resetAll();
    ctx.gateway.getCacheStore().deleteByServer('test-server');
  });

  it('après cache miss (1 appel backend), les requêtes suivantes (cache hit) passent', async () => {
    const msg = makeToolCallMessage('get_contact', { id: 'cache-test' });
    const headers = { Authorization: 'Bearer sk-a' };

    // Premier appel : cache miss + consume serveur (1/1)
    const r1 = await sendMcpRequest(ctx.app, 'test-server', msg, headers);
    const b1 = await r1.json() as JsonRpcResponse;
    expect(b1.error).toBeUndefined();

    // Deuxième appel : cache HIT — ne consomme pas la limite serveur
    const r2 = await sendMcpRequest(ctx.app, 'test-server', msg, headers);
    const b2 = await r2.json() as JsonRpcResponse;
    expect(b2.error).toBeUndefined();
  });
});

// ============================================================================
// Tests : endpoints admin
// ============================================================================

describe('Admin Rate Limit endpoints', () => {
  let ctx: E2eTestContext;

  const RATE_LIMITS: RateLimitConfig = {
    enabled: true,
    per_client: { requests_per_minute: 100 },
  };

  beforeAll(async () => {
    ctx = await setup({ auth: API_KEY_AUTH, rate_limits: RATE_LIMITS, defaultTtl: 0 });
  });

  afterAll(() => teardown(ctx));

  it('GET /conduit/limits retourne les buckets actifs', async () => {
    // Faire quelques requêtes d'abord
    await sendMcpRequest(
      ctx.app, 'test-server', makeToolCallMessage('get_contact', {}),
      { Authorization: 'Bearer sk-a' },
    );

    const res = await ctx.app.request('/conduit/limits');
    const body = await res.json() as { enabled: boolean; buckets: unknown[] };
    expect(body.enabled).toBe(true);
    expect(Array.isArray(body.buckets)).toBe(true);
  });

  it('GET /conduit/limits/client/:id retourne le quota client', async () => {
    await sendMcpRequest(
      ctx.app, 'test-server', makeToolCallMessage('get_contact', {}),
      { Authorization: 'Bearer sk-a' },
    );

    const res = await ctx.app.request('/conduit/limits/client/client-a');
    const body = await res.json() as { client_id: string; enabled: boolean; limits: unknown[] };
    expect(body.client_id).toBe('client-a');
    expect(body.enabled).toBe(true);
    expect(Array.isArray(body.limits)).toBe(true);
  });

  it('DELETE /conduit/limits/reset remet à zéro tous les compteurs', async () => {
    const res = await ctx.app.request('/conduit/limits/reset', { method: 'DELETE', headers: { 'X-Conduit-Admin': 'true' } });
    const body = await res.json() as { reset: boolean };
    expect(body.reset).toBe(true);
  });

  it('DELETE /conduit/limits/client/:id/reset remet à zéro un client', async () => {
    const res = await ctx.app.request('/conduit/limits/client/client-a/reset', { method: 'DELETE', headers: { 'X-Conduit-Admin': 'true' } });
    const body = await res.json() as { reset: boolean; client_id: string };
    expect(body.reset).toBe(true);
    expect(body.client_id).toBe('client-a');
  });
});
