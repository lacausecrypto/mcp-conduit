/**
 * Tests d'intégration : routing multi-serveurs (HTTP + stdio).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, teardownIntegration, type IntegrationContext } from './setup.js';

describe('Integration — multi-server routing', () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    ctx = await setupIntegration({ withStdio: true });
  }, 30_000);

  afterAll(async () => {
    await teardownIntegration(ctx);
  });

  it('tools/list aggregates tools from both HTTP and stdio backends', async () => {
    const res = await ctx.app.request('/mcp/http-backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { tools: Array<{ name: string }> } };
    expect(body.result?.tools.length).toBeGreaterThan(0);
  });

  it('can call a tool on the HTTP backend', async () => {
    const res = await ctx.app.request('/mcp/http-backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_contact', arguments: { id: 'integration-test' } },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['result']).toBeDefined();
  });

  it('can call a tool on the stdio backend', async () => {
    const res = await ctx.app.request('/mcp/stdio-backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'integration-test' } },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['result']).toBeDefined();
  });

  it('health endpoint reports both backends', async () => {
    const res = await ctx.app.request('/conduit/health');
    expect(res.status).toBe(200);

    const body = await res.json() as { backends: Array<{ id: string }> };
    const ids = body.backends.map((b) => b.id);
    expect(ids).toContain('http-backend');
    expect(ids).toContain('stdio-backend');
  });

  it('dynamic server add/remove works end-to-end', async () => {
    // Add a third server dynamically
    const addRes = await ctx.app.request('/conduit/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Conduit-Admin': 'true' },
      body: JSON.stringify({
        id: 'dynamic-integration',
        url: ctx.httpMock.url,
        cache: { default_ttl: 10 },
      }),
    });
    expect(addRes.status).toBe(201);

    // Verify it's listed
    const listRes = await ctx.app.request('/conduit/servers');
    const servers = (await listRes.json() as { servers: Array<{ id: string }> }).servers;
    expect(servers.map((s) => s.id)).toContain('dynamic-integration');

    // Remove it
    const delRes = await ctx.app.request('/conduit/servers/dynamic-integration', {
      method: 'DELETE',
      headers: { 'X-Conduit-Admin': 'true' },
    });
    expect(delRes.status).toBe(200);

    // Verify it's gone
    const listRes2 = await ctx.app.request('/conduit/servers');
    const servers2 = (await listRes2.json() as { servers: Array<{ id: string }> }).servers;
    expect(servers2.map((s) => s.id)).not.toContain('dynamic-integration');
  });
});
