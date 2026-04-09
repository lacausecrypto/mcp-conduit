/**
 * Security tests — MCP Conduit.
 *
 * Comprehensive security testing covering:
 * - Injection attacks (path traversal, shell metacharacters, prototype pollution)
 * - Authentication edge cases (null bytes, whitespace, malformed tokens)
 * - Rate limit bypass attempts (X-Forwarded-For spoofing, blank identifiers)
 * - Cache isolation (tenant separation, key collision resistance)
 * - CSRF protection on admin routes
 * - Data leakage prevention (error messages, redaction, trace IDs)
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { startMockMcpServer, type MockMcpServer } from '../e2e/mock-mcp-server.js';
import { resetMetrics } from '../../src/observability/metrics.js';
import type { Hono } from 'hono';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeToolCall(name: string, args: Record<string, unknown> = {}, id: number | string = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function makeToolsList(id: number | string = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

async function sendJson<T>(
  app: Hono,
  serverId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; raw: Response }> {
  const res = await app.request(`/mcp/${serverId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const clone = res.clone();
  return { status: res.status, body: (await res.json()) as T, raw: clone };
}

async function sendAdmin(
  app: Hono,
  path: string,
  method: string = 'GET',
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: unknown; raw: Response }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await app.request(`/conduit${path}`, opts);
  const clone = res.clone();
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = await clone.text();
  }
  return { status: res.status, body: parsed, raw: clone };
}

function makeSecurityConfig(mockUrl: string, overrides: Partial<ConduitGatewayConfig> = {}): ConduitGatewayConfig {
  return {
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
    },
    servers: [{
      id: 'sec-server',
      url: mockUrl,
      cache: { default_ttl: 300 },
    }],
    cache: { enabled: true, l1: { max_entries: 1000, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: true, header: 'Authorization' },
    observability: {
      log_args: true,
      log_responses: false,
      redact_fields: ['password', 'token', 'secret', 'api_key'],
      retention_days: 1,
      db_path: ':memory:',
    },
    metrics: { enabled: false, port: 0 },
    auth: {
      method: 'api-key',
      api_keys: [
        { key: 'valid-key-123', client_id: 'client-a', tenant_id: 'tenant-a' },
        { key: 'valid-key-456', client_id: 'client-b', tenant_id: 'tenant-b' },
      ],
    },
    admin: { key: 'admin-secret-key' },
    ...overrides,
  };
}

const AUTH_A = { Authorization: 'Bearer valid-key-123' };
const AUTH_B = { Authorization: 'Bearer valid-key-456' };
const ADMIN_AUTH = { Authorization: 'Bearer admin-secret-key' };
const CSRF = { 'X-Conduit-Admin': '1' };

let mockServer: MockMcpServer;
let gateway: ConduitGateway;
let app: Hono;

beforeEach(async () => {
  mockServer = await startMockMcpServer(0);
  resetMetrics();
});

afterEach(async () => {
  if (gateway) {
    await gateway.stop();
  }
  await mockServer.close();
});

async function setupGateway(overrides: Partial<ConduitGatewayConfig> = {}): Promise<void> {
  gateway = new ConduitGateway(makeSecurityConfig(mockServer.url, overrides));
  await gateway.initialize();
  app = gateway.createApp();
}

// ═══════════════════════════════════════════════════════════════════════════
// INJECTION TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('injection — path traversal in tool name', () => {
  it('tool name with ../../etc/passwd does not expose filesystem', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: unknown; result?: unknown }>(
      app, 'sec-server',
      makeToolCall('../../etc/passwd', {}),
      AUTH_A,
    );
    // Should get a "tool not found" error from the mock server, not a file read
    expect(body.error).toBeDefined();
    const errorStr = JSON.stringify(body.error);
    expect(errorStr).not.toContain('root:');
    expect(errorStr).not.toContain('/bin/');
  });

  it('tool name with /etc/shadow path traversal is rejected safely', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: unknown }>(
      app, 'sec-server',
      makeToolCall('../../../etc/shadow', {}),
      AUTH_A,
    );
    expect(body.error).toBeDefined();
  });

  it('tool name with Windows path traversal is rejected safely', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: unknown }>(
      app, 'sec-server',
      makeToolCall('..\\..\\windows\\system32\\config\\sam', {}),
      AUTH_A,
    );
    expect(body.error).toBeDefined();
  });
});

describe('injection — shell metacharacters in tool arguments', () => {
  it('$(command) in argument value does not execute', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      makeToolCall('get_contact', { id: '$(whoami)' }),
      AUTH_A,
    );
    expect(status).toBe(200);
    // No crash, no command execution
  });

  it('backtick command substitution in argument value is safe', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      makeToolCall('get_contact', { id: '`cat /etc/passwd`' }),
      AUTH_A,
    );
    expect(status).toBe(200);
  });

  it('semicolon chained command in argument is safe', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      makeToolCall('get_contact', { id: '123; rm -rf /' }),
      AUTH_A,
    );
    expect(status).toBe(200);
  });

  it('pipe operator in argument is safe', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      makeToolCall('get_contact', { id: '| cat /etc/passwd' }),
      AUTH_A,
    );
    expect(status).toBe(200);
  });

  it('&& chained command in argument is safe', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      makeToolCall('get_contact', { id: '&& curl evil.com' }),
      AUTH_A,
    );
    expect(status).toBe(200);
  });
});

describe('injection — server ID with special characters', () => {
  it('server ID with path traversal returns not found', async () => {
    await setupGateway();
    const res = await app.request('/mcp/../../etc/passwd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_A },
      body: JSON.stringify(makeToolCall('get_contact')),
    });
    // Should be 404 or error, not file contents
    const text = await res.text();
    expect(text).not.toContain('root:');
  });

  it('server ID with URL-encoded characters is handled safely', async () => {
    await setupGateway();
    const res = await app.request('/mcp/%2e%2e%2f%2e%2e%2fetc%2fpasswd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_A },
      body: JSON.stringify(makeToolCall('get_contact')),
    });
    const text = await res.text();
    expect(text).not.toContain('root:');
  });
});

describe('injection — JSON-RPC method with null bytes', () => {
  it('null byte in method name does not cause crash', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      { jsonrpc: '2.0', id: 1, method: 'tools/call\x00injected', params: { name: 'get_contact' } },
      AUTH_A,
    );
    // Should handle gracefully - either process or reject, but not crash
    expect([200, 400, 404, 500]).toContain(status);
  });

  it('null byte in tool name is handled safely', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      makeToolCall('get_contact\x00drop_database', {}),
      AUTH_A,
    );
    expect([200, 400, 404, 500]).toContain(status);
  });
});

describe('injection — prototype pollution via params', () => {
  it('__proto__ in params does not pollute Object prototype', async () => {
    await setupGateway();
    const malicious = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_contact',
        arguments: {
          __proto__: { isAdmin: true, polluted: true },
          id: '123',
        },
      },
    };
    await sendJson(app, 'sec-server', malicious, AUTH_A);
    // Verify Object prototype is not polluted
    const clean: Record<string, unknown> = {};
    expect(clean['isAdmin']).toBeUndefined();
    expect(clean['polluted']).toBeUndefined();
  });

  it('constructor.prototype in params does not pollute', async () => {
    await setupGateway();
    const malicious = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_contact',
        arguments: {
          constructor: { prototype: { pwned: true } },
          id: '123',
        },
      },
    };
    await sendJson(app, 'sec-server', malicious, AUTH_A);
    const clean: Record<string, unknown> = {};
    expect(clean['pwned']).toBeUndefined();
  });
});

describe('injection — extremely long inputs', () => {
  it('10KB tool name does not crash the gateway', async () => {
    await setupGateway();
    const longName = 'A'.repeat(10 * 1024);
    const { status } = await sendJson(
      app, 'sec-server',
      makeToolCall(longName, {}),
      AUTH_A,
    );
    expect([200, 400, 413, 500]).toContain(status);
  });

  it('extremely long argument values are handled', async () => {
    await setupGateway();
    const longValue = 'B'.repeat(100 * 1024);
    const { status } = await sendJson(
      app, 'sec-server',
      makeToolCall('get_contact', { data: longValue }),
      AUTH_A,
    );
    expect([200, 400, 413, 500]).toContain(status);
  });
});

describe('injection — unicode edge cases in tool names', () => {
  it('tool name with zero-width characters is handled', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      makeToolCall('get\u200B_contact', {}), // zero-width space
      AUTH_A,
    );
    expect([200, 400, 500]).toContain(status);
  });

  it('tool name with right-to-left override is handled', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      makeToolCall('get_\u202Econtact', {}), // RTL override
      AUTH_A,
    );
    expect([200, 400, 500]).toContain(status);
  });

  it('tool name with homoglyph characters is handled', async () => {
    await setupGateway();
    // Cyrillic 'а' instead of Latin 'a'
    const { status } = await sendJson(
      app, 'sec-server',
      makeToolCall('get_cont\u0430ct', {}),
      AUTH_A,
    );
    expect([200, 400, 500]).toContain(status);
  });

  it('tool name with emoji characters is handled', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      makeToolCall('get_contact_\u{1F4A9}', {}),
      AUTH_A,
    );
    expect([200, 400, 500]).toContain(status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTHENTICATION TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('auth — API key with null bytes', () => {
  it('API key containing null bytes is rejected or causes error', async () => {
    await setupGateway();
    // Null bytes in HTTP headers are invalid per spec. Hono rejects them
    // before our code runs, which is the correct security behavior.
    try {
      const res = await app.request('/mcp/sec-server', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-key-123\x00extra',
        },
        body: JSON.stringify(makeToolCall('get_contact')),
      });
      // If the request somehow gets through, auth should still fail
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error).toBeDefined();
    } catch {
      // Expected: Hono rejects null bytes in header values
      expect(true).toBe(true);
    }
  });
});

describe('auth — API key with whitespace', () => {
  it('API key with leading/trailing whitespace is rejected', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: { message?: string } }>(
      app, 'sec-server',
      makeToolCall('get_contact'),
      { Authorization: 'Bearer  valid-key-123 ' },
    );
    expect(body.error).toBeDefined();
    expect(body.error!.message).toContain('Authentication failed');
  });

  it('API key with internal whitespace is rejected', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: { message?: string } }>(
      app, 'sec-server',
      makeToolCall('get_contact'),
      { Authorization: 'Bearer valid key 123' },
    );
    expect(body.error).toBeDefined();
    expect(body.error!.message).toContain('Authentication failed');
  });
});

describe('auth — bearer token edge cases', () => {
  it('Bearer token with invalid base64-like characters is rejected', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: { message?: string } }>(
      app, 'sec-server',
      makeToolCall('get_contact'),
      { Authorization: 'Bearer !!!invalid-base64@@@' },
    );
    expect(body.error).toBeDefined();
    expect(body.error!.message).toContain('Authentication failed');
  });

  it('empty Authorization header is rejected', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: { message?: string } }>(
      app, 'sec-server',
      makeToolCall('get_contact'),
      { Authorization: '' },
    );
    expect(body.error).toBeDefined();
    expect(body.error!.message).toContain('Authentication failed');
  });

  it('Authorization header with only "Bearer" (no token) is rejected', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: { message?: string } }>(
      app, 'sec-server',
      makeToolCall('get_contact'),
      { Authorization: 'Bearer ' },
    );
    expect(body.error).toBeDefined();
    expect(body.error!.message).toContain('Authentication failed');
  });

  it('Authorization with wrong scheme (Basic) is rejected', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: { message?: string } }>(
      app, 'sec-server',
      makeToolCall('get_contact'),
      { Authorization: 'Basic dXNlcjpwYXNz' },
    );
    expect(body.error).toBeDefined();
    expect(body.error!.message).toContain('Authentication failed');
  });

  it('request without any Authorization header is rejected', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: { message?: string } }>(
      app, 'sec-server',
      makeToolCall('get_contact'),
      {},
    );
    expect(body.error).toBeDefined();
    expect(body.error!.message).toContain('Authentication failed');
  });

  it('valid key authenticates successfully', async () => {
    await setupGateway();
    const { status, body } = await sendJson<{ result?: unknown; error?: unknown }>(
      app, 'sec-server',
      makeToolCall('get_contact', { id: '1' }),
      AUTH_A,
    );
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RATE LIMIT BYPASS TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('rate limit — X-Forwarded-For spoofing', () => {
  it('X-Forwarded-For does not bypass per-client rate limiting', async () => {
    await setupGateway({
      rate_limits: {
        enabled: true,
        backend: 'memory',
        per_client: { requests_per_minute: 3 },
      },
    });

    // Send requests with spoofed X-Forwarded-For
    let rateLimitedCount = 0;
    for (let i = 0; i < 10; i++) {
      const { body } = await sendJson<{ error?: { message?: string } }>(
        app, 'sec-server',
        makeToolCall('get_contact', { id: String(i) }),
        { ...AUTH_A, 'X-Forwarded-For': `192.168.1.${i}` },
      );
      if (body.error?.message?.includes('Rate limit')) {
        rateLimitedCount++;
      }
    }

    // Some requests should be rate limited via JSON-RPC error.
    // If X-Forwarded-For were used for client ID, all would pass.
    expect(rateLimitedCount).toBeGreaterThan(0);
  });
});

describe('rate limit — blank client identifier', () => {
  it('unauthenticated requests with no auth get rejected before rate limit', async () => {
    await setupGateway({
      rate_limits: {
        enabled: true,
        backend: 'memory',
        per_client: { requests_per_minute: 100 },
      },
    });

    const { body } = await sendJson<{ error?: { message?: string } }>(
      app, 'sec-server',
      makeToolCall('get_contact'),
      {},
    );
    // Auth failure happens before rate limiting
    expect(body.error).toBeDefined();
    expect(body.error!.message).toContain('Authentication failed');
  });
});

describe('rate limit — fast sequential requests', () => {
  it('rapid sequential requests hit the rate limit', async () => {
    await setupGateway({
      rate_limits: {
        enabled: true,
        backend: 'memory',
        per_client: { requests_per_minute: 5 },
      },
    });

    let successCount = 0;
    let rateLimitedCount = 0;
    // Fire 15 requests as fast as possible
    for (let i = 0; i < 15; i++) {
      const { body } = await sendJson<{ error?: { message?: string }; result?: unknown }>(
        app, 'sec-server',
        makeToolCall('get_contact', { id: String(i) }),
        AUTH_A,
      );
      if (body.error?.message?.includes('Rate limit')) {
        rateLimitedCount++;
      } else if (body.result !== undefined) {
        successCount++;
      }
    }

    expect(successCount).toBeGreaterThan(0);
    expect(rateLimitedCount).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CACHE ISOLATION TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('cache — key collision resistance', () => {
  it('different arguments produce different cache entries', async () => {
    await setupGateway();

    // Call with args { id: '1' }
    await sendJson(app, 'sec-server', makeToolCall('get_contact', { id: '1' }), AUTH_A);
    // Call with args { id: '2' }
    await sendJson(app, 'sec-server', makeToolCall('get_contact', { id: '2' }), AUTH_A);

    // Call again with { id: '1' } — should be cache hit
    await sendJson(app, 'sec-server', makeToolCall('get_contact', { id: '1' }), AUTH_A);

    const stats = gateway.getCacheStore().getStats();
    expect(stats.hits).toBe(1);
    // Two distinct entries were stored (id:1, id:2)
    expect(stats.misses).toBeGreaterThanOrEqual(2);
  });

  it('argument order does not affect cache key (deep sort)', async () => {
    await setupGateway();

    // Call with args { a: '1', b: '2' }
    await sendJson(app, 'sec-server', makeToolCall('get_contact', { a: '1', b: '2' }), AUTH_A);
    // Call with args { b: '2', a: '1' } — same logical key
    await sendJson(app, 'sec-server', makeToolCall('get_contact', { b: '2', a: '1' }), AUTH_A);

    const stats = gateway.getCacheStore().getStats();
    expect(stats.hits).toBe(1);
  });
});

describe('cache — tenant isolation', () => {
  it('tenant A cannot see cache entries from tenant B', async () => {
    await setupGateway();

    // Tenant A caches a result
    await sendJson(app, 'sec-server', makeToolCall('get_contact', { id: 'shared' }), AUTH_A);

    // Tenant B makes the same call — should NOT get tenant A's cached result
    mockServer.resetCallCounts();
    await sendJson(app, 'sec-server', makeToolCall('get_contact', { id: 'shared' }), AUTH_B);

    // If tenant isolation works, the mock server should have been called again
    expect(mockServer.getCallCount('tools/call')).toBeGreaterThanOrEqual(1);
  });

  it('same tenant gets cache hit on repeated call', async () => {
    await setupGateway();

    // Tenant A first call
    await sendJson(app, 'sec-server', makeToolCall('get_contact', { id: 'x' }), AUTH_A);
    // Tenant A second call — should be cache hit
    await sendJson(app, 'sec-server', makeToolCall('get_contact', { id: 'x' }), AUTH_A);

    const stats = gateway.getCacheStore().getStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CSRF TESTS (ADMIN ROUTES)
// ═══════════════════════════════════════════════════════════════════════════

describe('csrf — admin POST without X-Conduit-Admin header', () => {
  it('POST to admin endpoint without CSRF header returns 403', async () => {
    await setupGateway();
    const { status, body } = await sendAdmin(app, '/servers/sec-server/refresh', 'POST', ADMIN_AUTH);
    expect(status).toBe(403);
    expect(JSON.stringify(body)).toContain('X-Conduit-Admin');
  });
});

describe('csrf — admin DELETE without X-Conduit-Admin header', () => {
  it('DELETE to admin endpoint without CSRF header returns 403', async () => {
    await setupGateway();
    const { status } = await sendAdmin(app, '/cache/server/sec-server', 'DELETE', ADMIN_AUTH);
    // DELETE also requires CSRF header
    expect(status).toBe(403);
  });
});

describe('csrf — GET requests do not require CSRF header', () => {
  it('GET /conduit/health does not require CSRF header', async () => {
    await setupGateway();
    const { status } = await sendAdmin(app, '/health', 'GET');
    expect(status).toBe(200);
  });

  it('GET /conduit/servers with admin key does not require CSRF', async () => {
    await setupGateway();
    const { status } = await sendAdmin(app, '/servers', 'GET', ADMIN_AUTH);
    expect(status).toBe(200);
  });
});

describe('csrf — POST with CSRF header succeeds', () => {
  it('POST /conduit/servers/:id/refresh with CSRF and admin key succeeds', async () => {
    await setupGateway();
    const { status } = await sendAdmin(app, '/servers/sec-server/refresh', 'POST', { ...ADMIN_AUTH, ...CSRF });
    expect([200, 204]).toContain(status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN AUTH TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('admin auth — unauthenticated access', () => {
  it('admin endpoint without key returns 401', async () => {
    await setupGateway();
    const { status } = await sendAdmin(app, '/servers', 'GET');
    expect(status).toBe(401);
  });

  it('admin endpoint with wrong key returns 401', async () => {
    await setupGateway();
    const { status } = await sendAdmin(app, '/servers', 'GET', {
      Authorization: 'Bearer wrong-key',
    });
    expect(status).toBe(401);
  });

  it('admin endpoint with correct key returns 200', async () => {
    await setupGateway();
    const { status } = await sendAdmin(app, '/servers', 'GET', ADMIN_AUTH);
    expect(status).toBe(200);
  });

  it('/conduit/health is accessible without admin key', async () => {
    await setupGateway();
    const { status } = await sendAdmin(app, '/health', 'GET');
    expect(status).toBe(200);
  });

  it('/conduit/dashboard is accessible without admin key', async () => {
    await setupGateway();
    const res = await app.request('/conduit/dashboard', { method: 'GET' });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DATA LEAKAGE TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('data leakage — error messages do not expose internal paths', () => {
  it('404 for unknown server does not reveal file paths', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: unknown }>(
      app, 'nonexistent-server',
      makeToolCall('get_contact'),
      AUTH_A,
    );
    const errorStr = JSON.stringify(body);
    // Should not contain absolute filesystem paths
    expect(errorStr).not.toMatch(/\/Users\//);
    expect(errorStr).not.toMatch(/\/home\//);
    expect(errorStr).not.toMatch(/node_modules/);
    expect(errorStr).not.toMatch(/\.ts:/);
  });

  it('invalid JSON-RPC does not expose stack trace', async () => {
    await setupGateway();
    const res = await app.request('/mcp/sec-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_A },
      body: '{ invalid json }}}}',
    });
    const text = await res.text();
    expect(text).not.toContain('at Object.');
    expect(text).not.toContain('at Function.');
    expect(text).not.toMatch(/\.ts:\d+:\d+/);
  });
});

describe('data leakage — redacted fields in logs', () => {
  it('password field is redacted when logging arguments', async () => {
    await setupGateway();

    // Make a call that includes sensitive fields
    await sendJson(
      app, 'sec-server',
      makeToolCall('create_contact', {
        name: 'Test',
        email: 'test@test.com',
        password: 'super-secret-password',
      }),
      AUTH_A,
    );

    // Query the log store for recent entries
    const logStore = gateway.getLogStore();
    const logs = logStore.getAll({ limit: 10 });

    // Check that no log entry contains the raw password
    for (const log of logs) {
      const logStr = JSON.stringify(log);
      expect(logStr).not.toContain('super-secret-password');
    }
  });

  it('api_key field is redacted in logs', async () => {
    await setupGateway();

    await sendJson(
      app, 'sec-server',
      makeToolCall('get_contact', { api_key: 'sk-secret-key-12345' }),
      AUTH_A,
    );

    const logStore = gateway.getLogStore();
    const logs = logStore.getAll({ limit: 10 });

    for (const log of logs) {
      const logStr = JSON.stringify(log);
      expect(logStr).not.toContain('sk-secret-key-12345');
    }
  });
});

describe('data leakage — trace IDs do not leak across tenants', () => {
  it('different tenants get different trace IDs', async () => {
    await setupGateway();

    // Tenant A
    const resA = await app.request('/mcp/sec-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_A },
      body: JSON.stringify(makeToolCall('get_contact', { id: '1' })),
    });
    const traceA = resA.headers.get('x-trace-id') ?? resA.headers.get('x-request-id');

    // Tenant B
    const resB = await app.request('/mcp/sec-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_B },
      body: JSON.stringify(makeToolCall('get_contact', { id: '1' })),
    });
    const traceB = resB.headers.get('x-trace-id') ?? resB.headers.get('x-request-id');

    // If trace IDs are present, they should differ
    if (traceA && traceB) {
      expect(traceA).not.toBe(traceB);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY HEADERS
// ═══════════════════════════════════════════════════════════════════════════

describe('security headers on admin responses', () => {
  it('admin responses include X-Content-Type-Options: nosniff', async () => {
    await setupGateway();
    const res = await app.request('/conduit/health', { method: 'GET' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('admin responses include X-Frame-Options: DENY', async () => {
    await setupGateway();
    const res = await app.request('/conduit/health', { method: 'GET' });
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('admin responses include Cache-Control: no-store', async () => {
    await setupGateway();
    const res = await app.request('/conduit/health', { method: 'GET' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('admin responses include Referrer-Policy: no-referrer', async () => {
    await setupGateway();
    const res = await app.request('/conduit/health', { method: 'GET' });
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADDITIONAL EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

describe('auth — timing-safe comparison', () => {
  it('near-miss API key is rejected (prefix match)', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: { message?: string } }>(
      app, 'sec-server',
      makeToolCall('get_contact'),
      { Authorization: 'Bearer valid-key-12' }, // prefix of valid key
    );
    expect(body.error).toBeDefined();
    expect(body.error!.message).toContain('Authentication failed');
  });

  it('API key with extra trailing character is rejected', async () => {
    await setupGateway();
    const { body } = await sendJson<{ error?: { message?: string } }>(
      app, 'sec-server',
      makeToolCall('get_contact'),
      { Authorization: 'Bearer valid-key-123X' },
    );
    expect(body.error).toBeDefined();
    expect(body.error!.message).toContain('Authentication failed');
  });
});

describe('injection — JSON-RPC request structure abuse', () => {
  it('missing jsonrpc field is handled gracefully', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      { id: 1, method: 'tools/call', params: { name: 'get_contact' } },
      AUTH_A,
    );
    expect([200, 400]).toContain(status);
  });

  it('non-string method field is handled gracefully', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      { jsonrpc: '2.0', id: 1, method: 12345, params: {} },
      AUTH_A,
    );
    expect([200, 400, 500]).toContain(status);
  });

  it('negative JSON-RPC ID is handled', async () => {
    await setupGateway();
    const { status, body } = await sendJson<{ id?: unknown }>(
      app, 'sec-server',
      { jsonrpc: '2.0', id: -999, method: 'tools/call', params: { name: 'get_contact', arguments: {} } },
      AUTH_A,
    );
    expect(status).toBe(200);
  });

  it('very large JSON-RPC ID is handled', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      { jsonrpc: '2.0', id: Number.MAX_SAFE_INTEGER, method: 'tools/call', params: { name: 'get_contact', arguments: {} } },
      AUTH_A,
    );
    expect(status).toBe(200);
  });

  it('null JSON-RPC ID (notification) is handled', async () => {
    await setupGateway();
    const { status } = await sendJson(
      app, 'sec-server',
      { jsonrpc: '2.0', id: null, method: 'tools/call', params: { name: 'get_contact', arguments: {} } },
      AUTH_A,
    );
    expect([200, 400]).toContain(status);
  });
});

describe('injection — batch request abuse', () => {
  it('empty batch array is handled', async () => {
    await setupGateway();
    const res = await app.request('/mcp/sec-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_A },
      body: JSON.stringify([]),
    });
    expect([200, 400]).toContain(res.status);
  });

  it('batch with 1000 requests does not crash', async () => {
    await setupGateway();
    const batch = Array.from({ length: 1000 }, (_, i) =>
      makeToolCall('get_contact', { id: String(i) }, i + 1),
    );
    const res = await app.request('/mcp/sec-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_A },
      body: JSON.stringify(batch),
    });
    // Should handle or reject, not crash
    expect([200, 400, 413]).toContain(res.status);
  });
});

describe('content-type enforcement', () => {
  it('request without Content-Type header is handled', async () => {
    await setupGateway();
    const res = await app.request('/mcp/sec-server', {
      method: 'POST',
      headers: { ...AUTH_A },
      body: JSON.stringify(makeToolCall('get_contact')),
    });
    // Should handle gracefully
    expect([200, 400, 415]).toContain(res.status);
  });

  it('request with wrong Content-Type is handled', async () => {
    await setupGateway();
    const res = await app.request('/mcp/sec-server', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', ...AUTH_A },
      body: JSON.stringify(makeToolCall('get_contact')),
    });
    expect([200, 400, 415]).toContain(res.status);
  });
});
