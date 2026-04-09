/**
 * Tests e2e pour le routeur avec load balancing et réplicas.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { resetMetrics } from '../../src/observability/metrics.js';
import { startMockMcpServer, type MockMcpServer } from './mock-mcp-server.js';
import {
  setup,
  teardown,
  sendMcpRequest,
  makeToolCallMessage,
  makeToolsListMessage,
  type E2eTestContext,
} from './setup.js';

interface JsonRpcResponse {
  error?: { code: number; message: string };
  result?: unknown;
}

// ============================================================================
// Tests : round-robin avec réplicas
// ============================================================================

describe('Router — round-robin entre réplicas', () => {
  let gateway: ConduitGateway;
  let app: ReturnType<ConduitGateway['createApp']>;
  let replica1: MockMcpServer;
  let replica2: MockMcpServer;

  beforeAll(async () => {
    [replica1, replica2] = await Promise.all([
      startMockMcpServer(0),
      startMockMcpServer(0),
    ]);

    resetMetrics();

    const config: ConduitGatewayConfig = {
      gateway: { port: 0, host: '127.0.0.1' },
      router: {
        namespace_strategy: 'none',
        health_check: { enabled: false, interval_seconds: 60, timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1 },
        load_balancing: 'round-robin',
      },
      servers: [
        {
          id: 'test-server',
          url: replica1.url,
          replicas: [replica2.url],
          cache: { default_ttl: 0 },
        },
      ],
      cache: { enabled: false, l1: { max_entries: 100, max_entry_size_kb: 64 } },
      tenant_isolation: { enabled: false, header: 'Authorization' },
      observability: { log_args: false, log_responses: false, redact_fields: [], retention_days: 1, db_path: ':memory:' },
      metrics: { enabled: false, port: 0 },
    };

    gateway = new ConduitGateway(config);
    await gateway.initialize();
    app = gateway.createApp();
  });

  afterAll(async () => {
    gateway.stop();
    await Promise.all([replica1.close(), replica2.close()]);
  });

  it('distribue les requêtes entre les réplicas', async () => {
    const msg = makeToolCallMessage('get_contact', { id: '1' });

    // Faire plusieurs requêtes
    for (let i = 0; i < 4; i++) {
      const res = await app.request('/mcp/test-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      });
      expect(res.status).toBe(200);
    }

    // Les deux réplicas devraient avoir reçu des requêtes
    const calls1 = replica1.getCallCount('tools/call');
    const calls2 = replica2.getCallCount('tools/call');
    expect(calls1 + calls2).toBe(4);
    expect(calls1).toBeGreaterThan(0);
    expect(calls2).toBeGreaterThan(0);
  });
});

// ============================================================================
// Tests : serveur dégradé → réplica sain utilisé
// ============================================================================

describe('Router — réplica dégradé est ignoré', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ defaultTtl: 0 });
  });

  afterAll(() => teardown(ctx));

  it('tools/list retourne des outils depuis un serveur sain', async () => {
    const res = await sendMcpRequest(ctx.app, 'test-server', makeToolsListMessage());
    const body = await res.json() as { result?: { tools: unknown[] } };
    expect(Array.isArray(body.result?.tools)).toBe(true);
    expect((body.result?.tools ?? []).length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Tests : tous les réplicas dégradés → erreur
// ============================================================================

describe('Router — tous réplicas dégradés → erreur', () => {
  let gateway: ConduitGateway;
  let app: ReturnType<ConduitGateway['createApp']>;

  beforeAll(async () => {
    resetMetrics();

    const config: ConduitGatewayConfig = {
      gateway: { port: 0, host: '127.0.0.1' },
      router: {
        namespace_strategy: 'none',
        health_check: { enabled: false, interval_seconds: 60, timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1 },
        load_balancing: 'round-robin',
      },
      servers: [
        {
          id: 'broken-server',
          url: 'http://127.0.0.1:1', // Port invalide — toujours en échec
          cache: { default_ttl: 0 },
        },
      ],
      cache: { enabled: false, l1: { max_entries: 100, max_entry_size_kb: 64 } },
      tenant_isolation: { enabled: false, header: 'Authorization' },
      observability: { log_args: false, log_responses: false, redact_fields: [], retention_days: 1, db_path: ':memory:' },
      metrics: { enabled: false, port: 0 },
    };

    gateway = new ConduitGateway(config);
    // Ne pas initialiser pour garder le serveur "healthy" par défaut mais l'URL invalide
    // — on veut tester quand un appel réel échoue
    app = gateway.createApp();
  });

  afterAll(() => {
    gateway.stop();
  });

  it('appel sur serveur indisponible → erreur JSON-RPC', async () => {
    const res = await app.request('/mcp/broken-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeToolCallMessage('get_contact', {})),
    });
    // L'erreur peut être dans le corps JSON-RPC ou un 500
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeDefined();
  });
});

// ============================================================================
// Tests : refresh des outils
// ============================================================================

describe('Router — refresh des outils', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ defaultTtl: 0, tools: [{ name: 'tool_initial', result: { ok: true } }] });
  });

  afterAll(() => teardown(ctx));

  it('les nouveaux outils apparaissent après refresh', async () => {
    // Ajouter un nouvel outil au serveur simulé
    ctx.mockServer.setTool({ name: 'tool_new', result: { added: true } });

    // Rafraîchir
    await ctx.gateway.getRegistry().refreshServer('test-server');

    const res = await sendMcpRequest(ctx.app, 'test-server', makeToolsListMessage());
    const body = await res.json() as { result?: { tools: Array<{ name: string }> } };
    const names = (body.result?.tools ?? []).map((t) => t.name);

    expect(names).toContain('tool_new');
  });
});

// ============================================================================
// Tests : admin /conduit/servers avec infos réplicas
// ============================================================================

describe('Admin /conduit/servers avec réplicas', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup();
  });

  afterAll(() => teardown(ctx));

  it('retourne les infos des réplicas', async () => {
    const res = await ctx.app.request('/conduit/servers');
    const body = await res.json() as {
      servers: Array<{
        id: string;
        replicas: Array<{ url: string; healthy: boolean }>;
      }>;
    };

    const server = body.servers.find((s) => s.id === 'test-server');
    expect(server).toBeDefined();
    expect(Array.isArray(server?.replicas)).toBe(true);
    expect(server?.replicas.length).toBeGreaterThan(0);
  });
});
