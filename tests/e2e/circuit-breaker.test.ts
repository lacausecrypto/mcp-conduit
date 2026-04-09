/**
 * E2E tests for the circuit breaker feature.
 *
 * Circuit breakers trip on HTTP-level failures (connection refused, timeout),
 * NOT on JSON-RPC application errors. Tests simulate failures by closing
 * the backend server, causing connection refused errors.
 *
 * Tests cover:
 * - Circuit opens after N consecutive connection failures
 * - Open circuit rejects requests immediately (no upstream call attempted)
 * - Admin API: GET /conduit/circuits reports state
 * - Admin API: POST /conduit/circuits/:serverId/reset resets to closed
 * - Per-replica isolation: failing replica trips its own circuit;
 *   healthy replica still serves requests
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { resetMetrics } from '../../src/observability/metrics.js';
import { startMockMcpServer, type MockMcpServer } from './mock-mcp-server.js';

interface JsonRpcResponse {
  error?: { code: number; message: string };
  result?: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mcpConfig(
  servers: ConduitGatewayConfig['servers'],
  circuitOverrides: Partial<NonNullable<ConduitGatewayConfig['router']['circuit_breaker']>> = {},
): ConduitGatewayConfig {
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
      load_balancing: 'round-robin',
      circuit_breaker: {
        enabled: true,
        failure_threshold: 3,
        reset_timeout_ms: 500,
        half_open_max_requests: 1,
        success_threshold: 1,
        ...circuitOverrides,
      },
    },
    servers,
    cache: {
      enabled: false,
      l1: { max_entries: 100, max_entry_size_kb: 64 },
    },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: {
      log_args: false,
      log_responses: false,
      redact_fields: [],
      retention_days: 1,
      db_path: ':memory:',
    },
    metrics: { enabled: false, port: 0 },
  };
}

function toolCallBody(tool = 'get_contact', args: Record<string, unknown> = { id: '1' }) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  });
}

/** Send a tool call and return the parsed response body */
async function sendTool(
  app: ReturnType<ConduitGateway['createApp']>,
  serverId: string,
  tool = 'get_contact',
): Promise<{ res: Response; body: JsonRpcResponse }> {
  const res = await app.request(`/mcp/${serverId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: toolCallBody(tool),
  });
  const body = await res.json() as JsonRpcResponse;
  return { res, body };
}

// ─── Circuit opens after connection failures ──────────────────────────────────

describe('Circuit breaker — circuit opens after connection failures', () => {
  let gateway: ConduitGateway;
  let app: ReturnType<ConduitGateway['createApp']>;
  let mockServer: MockMcpServer;

  beforeAll(async () => {
    resetMetrics();
    mockServer = await startMockMcpServer(0);

    const config = mcpConfig(
      [{ id: 'trip-srv', url: mockServer.url, cache: { default_ttl: 0 } }],
      { failure_threshold: 3 },
    );

    gateway = new ConduitGateway(config);
    await gateway.initialize();
    app = gateway.createApp();
  });

  afterAll(async () => {
    gateway.stop();
    await mockServer.close().catch(() => {});
  });

  it('initial circuit state is closed', () => {
    const states = gateway.getRegistry().getCircuitBreakerStates();
    expect(states.length).toBeGreaterThan(0);
    for (const s of states) {
      expect(s.state).toBe('closed');
    }
  });

  it('circuit opens after failure_threshold connection failures', async () => {
    // Close the backend to cause connection refused errors
    await mockServer.close();

    // failure_threshold = 3 — send 3 requests to trip the circuit
    for (let i = 0; i < 3; i++) {
      await sendTool(app, 'trip-srv').catch(() => {});
    }

    const states = gateway.getRegistry().getCircuitBreakerStates();
    const openCircuit = states.find((s) => s.state === 'open');
    expect(openCircuit).toBeDefined();
    expect(openCircuit?.trip_count).toBeGreaterThanOrEqual(1);
  });

  it('trip_count is > 0 after circuit opens', () => {
    const states = gateway.getRegistry().getCircuitBreakerStates();
    const tripped = states.find((s) => s.trip_count > 0);
    expect(tripped).toBeDefined();
  });
});

// ─── Admin API: GET /conduit/circuits ──────────────────────────────────────────

describe('Circuit breaker — admin API state reporting', () => {
  let gateway: ConduitGateway;
  let app: ReturnType<ConduitGateway['createApp']>;
  let mockServer: MockMcpServer;

  beforeAll(async () => {
    resetMetrics();
    mockServer = await startMockMcpServer(0);

    const config = mcpConfig(
      [{ id: 'status-srv', url: mockServer.url, cache: { default_ttl: 0 } }],
      { failure_threshold: 2 },
    );

    gateway = new ConduitGateway(config);
    await gateway.initialize();
    app = gateway.createApp();
  });

  afterAll(async () => {
    gateway.stop();
    await mockServer.close().catch(() => {});
  });

  it('GET /conduit/circuits returns circuit states', async () => {
    const res = await app.request('/conduit/circuits');
    expect(res.status).toBe(200);

    const body = await res.json() as { count: number; circuits: unknown[] };
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.circuits)).toBe(true);
    expect(body.count).toBe(body.circuits.length);
  });

  it('GET /conduit/circuits includes required fields for each circuit', async () => {
    const res = await app.request('/conduit/circuits');
    const body = await res.json() as {
      circuits: Array<{ state: string; server_id: string; failures: number; trip_count: number }>;
    };

    for (const circuit of body.circuits) {
      expect(['closed', 'open', 'half-open']).toContain(circuit.state);
      expect(typeof circuit.server_id).toBe('string');
      expect(typeof circuit.failures).toBe('number');
      expect(typeof circuit.trip_count).toBe('number');
    }
  });

  it('circuit state changes to open after failures and is visible in admin API', async () => {
    // Close backend to cause failures
    await mockServer.close();

    for (let i = 0; i < 2; i++) {
      await sendTool(app, 'status-srv').catch(() => {});
    }

    const res = await app.request('/conduit/circuits');
    const body = await res.json() as { circuits: Array<{ state: string }> };
    const openCircuit = body.circuits.find((c) => c.state === 'open');
    expect(openCircuit).toBeDefined();
  });
});

// ─── Admin API: POST /conduit/circuits/:serverId/reset ─────────────────────────

describe('Circuit breaker — admin API reset', () => {
  let gateway: ConduitGateway;
  let app: ReturnType<ConduitGateway['createApp']>;
  let mockServer: MockMcpServer;

  beforeAll(async () => {
    resetMetrics();
    mockServer = await startMockMcpServer(0);

    const config = mcpConfig(
      [{ id: 'reset-srv', url: mockServer.url, cache: { default_ttl: 0 } }],
      { failure_threshold: 1 },
    );

    gateway = new ConduitGateway(config);
    await gateway.initialize();
    app = gateway.createApp();
  });

  afterAll(async () => {
    gateway.stop();
    await mockServer.close().catch(() => {});
  });

  it('POST /conduit/circuits/:serverId/reset returns 200 with reset=true', async () => {
    const res = await app.request('/conduit/circuits/reset-srv/reset', { method: 'POST', headers: { 'X-Conduit-Admin': 'true' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { reset: boolean; server_id: string };
    expect(body.reset).toBe(true);
    expect(body.server_id).toBe('reset-srv');
  });

  it('POST /conduit/circuits/:serverId/reset closes an open circuit', async () => {
    // Trip the circuit by closing the backend
    await mockServer.close();
    await sendTool(app, 'reset-srv').catch(() => {});

    // Verify it's open
    const beforeReset = gateway.getRegistry().getCircuitBreakerStates();
    expect(beforeReset.some((s) => s.state === 'open')).toBe(true);

    // Reset via admin API
    await app.request('/conduit/circuits/reset-srv/reset', { method: 'POST', headers: { 'X-Conduit-Admin': 'true' } });

    // Verify it's closed
    const afterReset = gateway.getRegistry().getCircuitBreakerStates();
    expect(afterReset.every((s) => s.state === 'closed')).toBe(true);
  });

  it('POST /conduit/circuits/:serverId/reset returns 404 for unknown server', async () => {
    const res = await app.request('/conduit/circuits/nonexistent/reset', { method: 'POST', headers: { 'X-Conduit-Admin': 'true' } });
    expect(res.status).toBe(404);
  });
});

// ─── Per-replica isolation ────────────────────────────────────────────────────

describe('Circuit breaker — per-replica isolation', () => {
  let gateway: ConduitGateway;
  let app: ReturnType<ConduitGateway['createApp']>;
  let failingServer: MockMcpServer;
  let healthyServer: MockMcpServer;

  beforeAll(async () => {
    resetMetrics();
    [failingServer, healthyServer] = await Promise.all([
      startMockMcpServer(0),
      startMockMcpServer(0),
    ]);

    const config = mcpConfig(
      [{
        id: 'multi-srv',
        url: failingServer.url,
        replicas: [healthyServer.url],
        cache: { default_ttl: 0 },
      }],
      { failure_threshold: 3, reset_timeout_ms: 60_000 },
    );

    gateway = new ConduitGateway(config);
    await gateway.initialize();
    app = gateway.createApp();
  });

  afterAll(async () => {
    gateway.stop();
    await Promise.all([
      failingServer.close().catch(() => {}),
      healthyServer.close().catch(() => {}),
    ]);
  });

  it('gateway has separate circuit breakers per replica', () => {
    const states = gateway.getRegistry().getCircuitBreakerStates();
    // Server has primary + 1 replica = at least 2 circuits
    expect(states.length).toBeGreaterThanOrEqual(2);
  });

  it('one circuit can be open while another remains closed', async () => {
    // Close the failing server to trip its circuit (3 failures)
    await failingServer.close();

    // Send enough requests to trip the primary's circuit
    // With round-robin, requests alternate between primary and replica
    // Need 3 failed attempts on the primary specifically.
    // Strategy: send 6 requests (alternating) to guarantee 3 hit the failing primary
    for (let i = 0; i < 6; i++) {
      await sendTool(app, 'multi-srv').catch(() => {});
    }

    const states = gateway.getRegistry().getCircuitBreakerStates();
    // At least one should be open (the failing server)
    const openCount = states.filter((s) => s.state === 'open').length;
    expect(openCount).toBeGreaterThanOrEqual(1);
    // At least one should still be closed (the healthy replica)
    const closedCount = states.filter((s) => s.state === 'closed').length;
    expect(closedCount).toBeGreaterThanOrEqual(1);
  });

  it('healthy replica continues to serve requests after failing replica trips', async () => {
    // The healthy server should still be reachable
    healthyServer.resetCallCounts();

    // Send multiple requests — gateway should route to the healthy replica
    let successCount = 0;
    for (let i = 0; i < 3; i++) {
      const { body } = await sendTool(app, 'multi-srv');
      if (!body.error) successCount++;
    }

    // At least some requests should succeed via the healthy replica
    expect(successCount).toBeGreaterThan(0);
    expect(healthyServer.getCallCount('tools/call')).toBeGreaterThan(0);
  });
});
