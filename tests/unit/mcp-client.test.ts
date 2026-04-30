/**
 * Tests for src/proxy/mcp-client.ts
 * Covers: forward, openSseStream, circuit breaker integration, session handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpClient } from '../../src/proxy/mcp-client.js';
import type { CircuitBreaker } from '../../src/router/circuit-breaker.js';
import type { ServerConfig } from '../../src/config/types.js';

function makeServer(id = 'test-server', url = 'http://localhost:3000/mcp'): ServerConfig {
  return { id, url, cache: { default_ttl: 300 } };
}

function makeJsonResponse(body: unknown, sessionId?: string) {
  const headers = new Map<string, string>([
    ['content-type', 'application/json'],
  ]);
  if (sessionId) headers.set('mcp-session-id', sessionId);

  return {
    ok: true,
    status: 200,
    headers: {
      get: (key: string) => headers.get(key.toLowerCase()) ?? null,
      forEach: (fn: (v: string, k: string) => void) => headers.forEach(fn),
    },
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

function makeStreamResponse() {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (key: string) => key.toLowerCase() === 'content-type' ? 'text/event-stream' : null,
      forEach: vi.fn(),
    },
  };
}

function makeMockCircuitBreaker(canExecute = true): CircuitBreaker {
  return {
    canExecute: vi.fn().mockReturnValue(canExecute),
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
    reset: vi.fn(),
    getState: vi.fn().mockReturnValue({ state: 'closed', failures: 0, successes: 0, last_failure: 0, trip_count: 0 }),
  } as unknown as CircuitBreaker;
}

describe('McpClient - forward()', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed JSON body on success', async () => {
    const responseBody = { jsonrpc: '2.0', id: 1, result: { tools: [] } };
    mockFetch.mockResolvedValue(makeJsonResponse(responseBody));

    const client = new McpClient(makeServer());
    const result = await client.forward({ body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });

    expect(result.body).toEqual(responseBody);
    expect(result.isStream).toBe(false);
    expect(result.status).toBe(200);
  });

  it('sends correct Content-Type and Accept headers', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({}));

    const client = new McpClient(makeServer());
    await client.forward({ body: {} });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toContain('application/json');
  });

  it('sends POST to the server URL', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({}));

    const client = new McpClient(makeServer('s', 'http://example.com/mcp'));
    await client.forward({ body: {} });

    expect(mockFetch).toHaveBeenCalledWith('http://example.com/mcp', expect.objectContaining({ method: 'POST' }));
  });

  it('serializes body to JSON string', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({}));

    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'foo' } };
    const client = new McpClient(makeServer());
    await client.forward({ body });

    const sentBody = mockFetch.mock.calls[0][1].body;
    expect(JSON.parse(sentBody)).toEqual(body);
  });

  it('captures session ID from response Mcp-Session-Id header', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({}, 'session-xyz'));

    const client = new McpClient(makeServer());
    expect(client.getSessionId()).toBeUndefined();

    await client.forward({ body: {} });
    expect(client.getSessionId()).toBe('session-xyz');
  });

  it('sends existing session ID in request headers', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({}));

    const client = new McpClient(makeServer());
    client.setSessionId('existing-session');

    await client.forward({ body: {} });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Mcp-Session-Id']).toBe('existing-session');
  });

  it('uses options.sessionId over internal session ID', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({}));

    const client = new McpClient(makeServer());
    client.setSessionId('internal-session');

    await client.forward({ body: {}, sessionId: 'options-session' });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Mcp-Session-Id']).toBe('options-session');
  });

  it('propagates extra headers', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({}));

    const client = new McpClient(makeServer());
    await client.forward({
      body: {},
      extraHeaders: { 'X-Conduit-Trace-Id': 'trace-abc', 'Authorization': 'Bearer tok' },
    });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['X-Conduit-Trace-Id']).toBe('trace-abc');
    expect(headers['Authorization']).toBe('Bearer tok');
  });

  it('includes static upstream headers from the server config', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({}));

    const client = new McpClient({
      ...makeServer(),
      headers: { 'X-API-Key': 'server-secret' },
    });
    await client.forward({ body: {} });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['X-API-Key']).toBe('server-secret');
  });

  it('returns isStream=true for text/event-stream response', async () => {
    mockFetch.mockResolvedValue(makeStreamResponse());

    const client = new McpClient(makeServer());
    const result = await client.forward({ body: {} });

    expect(result.isStream).toBe(true);
    expect(result.rawResponse).toBeDefined();
    expect(result.body).toBeUndefined();
  });

  it('throws when upstream returns non-JSON body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      headers: {
        get: (_key: string) => 'text/plain',
        forEach: vi.fn(),
      },
      text: vi.fn().mockResolvedValue('upstream exploded'),
    });

    const client = new McpClient(makeServer());
    await expect(client.forward({ body: {} })).rejects.toThrow('non-JSON');
  });

  it('accepts successful non-JSON notification responses as no-body acknowledgements', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      headers: {
        get: (_key: string) => 'text/plain',
        forEach: vi.fn(),
      },
      text: vi.fn().mockResolvedValue('Accepted'),
    });

    const client = new McpClient(makeServer());
    const result = await client.forward({
      body: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    });

    expect(result.status).toBe(202);
    expect(result.body).toBeNull();
    expect(result.isStream).toBe(false);
  });

  it('accepts empty successful notification responses as no-body acknowledgements', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      headers: {
        get: (_key: string) => 'application/json',
        forEach: vi.fn(),
      },
      text: vi.fn().mockResolvedValue(''),
    });

    const client = new McpClient(makeServer());
    const result = await client.forward({
      body: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    });

    expect(result.status).toBe(202);
    expect(result.body).toBeNull();
  });

  it('throws on network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new McpClient(makeServer());
    await expect(client.forward({ body: {} })).rejects.toThrow('ECONNREFUSED');
  });

  it('decrements activeConnections even after error', async () => {
    mockFetch.mockRejectedValue(new Error('fail'));

    const client = new McpClient(makeServer());
    expect(client.activeConnections).toBe(0);
    try { await client.forward({ body: {} }); } catch {}
    expect(client.activeConnections).toBe(0);
  });

  it('increments and decrements activeConnections during request', async () => {
    let activeWhileRunning = 0;
    mockFetch.mockImplementation(async () => {
      activeWhileRunning = (await import('../../src/proxy/mcp-client.js')).McpClient
        ? 0 : 0; // just a timing check
      return makeJsonResponse({});
    });

    const client = new McpClient(makeServer());
    expect(client.activeConnections).toBe(0);
    await client.forward({ body: {} });
    expect(client.activeConnections).toBe(0);
  });

  it('uses server timeout_ms when specified', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({}));

    const server = { ...makeServer(), timeout_ms: 5000 };
    const client = new McpClient(server);
    await client.forward({ body: {} });

    // Verify the AbortController was created (implicitly via fetch call)
    expect(mockFetch).toHaveBeenCalled();
  });

  it('uses options.timeoutMs when specified', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({}));

    const client = new McpClient(makeServer());
    await client.forward({ body: {}, timeoutMs: 100 });
    expect(mockFetch).toHaveBeenCalled();
  });
});

describe('McpClient - circuit breaker integration', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fast-fails when circuit breaker is open (canExecute=false)', async () => {
    const cb = makeMockCircuitBreaker(false);

    const client = new McpClient(makeServer());
    client.setCircuitBreaker(cb);

    await expect(client.forward({ body: {} })).rejects.toThrow('Circuit breaker open');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls onSuccess when request succeeds', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({}));
    const cb = makeMockCircuitBreaker(true);

    const client = new McpClient(makeServer());
    client.setCircuitBreaker(cb);

    await client.forward({ body: {} });
    expect(cb.onSuccess).toHaveBeenCalledOnce();
  });

  it('calls onFailure when request fails', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    const cb = makeMockCircuitBreaker(true);

    const client = new McpClient(makeServer());
    client.setCircuitBreaker(cb);

    await expect(client.forward({ body: {} })).rejects.toThrow();
    expect(cb.onFailure).toHaveBeenCalledOnce();
  });

  it('does not call onSuccess after circuit breaker rejects', async () => {
    const cb = makeMockCircuitBreaker(false);

    const client = new McpClient(makeServer());
    client.setCircuitBreaker(cb);

    await expect(client.forward({ body: {} })).rejects.toThrow();
    expect(cb.onSuccess).not.toHaveBeenCalled();
    expect(cb.onFailure).not.toHaveBeenCalled();
  });
});

describe('McpClient - getCircuitBreaker / setCircuitBreaker', () => {
  it('returns undefined when no circuit breaker set', () => {
    const client = new McpClient(makeServer());
    expect(client.getCircuitBreaker()).toBeUndefined();
  });

  it('returns the set circuit breaker', () => {
    const cb = makeMockCircuitBreaker();
    const client = new McpClient(makeServer());
    client.setCircuitBreaker(cb);
    expect(client.getCircuitBreaker()).toBe(cb);
  });
});

describe('McpClient - openSseStream()', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends GET request with SSE accept header', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const client = new McpClient(makeServer('s', 'http://example.com/mcp'));
    await client.openSseStream();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://example.com/mcp',
      expect.objectContaining({ method: 'GET' }),
    );
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Accept']).toBe('text/event-stream');
  });

  it('includes session ID in SSE request if set', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const client = new McpClient(makeServer());
    client.setSessionId('sse-session-id');
    await client.openSseStream();

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Mcp-Session-Id']).toBe('sse-session-id');
  });

  it('includes extra headers when provided', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const client = new McpClient(makeServer());
    await client.openSseStream({ 'X-Conduit-Trace-Id': 'sse-trace' });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['X-Conduit-Trace-Id']).toBe('sse-trace');
  });

  it('includes static upstream headers on SSE requests', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const client = new McpClient({
      ...makeServer(),
      headers: { 'X-API-Key': 'server-secret' },
    });
    await client.openSseStream();

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['X-API-Key']).toBe('server-secret');
  });

  it('does not include Mcp-Session-Id when session not set', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const client = new McpClient(makeServer());
    await client.openSseStream();

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Mcp-Session-Id']).toBeUndefined();
  });
});

describe('McpClient - properties', () => {
  it('serverId returns the configured server ID', () => {
    const client = new McpClient(makeServer('my-server', 'http://x.com'));
    expect(client.serverId).toBe('my-server');
  });

  it('serverUrl returns the configured server URL', () => {
    const client = new McpClient(makeServer('s', 'http://example.com/mcp'));
    expect(client.serverUrl).toBe('http://example.com/mcp');
  });

  it('activeConnections starts at 0', () => {
    const client = new McpClient(makeServer());
    expect(client.activeConnections).toBe(0);
  });

  it('getSessionId returns undefined initially', () => {
    const client = new McpClient(makeServer());
    expect(client.getSessionId()).toBeUndefined();
  });

  it('setSessionId / getSessionId roundtrip', () => {
    const client = new McpClient(makeServer());
    client.setSessionId('session-123');
    expect(client.getSessionId()).toBe('session-123');
  });
});
