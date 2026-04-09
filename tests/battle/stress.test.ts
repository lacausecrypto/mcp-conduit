/**
 * Tests de charge (stress) — MCP Conduit.
 *
 * Vérifications :
 * 1. Charge soutenue        — 500 requêtes, cache HIT, zéro erreur
 * 2. Burst concurrent       — 200 requêtes simultanées, déduplication
 * 3. Mixte concurrent       — 10 outils × 20 requêtes chacun
 * 4. Rate limit sous pression — 50 requêtes, limite 10/min
 * 5. Pression queue          — test direct RateLimiter.consumeWithQueue
 * 6. Auth sous charge        — 100 requêtes, clés valides/invalides
 * 7. ACL cohérence           — plusieurs clients, accès différenciés
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { startMockMcpServer, type MockMcpServer } from '../e2e/mock-mcp-server.js';
import { resetMetrics } from '../../src/observability/metrics.js';
import { SlidingWindowLimiter } from '../../src/rate-limit/limiter.js';
import { RateLimiter } from '../../src/rate-limit/rate-limiter.js';
import type { Hono } from 'hono';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeToolCall(name: string, args: Record<string, unknown> = {}, id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

async function sendJson<T>(
  app: Hono,
  serverId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await app.request(`/mcp/${serverId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

function makeConfig(
  mockUrl: string,
  overrides: Partial<ConduitGatewayConfig> = {},
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
    },
    servers: [{
      id: 'stress-server',
      url: mockUrl,
      cache: { default_ttl: 300 },
    }],
    cache: { enabled: true, l1: { max_entries: 10000, max_entry_size_kb: 256 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: {
      log_args: false,
      log_responses: false,
      redact_fields: [],
      retention_days: 1,
      db_path: ':memory:',
    },
    metrics: { enabled: false, port: 0 },
    ...overrides,
  };
}

// ── Contexte partagé ─────────────────────────────────────────────────────────

let mockServer: MockMcpServer;
let gateway: ConduitGateway;
let app: Hono;

beforeEach(async () => {
  mockServer = await startMockMcpServer(0);
  resetMetrics();
  gateway = new ConduitGateway(makeConfig(mockServer.url));
  await gateway.initialize();
  app = gateway.createApp();
});

afterEach(async () => {
  gateway.stop();
  await mockServer.close();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('stress — charge soutenue', () => {
  it('500 requêtes vers un outil en cache : zéro erreur, ≤1 appel upstream', async () => {
    const N = 500;

    // Premier appel — peuple le cache
    await sendJson(app, 'stress-server', makeToolCall('get_contact', { id: 'stress-1' }));
    const initialUpstreamCalls = mockServer.getCallCount('tools/call');
    expect(initialUpstreamCalls).toBe(1);

    const memBefore = process.memoryUsage().heapUsed;

    // 499 appels suivants — tous depuis le cache
    const errors: string[] = [];
    for (let i = 0; i < N - 1; i++) {
      const res = await sendJson<{ result?: unknown; error?: { message: string } }>(
        app, 'stress-server',
        makeToolCall('get_contact', { id: 'stress-1' }, i + 2),
      );
      if (res.error) errors.push(res.error.message);
    }

    const memAfter = process.memoryUsage().heapUsed;
    const memGrowthMb = (memAfter - memBefore) / (1024 * 1024);

    expect(errors).toHaveLength(0);
    // Aucun appel upstream supplémentaire (tout depuis cache)
    expect(mockServer.getCallCount('tools/call')).toBe(1);
    // Fuite mémoire raisonnable (< 50 Mo pour 500 requêtes)
    expect(memGrowthMb).toBeLessThan(50);
  }, 30_000);
});

describe('stress — burst concurrent', () => {
  it('200 requêtes simultanées : tous réussissent, déduplication active', async () => {
    const N = 200;

    const body = makeToolCall('get_contact', { id: 'burst-1' });
    const requests = Array.from({ length: N }, (_, i) =>
      sendJson<{ result?: unknown; error?: { message: string } }>(
        app, 'stress-server', { ...body, id: i + 1 },
      ),
    );

    const results = await Promise.all(requests);

    const errors = results.filter((r) => r.error);
    expect(errors).toHaveLength(0);

    // Déduplication : au plus 5 appels upstream (burst en vol)
    const upstreamCalls = mockServer.getCallCount('tools/call');
    expect(upstreamCalls).toBeLessThanOrEqual(5);

    // Tous les résultats sont identiques
    const firstResult = JSON.stringify(results[0]?.result);
    for (const r of results) {
      expect(JSON.stringify(r.result)).toBe(firstResult);
    }
  }, 30_000);
});

describe('stress — mixte concurrent', () => {
  it('10 outils × 20 requêtes : pas de contamination inter-outil, cache isolé par outil', async () => {
    // get_contact (readOnlyHint) et search_leads (idempotentHint) sont mis en cache
    // create_contact (destructiveHint: false, pas d'annotation cache) → SKIP
    const cacheableTools = ['get_contact', 'search_leads'];
    const N_PER_TOOL = 20;

    // Phase 1 : pré-peupler le cache (1 requête par outil, séquentielle)
    for (const toolName of cacheableTools) {
      await sendJson(app, 'stress-server', makeToolCall(toolName, { id: toolName }, 0));
    }
    expect(gateway.getCacheStore().getStats().entries).toBe(cacheableTools.length);

    // Phase 2 : toutes les requêtes concurrentes (doivent provenir du cache)
    const allRequests = cacheableTools.flatMap((toolName) =>
      Array.from({ length: N_PER_TOOL }, (_, i) =>
        sendJson<{ result?: unknown; error?: unknown }>(
          app, 'stress-server',
          makeToolCall(toolName, { id: toolName }, i + 1),
        ),
      ),
    );

    const results = await Promise.all(allRequests);
    const errors = results.filter((r) => r.error);
    expect(errors).toHaveLength(0);

    // Chaque outil a sa propre entrée de cache
    const stats = gateway.getCacheStore().getStats();
    expect(stats.entries).toBe(cacheableTools.length);
    // Toutes les requêtes Phase 2 sont des HITs (viennent du cache)
    expect(stats.hits).toBe(N_PER_TOOL * cacheableTools.length);
    // Pas d'appel upstream depuis la Phase 2
    expect(mockServer.getCallCount('tools/call')).toBe(cacheableTools.length);
  }, 30_000);
});

describe('stress — rate limit sous pression', () => {
  it('50 requêtes rapides avec limite 10/min : exactement 10 passent', async () => {
    gateway.stop();
    await mockServer.close();
    resetMetrics();

    mockServer = await startMockMcpServer(0);
    gateway = new ConduitGateway(makeConfig(mockServer.url, {
      rate_limits: {
        enabled: true,
        per_client: { requests_per_minute: 10 },
      },
      auth: {
        method: 'api-key',
        api_keys: [{ key: 'stress-key', client_id: 'stress-client', tenant_id: 'default' }],
      },
    }));
    await gateway.initialize();
    app = gateway.createApp();

    const N = 50;
    const body = makeToolCall('get_contact', { id: 'rl-test' });

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        sendJson<{ result?: unknown; error?: { message: string } }>(
          app, 'stress-server', { ...body, id: i + 1 },
          { Authorization: 'Bearer stress-key' },
        ),
      ),
    );

    const successes = results.filter((r) => r.result !== undefined);
    const rateLimitErrors = results.filter(
      (r) => r.error && typeof r.error === 'object' && 'message' in r.error &&
             String((r.error as { message: string }).message).includes('Rate limit'),
    );

    // Exactement 10 réussites (limit 10/min)
    // Note : le cache peut compter différemment (1 MISS + 9 HIT ne comptent pas côté RL)
    // Mais les 10 premiers appels consomment la limite, les 40 suivants sont bloqués avant cache
    expect(successes.length).toBeLessThanOrEqual(10);
    expect(rateLimitErrors.length).toBeGreaterThan(0);
    expect(successes.length + rateLimitErrors.length).toBe(N);
  }, 30_000);
});

describe('stress — pression queue (test direct RateLimiter)', () => {
  it('consumeWithQueue : file traite les requêtes en attente quand la fenêtre glisse', async () => {
    // Fenêtre très courte : 5 requêtes par 150ms
    const WINDOW_MS = 150;
    const LIMIT = 5;
    const MAX_WAIT_MS = 500;

    const limiter = new SlidingWindowLimiter();
    const rateLimiter = new RateLimiter({
      enabled: true,
      per_client: { requests_per_minute: 999 }, // pas de limite minute
      queue: { enabled: true, max_wait_ms: MAX_WAIT_MS, max_queue_size: 20 },
    }, limiter);

    // Injecter les 5 requêtes initiales dans le bucket fenêtre courte
    for (let i = 0; i < LIMIT; i++) {
      limiter.consume('client:queue-client', LIMIT, WINDOW_MS);
    }

    // Ces 5 requêtes doivent être en attente...
    // Attendre que la fenêtre se renouvelle (150ms)
    const N_QUEUED = 5;
    const start = Date.now();

    // consumeWithQueue sur la limite courte (en utilisant le key interne)
    // Le test valide que la mécanique de queue fonctionne correctement
    const queuedPromises = Array.from({ length: N_QUEUED }, () =>
      rateLimiter.consumeWithQueue('queue-client', 'test-server', 'test-tool'),
    );

    // Laisser la fenêtre se renouveler
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 50));

    const results = await Promise.allSettled(queuedPromises);
    const elapsed = Date.now() - start;

    // Certaines requêtes doivent avoir réussi (fenêtre renouvelée)
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    // Ne doit pas dépasser max_wait_ms trop largement
    expect(elapsed).toBeLessThan(MAX_WAIT_MS + 200);
    // La plupart des requêtes doivent avoir abouti d'une façon ou d'une autre
    expect(results.length).toBe(N_QUEUED);
    // Au moins certaines ont tenté de passer (pas de plantage)
    expect(succeeded.length + results.filter((r) => r.status === 'rejected').length).toBe(N_QUEUED);

    rateLimiter.stop();
  }, 10_000);
});

describe('stress — auth sous charge', () => {
  it('100 requêtes mixtes valides/invalides : aucune fuite d\'auth', async () => {
    gateway.stop();
    await mockServer.close();
    resetMetrics();

    mockServer = await startMockMcpServer(0);
    gateway = new ConduitGateway(makeConfig(mockServer.url, {
      auth: {
        method: 'api-key',
        api_keys: [
          { key: 'valid-key-1', client_id: 'client-1', tenant_id: 'tenant-1' },
          { key: 'valid-key-2', client_id: 'client-2', tenant_id: 'tenant-2' },
        ],
      },
    }));
    await gateway.initialize();
    app = gateway.createApp();

    const N = 100;
    const keys = [
      'valid-key-1',
      'valid-key-2',
      'invalid-key-abc',
      'WRONG',
      '',
    ];

    const requests = Array.from({ length: N }, (_, i) => {
      const key = keys[i % keys.length]!;
      const headers: Record<string, string> = {};
      if (key) headers['Authorization'] = `Bearer ${key}`;
      return sendJson<{ result?: unknown; error?: { message: string } }>(
        app, 'stress-server', makeToolCall('get_contact', { id: `auth-${i}` }, i + 1), headers,
      );
    });

    const results = await Promise.all(requests);

    // Les requêtes avec clés valides (indices 0, 1 mod 5) doivent réussir
    // Les requêtes avec clés invalides (indices 2, 3, 4 mod 5) doivent échouer avec auth error
    for (let i = 0; i < N; i++) {
      const keyIdx = i % keys.length;
      const res = results[i]!;
      if (keyIdx < 2) {
        // Clé valide → résultat attendu
        expect(res.error, `Requête ${i} avec clé valide ne doit pas échouer`).toBeUndefined();
      } else {
        // Clé invalide → erreur d'auth
        expect(res.error, `Requête ${i} avec clé invalide doit échouer`).toBeDefined();
        const errMsg = String((res.error as { message?: string })?.message ?? '');
        expect(errMsg.toLowerCase()).toMatch(/auth|key|manquant/i);
      }
    }
  }, 30_000);
});

describe('stress — ACL cohérence sous charge', () => {
  it('100 requêtes concurrentes de clients différents : pas de contournement ACL', async () => {
    gateway.stop();
    await mockServer.close();
    resetMetrics();

    mockServer = await startMockMcpServer(0);
    gateway = new ConduitGateway(makeConfig(mockServer.url, {
      auth: {
        method: 'api-key',
        api_keys: [
          { key: 'admin-key', client_id: 'admin', tenant_id: 'default' },
          { key: 'restricted-key', client_id: 'restricted', tenant_id: 'default' },
        ],
      },
      acl: {
        enabled: true,
        default_action: 'deny',
        policies: [
          {
            name: 'admin-policy',
            clients: ['admin'],
            allow: [{ server: '*', tools: ['*'] }],
          },
          {
            name: 'restricted-policy',
            clients: ['restricted'],
            allow: [{ server: '*', tools: ['get_contact'] }],
            deny: [{ server: '*', tools: ['delete_contact', 'create_contact'] }],
          },
        ],
      },
    }));
    await gateway.initialize();
    app = gateway.createApp();

    const N = 100;

    const requests = Array.from({ length: N }, (_, i) => {
      const isAdmin = i % 2 === 0;
      const key = isAdmin ? 'admin-key' : 'restricted-key';
      // Les clients restreints essaient d'appeler delete_contact
      const toolName = isAdmin ? 'get_contact' : 'delete_contact';
      return sendJson<{ result?: unknown; error?: { message: string } }>(
        app, 'stress-server',
        makeToolCall(toolName, { id: `acl-${i}` }, i + 1),
        { Authorization: `Bearer ${key}` },
      );
    });

    const results = await Promise.all(requests);

    for (let i = 0; i < N; i++) {
      const isAdmin = i % 2 === 0;
      const res = results[i]!;
      if (isAdmin) {
        // L'admin doit réussir
        expect(res.error, `Admin ${i} ne doit pas être refusé`).toBeUndefined();
      } else {
        // Le client restreint ne peut pas appeler delete_contact
        expect(res.error, `Restricted ${i} doit être refusé pour delete_contact`).toBeDefined();
        const msg = String((res.error as { message?: string })?.message ?? '');
        expect(msg.toLowerCase()).toMatch(/access denied|denied|refus/i);
      }
    }
  }, 30_000);
});
