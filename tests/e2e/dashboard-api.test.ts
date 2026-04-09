/**
 * Tests e2e — Dashboard API connectivity.
 *
 * Verifies that ALL admin API endpoints called by the dashboard
 * respond correctly with the expected response format.
 * This catches format mismatches between frontend and backend.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setup,
  teardown,
  sendMcpRequest,
  makeToolCallMessage,
  type E2eTestContext,
} from './setup.js';

describe('Dashboard API connectivity', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup();
    // Generate some data for stats
    await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '1' }));
    await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '1' }));
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  // ─── Endpoints the dashboard calls ──────────────────────────

  it('GET /conduit/health returns expected shape', async () => {
    const res = await ctx.app.request('/conduit/health');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('uptime_seconds');
    expect(body).toHaveProperty('backends');
    expect(Array.isArray(body['backends'])).toBe(true);
  });

  it('GET /conduit/stats returns requests + cache + servers', async () => {
    const res = await ctx.app.request('/conduit/stats');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('requests');
    expect(body).toHaveProperty('cache');
    expect(body).toHaveProperty('inflight');
    expect(body).toHaveProperty('servers');

    // Cache stats should have flat L1 properties (used by Overview)
    const cache = body['cache'] as Record<string, unknown>;
    expect(cache).toHaveProperty('hits');
    expect(cache).toHaveProperty('misses');
    expect(cache).toHaveProperty('hitRate');
  });

  it('GET /conduit/cache/stats returns { l1: {...} } format', async () => {
    const res = await ctx.app.request('/conduit/cache/stats');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // Dashboard does c.value.l1 || c.value to unwrap
    expect(body).toHaveProperty('l1');
    const l1 = body['l1'] as Record<string, unknown>;
    expect(l1).toHaveProperty('hits');
    expect(l1).toHaveProperty('misses');
    expect(l1).toHaveProperty('hitRate');
    expect(l1).toHaveProperty('entries');
  });

  it('GET /conduit/circuits returns { circuits: [...] }', async () => {
    const res = await ctx.app.request('/conduit/circuits');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('circuits');
    expect(Array.isArray(body['circuits'])).toBe(true);
  });

  it('GET /conduit/logs returns { logs: [...], count, limit, offset }', async () => {
    const res = await ctx.app.request('/conduit/logs');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('logs');
    expect(body).toHaveProperty('count');
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
    expect(Array.isArray(body['logs'])).toBe(true);
  });

  it('GET /conduit/servers returns { servers: [...] }', async () => {
    const res = await ctx.app.request('/conduit/servers');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('servers');
    const servers = body['servers'] as Array<Record<string, unknown>>;
    expect(servers.length).toBeGreaterThan(0);
    expect(servers[0]).toHaveProperty('id');
    expect(servers[0]).toHaveProperty('healthy');
    expect(servers[0]).toHaveProperty('tools');
  });

  it('GET /conduit/limits returns { enabled, buckets }', async () => {
    const res = await ctx.app.request('/conduit/limits');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('enabled');
    expect(body).toHaveProperty('buckets');
  });

  it('GET /conduit/acl/check returns allowed/denied', async () => {
    const res = await ctx.app.request('/conduit/acl/check?client=test&server=test-server&tool=get_contact');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('allowed');
  });

  // ─── CSRF protection on mutations ───────────────────────────

  it('DELETE /conduit/cache/server/:id requires X-Conduit-Admin header', async () => {
    const res = await ctx.app.request('/conduit/cache/server/test-server', {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });

  it('DELETE /conduit/cache/server/:id works WITH X-Conduit-Admin header', async () => {
    const res = await ctx.app.request('/conduit/cache/server/test-server', {
      method: 'DELETE',
      headers: { 'X-Conduit-Admin': 'true' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('deleted_count');
  });

  // ─── Dashboard HTML serves API_BASE correctly ───────────────

  it('dashboard HTML contains API_BASE = /conduit', async () => {
    const res = await ctx.app.request('/conduit/dashboard');
    const html = await res.text();
    expect(html).toContain("API_BASE    = '/conduit'");
  });

  it('dashboard HTML contains X-Conduit-Admin CSRF header', async () => {
    const res = await ctx.app.request('/conduit/dashboard');
    const html = await res.text();
    expect(html).toContain('X-Conduit-Admin');
  });
});
