/**
 * Additional e2e coverage for src/proxy/transport.ts
 * Focuses on error paths, body size limits, and header handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, teardown, type E2eTestContext } from './setup.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('POST /mcp/:serverId — body validation', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await teardown(ctx);
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json {{{',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32700); // PARSE_ERROR
  });

  it('returns 400 for empty JSON object that is not valid JSON-RPC', async () => {
    // {} is valid JSON but not valid JSON-RPC (missing jsonrpc field)
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"not": "jsonrpc"}',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32600); // INVALID_REQUEST
  });

  it('returns 400 for JSON array with invalid JSON-RPC messages', async () => {
    // Valid JSON array but messages inside fail JSON-RPC parsing
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[1, 2, 3]',
    });
    // Array of non-objects — parseJsonRpc returns null
    expect(res.status).toBe(400);
  });

  it('returns 413 when Content-Length header exceeds 10MB', async () => {
    const overLimit = 10 * 1024 * 1024 + 1;
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(overLimit),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('too large');
  });

  it('includes X-Conduit-Trace-Id in response', async () => {
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const traceId = res.headers.get('x-conduit-trace-id');
    expect(traceId).not.toBeNull();
    expect(traceId).toMatch(UUID_REGEX);
  });

  it('preserves X-Conduit-Trace-Id from incoming request', async () => {
    const incomingTraceId = '11111111-2222-4333-8444-555555555555';
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Conduit-Trace-Id': incomingTraceId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.headers.get('x-conduit-trace-id')).toBe(incomingTraceId);
  });

  it('includes X-Conduit-Server-Id in response', async () => {
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.headers.get('x-conduit-server-id')).toBe('test-server');
  });
});

describe('POST /mcp/:serverId — unknown server', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await teardown(ctx);
  });

  it('returns 404 for unknown server ID', async () => {
    const res = await ctx.app.request('/mcp/nonexistent-server-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(404);
  });

  it('returns JSON-RPC error for unknown server', async () => {
    const res = await ctx.app.request('/mcp/no-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = await res.json() as { error: { code: number } };
    expect(body.error).toBeDefined();
  });
});

describe('POST /mcp — no server ID (route to first server)', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await teardown(ctx);
  });

  it('returns 200 and routes to first configured server', async () => {
    const res = await ctx.app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
  });
});

describe('GET /mcp/:serverId — SSE stream endpoint', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await teardown(ctx);
  });

  it('returns 404 for unknown server ID via GET', async () => {
    const res = await ctx.app.request('/mcp/no-such-server', {
      method: 'GET',
      headers: { 'Accept': 'text/event-stream' },
    });
    expect(res.status).toBe(404);
  });
});

describe('Batch JSON-RPC requests', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await teardown(ctx);
  });

  it('handles batch request (array of JSON-RPC messages)', async () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ];
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });
});

describe('Request context header extraction', () => {
  let ctx: E2eTestContext;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await teardown(ctx);
  });

  it('extracts Mcp-Session-Id header from request', async () => {
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': 'test-session-id',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    // Session ID should be propagated to upstream
  });

  it('extracts X-Conduit-Group header from request', async () => {
    const res = await ctx.app.request('/mcp/test-server', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Conduit-Group': 'team-alpha',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
  });
});
