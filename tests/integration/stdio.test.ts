/**
 * Tests d'intégration : transport stdio end-to-end via le gateway complet.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, teardownIntegration, type IntegrationContext } from './setup.js';

describe('Integration — stdio transport', () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    ctx = await setupIntegration({ withStdio: true });
  }, 30_000);

  afterAll(async () => {
    await teardownIntegration(ctx);
  });

  it('stdio backend initializes and lists tools', async () => {
    const res = await ctx.app.request('/mcp/stdio-backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { tools: Array<{ name: string }> } };
    const tools = body.result?.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name)).toContain('echo');
  });

  it('stdio echo tool returns correct result', async () => {
    const res = await ctx.app.request('/mcp/stdio-backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'hello from integration' } },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { content: Array<{ text: string }> } };
    expect(body.result?.content[0]?.text).toBe('hello from integration');
  });

  it('stdio add tool computes correctly', async () => {
    const res = await ctx.app.request('/mcp/stdio-backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'add', arguments: { a: 42, b: 58 } },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { content: Array<{ text: string }> } };
    expect(body.result?.content[0]?.text).toBe('100');
  });

  it('concurrent stdio requests are handled correctly', async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      ctx.app.request('/mcp/stdio-backend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 100 + i,
          method: 'tools/call',
          params: { name: 'add', arguments: { a: i, b: 10 } },
        }),
      }),
    );

    const results = await Promise.all(promises);
    for (let i = 0; i < 5; i++) {
      expect(results[i]!.status).toBe(200);
      const body = await results[i]!.json() as { result?: { content: Array<{ text: string }> } };
      expect(body.result?.content[0]?.text).toBe(String(i + 10));
    }
  });

  it('X-Conduit-Trace-Id is present in all responses', async () => {
    const res = await ctx.app.request('/mcp/stdio-backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'tools/list', params: {} }),
    });

    expect(res.headers.get('x-conduit-trace-id')).toBeTruthy();
  });
});
