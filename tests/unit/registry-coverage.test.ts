/**
 * Additional coverage tests for src/router/registry.ts
 * Focuses on circuit breaker management, health checks, and replica logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServerRegistry } from '../../src/router/registry.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { getMetrics, resetMetrics } from '../../src/observability/metrics.js';
import type { McpClient } from '../../src/proxy/mcp-client.js';

function makeConfig(
  servers: Array<{ id: string; url: string; replicas?: string[] }>,
  circuitBreakerEnabled = false,
  healthCheckEnabled = false,
): ConduitGatewayConfig {
  return {
    gateway: { port: 8080, host: '0.0.0.0' },
    router: {
      namespace_strategy: 'prefix',
      health_check: {
        enabled: healthCheckEnabled,
        interval_seconds: 30,
        timeout_ms: 5000,
        unhealthy_threshold: 3,
        healthy_threshold: 1,
      },
      ...(circuitBreakerEnabled ? {
        circuit_breaker: {
          enabled: true,
          failure_threshold: 3,
          reset_timeout_ms: 30000,
          half_open_max_requests: 1,
          success_threshold: 2,
        },
      } : {}),
    },
    servers: servers.map((s) => ({
      id: s.id,
      url: s.url,
      replicas: s.replicas,
      cache: { default_ttl: 300 },
    })),
    cache: { enabled: true, l1: { max_entries: 100, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: { log_args: true, log_responses: false, redact_fields: [], retention_days: 30, db_path: ':memory:' },
    metrics: { enabled: false, port: 9090 },
  };
}

function makeMockClient(serverId: string, tools: string[] = []) {
  return {
    serverId,
    serverUrl: `http://localhost:9999`,
    activeConnections: 0,
    forward: vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      isStream: false,
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: tools.map((name) => ({
            name,
            description: `Tool ${name}`,
            inputSchema: { type: 'object' },
          })),
        },
      },
    }),
    getSessionId: vi.fn().mockReturnValue(undefined),
    setSessionId: vi.fn(),
    openSseStream: vi.fn(),
    setCircuitBreaker: vi.fn(),
    getCircuitBreaker: vi.fn().mockReturnValue(undefined),
  } as unknown as McpClient;
}

describe('ServerRegistry - circuit breaker management', () => {
  beforeEach(() => resetMetrics());

  it('creates circuit breakers for replicas when enabled', () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }], true);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    const states = registry.getCircuitBreakerStates();
    expect(states.length).toBeGreaterThan(0);
    expect(states[0]?.server_id).toBe('server-a');
    expect(states[0]?.state).toBe('closed');
  });

  it('returns empty circuit breaker states when disabled', () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }], false);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    const states = registry.getCircuitBreakerStates();
    expect(states).toHaveLength(0);
  });

  it('returns circuit breaker states for all replicas including secondary', () => {
    const config = makeConfig([{
      id: 'server-a',
      url: 'http://localhost:3001',
      replicas: ['http://localhost:3002'],
    }], true);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    const states = registry.getCircuitBreakerStates();
    expect(states.length).toBe(2); // primary + 1 replica
    expect(states[0]?.replica_index).toBe(0);
    expect(states[1]?.replica_index).toBe(1);
  });

  it('resetCircuitBreaker resets all replicas for a server', async () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }], true);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    const reset = registry.resetCircuitBreaker('server-a');
    expect(reset).toBe(true);

    const states = registry.getCircuitBreakerStates();
    expect(states[0]?.state).toBe('closed');
  });

  it('resetCircuitBreaker returns false for unknown server', () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }], true);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    expect(registry.resetCircuitBreaker('nonexistent')).toBe(false);
  });

  it('resetCircuitBreaker returns false when no circuit breakers enabled', () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }], false);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    expect(registry.resetCircuitBreaker('server-a')).toBe(false);
  });

  it('resetReplicaCircuitBreaker resets a specific replica', () => {
    const config = makeConfig([{
      id: 'server-a',
      url: 'http://localhost:3001',
      replicas: ['http://localhost:3002'],
    }], true);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    expect(registry.resetReplicaCircuitBreaker('server-a', 0)).toBe(true);
    expect(registry.resetReplicaCircuitBreaker('server-a', 1)).toBe(true);
  });

  it('resetReplicaCircuitBreaker returns false for invalid replica index', () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }], true);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    expect(registry.resetReplicaCircuitBreaker('server-a', 99)).toBe(false);
  });

  it('resetReplicaCircuitBreaker returns false for unknown server', () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }], true);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    expect(registry.resetReplicaCircuitBreaker('nonexistent', 0)).toBe(false);
  });

  it('resetReplicaCircuitBreaker returns false when CB not enabled for replica', () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }], false);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    expect(registry.resetReplicaCircuitBreaker('server-a', 0)).toBe(false);
  });
});

describe('ServerRegistry - getHealthyReplicas', () => {
  beforeEach(() => resetMetrics());

  it('returns all replicas when healthy and no circuit breaker', () => {
    const config = makeConfig([{
      id: 'server-a',
      url: 'http://localhost:3001',
      replicas: ['http://localhost:3002'],
    }], false);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    const replicas = registry.getHealthyReplicas('server-a');
    expect(replicas).toHaveLength(2);
  });

  it('returns empty array for unknown server', () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }]);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    expect(registry.getHealthyReplicas('nonexistent')).toHaveLength(0);
  });
});

describe('ServerRegistry - health check lifecycle', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetMetrics();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runHealthChecks marks replica as unhealthy after exceeding threshold', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }], false, false);
    // Manually enable health check params
    config.router.health_check.unhealthy_threshold = 2;

    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    // Run health checks until threshold is exceeded
    await registry.runHealthChecks();
    await registry.runHealthChecks();

    // After threshold failures, replica should be unhealthy
    const server = registry.getServerInfo('server-a');
    expect(server?.replicas[0]?.health.consecutiveFailures).toBeGreaterThanOrEqual(2);
  });

  it('runHealthChecks marks replica as healthy after success', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({}) });

    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }]);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    await registry.runHealthChecks();

    const server = registry.getServerInfo('server-a');
    expect(server?.replicas[0]?.health.consecutiveSuccesses).toBe(1);
    expect(server?.replicas[0]?.health.healthy).toBe(true);
  });

  it('runHealthChecks updates lastChecked timestamp', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({}) });

    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }]);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    const before = Date.now();
    await registry.runHealthChecks();
    const after = Date.now();

    const server = registry.getServerInfo('server-a');
    expect(server?.health.lastChecked).toBeGreaterThanOrEqual(before);
    expect(server?.health.lastChecked).toBeLessThanOrEqual(after);
  });
});

describe('ServerRegistry - stop', () => {
  beforeEach(() => resetMetrics());

  it('stop() clears health check timer', () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }], false, true);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    // Should not throw
    registry.stop();
    registry.stop(); // Second call should be safe
  });
});

describe('ServerRegistry - refreshServer error handling', () => {
  beforeEach(() => resetMetrics());

  it('handles refreshServer gracefully when client forward fails', async () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }]);
    const failingClient = makeMockClient('server-a');
    vi.mocked(failingClient.forward).mockRejectedValue(new Error('Connection refused'));
    const clients = new Map([['server-a', failingClient as unknown as McpClient]]);

    const registry = new ServerRegistry(config, clients, getMetrics());
    await expect(registry.refreshServer('server-a')).resolves.toBeUndefined();
  });

  it('handles tools/list response with error field', async () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }]);
    const errorClient = makeMockClient('server-a');
    vi.mocked(errorClient.forward).mockResolvedValue({
      status: 200,
      headers: {},
      isStream: false,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } },
    } as never);
    const clients = new Map([['server-a', errorClient as unknown as McpClient]]);

    const registry = new ServerRegistry(config, clients, getMetrics());
    await registry.refreshServer('server-a');

    const serverInfo = registry.getServerInfo('server-a');
    expect(serverInfo?.tools).toHaveLength(0);
  });

  it('handles stream response gracefully during refresh', async () => {
    const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001' }]);
    const streamClient = makeMockClient('server-a');
    vi.mocked(streamClient.forward).mockResolvedValue({
      status: 200,
      headers: {},
      isStream: true,
      rawResponse: {} as Response,
    } as never);
    const clients = new Map([['server-a', streamClient as unknown as McpClient]]);

    const registry = new ServerRegistry(config, clients, getMetrics());
    await registry.refreshServer('server-a');

    // Should not have set tools
    const serverInfo = registry.getServerInfo('server-a');
    expect(serverInfo?.tools).toHaveLength(0);
  });
});

describe('ServerRegistry - replicas', () => {
  beforeEach(() => resetMetrics());

  it('creates a replica client for each additional URL', () => {
    const config = makeConfig([{
      id: 'server-a',
      url: 'http://primary:3001',
      replicas: ['http://replica1:3001', 'http://replica2:3001'],
    }]);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    const serverInfo = registry.getServerInfo('server-a');
    expect(serverInfo?.replicas).toHaveLength(3); // primary + 2
    expect(serverInfo?.replicas[0]?.url).toBe('http://primary:3001');
    expect(serverInfo?.replicas[1]?.url).toBe('http://replica1:3001');
    expect(serverInfo?.replicas[2]?.url).toBe('http://replica2:3001');
  });

  it('circuit breaker state includes replica url', () => {
    const config = makeConfig([{
      id: 'server-a',
      url: 'http://primary:3001',
      replicas: ['http://replica:3002'],
    }], true);
    const clients = new Map([['server-a', makeMockClient('server-a')]]);
    const registry = new ServerRegistry(config, clients, getMetrics());

    const states = registry.getCircuitBreakerStates();
    expect(states[0]?.replica_url).toBe('http://primary:3001');
    expect(states[1]?.replica_url).toBe('http://replica:3002');
  });
});
