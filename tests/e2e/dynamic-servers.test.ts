/**
 * Tests e2e pour l'ajout et la suppression dynamique de serveurs
 * via l'API admin (F8: Hot-reload serveurs).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, type E2eTestContext } from './setup.js';
import { startMockMcpServer, type MockMcpServer } from './mock-mcp-server.js';

describe('Dynamic server management via admin API', () => {
  let ctx: E2eTestContext;
  let secondMock: MockMcpServer;

  beforeAll(async () => {
    ctx = await setup();
    secondMock = await startMockMcpServer(0);
  });

  afterAll(async () => {
    await secondMock.close();
    await teardown(ctx);
  });

  it('POST /conduit/servers registers a new server', async () => {
    const res = await ctx.app.request('/conduit/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Conduit-Admin': 'true' },
      body: JSON.stringify({
        id: 'dynamic-server',
        url: secondMock.url,
        cache: { default_ttl: 60 },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { server_id: string; tools_count: number };
    expect(body.server_id).toBe('dynamic-server');
    expect(body.tools_count).toBeGreaterThanOrEqual(0);
  });

  it('GET /conduit/servers lists the new server', async () => {
    const res = await ctx.app.request('/conduit/servers');
    expect(res.status).toBe(200);
    const body = await res.json() as { servers: Array<{ id: string }> };
    const ids = body.servers.map((s) => s.id);
    expect(ids).toContain('dynamic-server');
    expect(ids).toContain('test-server');
  });

  it('POST /conduit/servers rejects duplicate ID', async () => {
    const res = await ctx.app.request('/conduit/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Conduit-Admin': 'true' },
      body: JSON.stringify({
        id: 'dynamic-server',
        url: secondMock.url,
        cache: { default_ttl: 60 },
      }),
    });
    expect(res.status).toBe(409);
  });

  it('DELETE /conduit/servers/:id removes the server', async () => {
    const res = await ctx.app.request('/conduit/servers/dynamic-server', {
      method: 'DELETE',
      headers: { 'X-Conduit-Admin': 'true' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { removed: boolean };
    expect(body.removed).toBe(true);
  });

  it('GET /conduit/servers no longer lists removed server', async () => {
    const res = await ctx.app.request('/conduit/servers');
    const body = await res.json() as { servers: Array<{ id: string }> };
    const ids = body.servers.map((s) => s.id);
    expect(ids).not.toContain('dynamic-server');
  });

  it('DELETE /conduit/servers/:id returns 404 for unknown server', async () => {
    const res = await ctx.app.request('/conduit/servers/nonexistent', {
      method: 'DELETE',
      headers: { 'X-Conduit-Admin': 'true' },
    });
    expect(res.status).toBe(404);
  });
});
