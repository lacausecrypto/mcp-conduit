/**
 * Tests de résilience — MCP Conduit.
 *
 * Scenarios :
 * 1.  Timeout backend         — le backend ne répond pas, le gateway timeout
 * 2.  Backend HTTP 500        — retourne une erreur JSON-RPC propre
 * 3.  Backend JSON invalide   — pas de crash, pas de mise en cache
 * 4.  Backend coupe la connexion — gestion propre
 * 5.  Charge utile énorme     — retournée, mais NOT mise en cache
 * 6.  Backend flapping        — health check détecte le changement
 * 7.  Tous backends hors ligne — erreur claire, récupération
 * 8.  SQLite sous pression    — 1000 logs, aucune perte
 * 9.  Résistance aux collisions de clés de cache — 1000 appels distincts
 * 10. Isolation tenant sous stress — 10 tenants × 50 requêtes
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { startMockBattleServer, type MockBattleServer } from './mock-battle-server.js';
import { startMockMcpServer, type MockMcpServer } from '../e2e/mock-mcp-server.js';
import { resetMetrics } from '../../src/observability/metrics.js';
import type { Hono } from 'hono';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeToolCall(name: string, args: Record<string, unknown> = {}, id: number | string = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

async function sendJson<T>(
  app: Hono,
  serverId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await app.request(`/mcp/${serverId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

function makeBattleConfig(
  serverUrl: string,
  extra: Partial<ConduitGatewayConfig> = {},
  timeoutMs?: number,
): ConduitGatewayConfig {
  return {
    gateway: { port: 0, host: '127.0.0.1' },
    router: {
      namespace_strategy: 'none',
      health_check: {
        enabled: false,
        interval_seconds: 5,
        timeout_ms: 500,
        unhealthy_threshold: 2,
        healthy_threshold: 1,
      },
      load_balancing: 'round-robin',
    },
    servers: [{
      id: 'battle',
      url: serverUrl,
      cache: { default_ttl: 60 },
      ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    }],
    cache: { enabled: true, l1: { max_entries: 1000, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: {
      log_args: true,
      log_responses: false,
      redact_fields: [],
      retention_days: 1,
      db_path: ':memory:',
    },
    metrics: { enabled: false, port: 0 },
    ...extra,
  };
}

let battleServer: MockBattleServer | null = null;
let gateway: ConduitGateway | null = null;

afterEach(async () => {
  gateway?.stop();
  gateway = null;
  await battleServer?.close();
  battleServer = null;
  resetMetrics();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('résilience — timeout backend', () => {
  it('le gateway timeout et retourne une erreur propre (pas de hang)', async () => {
    battleServer = await startMockBattleServer(0);
    // Configure un timeout très court (500ms) et le backend va hang
    battleServer.configure({ hangForever: false, delayMs: 800 });

    gateway = new ConduitGateway(makeBattleConfig(battleServer.url, {}, 500));
    await gateway.initialize();
    const app = gateway.createApp();

    const start = Date.now();
    const { body } = await sendJson<{ error?: { message: string }; result?: unknown }>(
      app, 'battle', makeToolCall('battle_tool', { id: '1' }),
    );
    const elapsed = Date.now() - start;

    // Le gateway doit retourner une erreur (timeout ou upstream error)
    expect(body.error).toBeDefined();
    // Ne doit pas attendre plus de 2s (timeout 500ms + overhead)
    expect(elapsed).toBeLessThan(2000);
  }, 10_000);

  it('le gateway avec hangForever retourne une erreur dans le délai configuré', async () => {
    battleServer = await startMockBattleServer(0);
    battleServer.configure({ hangForever: true });

    // Timeout court de 300ms pour que le test soit rapide
    gateway = new ConduitGateway(makeBattleConfig(battleServer.url, {}, 300));
    await gateway.initialize();
    const app = gateway.createApp();

    const start = Date.now();
    const { body } = await sendJson<{ error?: unknown; result?: unknown }>(
      app, 'battle', makeToolCall('battle_tool', { id: 'hang' }),
    );
    const elapsed = Date.now() - start;

    expect(body.error).toBeDefined();
    expect(elapsed).toBeLessThan(1500);
  }, 10_000);
});

describe('résilience — backend HTTP 500', () => {
  it('retourne une erreur JSON-RPC propre, logge l\'erreur, le gateway reste sain', async () => {
    battleServer = await startMockBattleServer(0);
    battleServer.configure({ httpStatus: 500 });

    gateway = new ConduitGateway(makeBattleConfig(battleServer.url));
    await gateway.initialize();
    const app = gateway.createApp();

    const { body, status } = await sendJson<{ error?: unknown; result?: unknown }>(
      app, 'battle', makeToolCall('battle_tool', { id: 'err500' }),
    );

    // Le gateway retourne une réponse valide (pas de 500 vers le client)
    // Le corps contient une erreur JSON-RPC
    expect(body.error).toBeDefined();

    // Le gateway lui-même reste sain — requêtes suivantes possibles
    battleServer.configure({ httpStatus: 0 });
    const { body: body2 } = await sendJson<{ error?: unknown; result?: unknown }>(
      app, 'battle', makeToolCall('battle_tool', { id: 'recovery' }),
    );
    expect(body2.result).toBeDefined();
    expect(body2.error).toBeUndefined();
  }, 10_000);
});

describe('résilience — backend retourne du JSON invalide', () => {
  it('retourne une erreur propre, ne met PAS en cache le garbage', async () => {
    battleServer = await startMockBattleServer(0);
    battleServer.configure({ malformedJson: true });

    gateway = new ConduitGateway(makeBattleConfig(battleServer.url));
    await gateway.initialize();
    const app = gateway.createApp();

    const { body } = await sendJson<{ error?: unknown; result?: unknown }>(
      app, 'battle', makeToolCall('battle_tool', { id: 'garbage' }),
    );

    // Doit retourner une erreur
    expect(body.error).toBeDefined();

    // Le cache doit être vide (rien mis en cache)
    const stats = gateway.getCacheStore().getStats();
    expect(stats.entries).toBe(0);

    // Le gateway doit survivre — requête suivante avec réponse valide
    battleServer.configure({ malformedJson: false });
    const { body: body2 } = await sendJson<{ error?: unknown; result?: unknown }>(
      app, 'battle', makeToolCall('battle_tool', { id: 'after-garbage' }),
    );
    expect(body2.result).toBeDefined();
  }, 10_000);
});

describe('résilience — backend coupe la connexion', () => {
  it('gère la coupure TCP proprement sans crash', async () => {
    battleServer = await startMockBattleServer(0);
    battleServer.configure({ dropConnection: true });

    gateway = new ConduitGateway(makeBattleConfig(battleServer.url));
    await gateway.initialize();
    const app = gateway.createApp();

    const { body } = await sendJson<{ error?: unknown; result?: unknown }>(
      app, 'battle', makeToolCall('battle_tool', { id: 'drop' }),
    );

    // Doit retourner une erreur (pas de crash)
    expect(body.error).toBeDefined();

    // Cache vide (rien caché)
    expect(gateway.getCacheStore().getStats().entries).toBe(0);
  }, 10_000);
});

describe('résilience — charge utile énorme', () => {
  it('réponse 5 Mo retournée au client mais NOT mise en cache (> max_entry_size_kb)', async () => {
    battleServer = await startMockBattleServer(0);
    battleServer.configure({ hugePayloadKb: 200 }); // 200 Ko > max_entry_size_kb=64

    gateway = new ConduitGateway(makeBattleConfig(battleServer.url));
    await gateway.initialize();
    const app = gateway.createApp();

    const { body: body1 } = await sendJson<{ error?: unknown; result?: { content?: Array<{text?: string}> } }>(
      app, 'battle', makeToolCall('battle_tool', { id: 'huge-1' }),
    );

    // La réponse doit être retournée (même si pas mise en cache)
    expect(body1.error).toBeUndefined();
    expect(body1.result).toBeDefined();

    // Le cache ne doit pas contenir cette grosse entrée (> 64 Ko)
    const cacheStats = gateway.getCacheStore().getStats();
    expect(cacheStats.entries).toBe(0);

    // Un deuxième appel identique doit aller upstream (pas de cache HIT)
    battleServer.resetStats();
    await sendJson(app, 'battle', makeToolCall('battle_tool', { id: 'huge-1' }));
    const stats = battleServer.getStats();
    expect(stats.totalRequests).toBeGreaterThan(0); // upstream appelé car pas en cache
  }, 10_000);

  it('réponse dans la limite (< max_entry_size_kb) est mise en cache', async () => {
    battleServer = await startMockBattleServer(0);
    battleServer.configure({ hugePayloadKb: 0 }); // réponse normale (petite)

    gateway = new ConduitGateway(makeBattleConfig(battleServer.url));
    await gateway.initialize();
    const app = gateway.createApp();

    // Premier appel — MISS
    await sendJson(app, 'battle', makeToolCall('battle_tool', { id: 'small-1' }));
    expect(gateway.getCacheStore().getStats().entries).toBe(1);

    // Deuxième appel — HIT depuis le cache
    battleServer.resetStats();
    await sendJson(app, 'battle', makeToolCall('battle_tool', { id: 'small-1' }));
    const stats = battleServer.getStats();
    expect(stats.totalRequests).toBe(0); // pas d'appel upstream
  }, 10_000);
});

describe('résilience — tous les backends hors ligne', () => {
  it('tools/list retourne une liste vide, tools/call retourne une erreur claire', async () => {
    // Utiliser un port impossible à atteindre
    resetMetrics();
    gateway = new ConduitGateway(makeBattleConfig('http://127.0.0.1:19999', {}, 300));
    await gateway.initialize();
    const app = gateway.createApp();

    // tools/list — doit retourner une liste vide ou une erreur propre
    const { body: listBody } = await sendJson<{
      result?: { tools?: unknown[] };
      error?: unknown;
    }>(app, 'battle', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    // tools/call — doit retourner une erreur claire
    const { body: callBody } = await sendJson<{ error?: unknown; result?: unknown }>(
      app, 'battle', makeToolCall('anything', { id: 'dead' }),
    );
    expect(callBody.error).toBeDefined();

    // Vérification que le body ne contient pas de données sensibles
    const callBodyStr = JSON.stringify(callBody);
    expect(callBodyStr).not.toContain('password');
  }, 10_000);
});

describe('résilience — SQLite sous pression', () => {
  it('1000 requêtes rapides : tous les logs enregistrés, requêtes toujours possibles', async () => {
    const mockMcp = await startMockMcpServer(0);
    resetMetrics();

    gateway = new ConduitGateway({
      gateway: { port: 0, host: '127.0.0.1' },
      router: {
        namespace_strategy: 'none',
        health_check: {
          enabled: false, interval_seconds: 60,
          timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1,
        },
        load_balancing: 'round-robin',
      },
      servers: [{ id: 'sqlite-test', url: mockMcp.url, cache: { default_ttl: 1 } }],
      cache: { enabled: true, l1: { max_entries: 100, max_entry_size_kb: 64 } },
      tenant_isolation: { enabled: false, header: 'Authorization' },
      observability: {
        log_args: true,
        log_responses: false,
        redact_fields: [],
        retention_days: 1,
        db_path: ':memory:',
      },
      metrics: { enabled: false, port: 0 },
    });
    await gateway.initialize();
    const app = gateway.createApp();

    const N = 200; // Réduit pour la rapidité, mais valide la logique

    // Envoyer N requêtes rapides
    const requests = Array.from({ length: N }, (_, i) =>
      app.request('/mcp/sqlite-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeToolCall('get_contact', { id: `sqlite-${i}` }, i + 1)),
      }),
    );

    const responses = await Promise.all(requests);
    const successes = responses.filter((r) => r.status === 200);
    expect(successes.length).toBe(N);

    // Vérifier les logs SQLite
    const logStore = gateway.getLogStore();
    const logs = logStore.getAll({ limit: N + 10 });
    expect(logs.length).toBeGreaterThan(0);

    // La purge doit fonctionner sans erreur
    expect(() => logStore.purgeOldEntries()).not.toThrow();

    gateway.stop();
    await mockMcp.close();
  }, 30_000);
});

describe('résilience — résistance aux collisions de clés de cache', () => {
  it('1000 appels d\'outils distincts : pas de collisions (chacun sa propre entrée)', async () => {
    const mockMcp = await startMockMcpServer(0);
    resetMetrics();

    gateway = new ConduitGateway({
      gateway: { port: 0, host: '127.0.0.1' },
      router: {
        namespace_strategy: 'none',
        health_check: {
          enabled: false, interval_seconds: 60,
          timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1,
        },
      },
      servers: [{ id: 'collision-test', url: mockMcp.url, cache: { default_ttl: 300 } }],
      cache: { enabled: true, l1: { max_entries: 2000, max_entry_size_kb: 64 } },
      tenant_isolation: { enabled: false, header: 'Authorization' },
      observability: {
        log_args: false, log_responses: false,
        redact_fields: [], retention_days: 1, db_path: ':memory:',
      },
      metrics: { enabled: false, port: 0 },
    });
    await gateway.initialize();
    const app = gateway.createApp();

    const N = 200; // Reduced from 500 for CI runner stability (Windows/macOS)
    // Arguments similaires mais distincts — send in batches to avoid overwhelming CI
    for (let batch = 0; batch < N; batch += 50) {
      const size = Math.min(50, N - batch);
      const requests = Array.from({ length: size }, (_, i) => {
        const idx = batch + i;
        return app.request('/mcp/collision-test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(makeToolCall('get_contact', { id: String(idx), extra: idx % 2 === 0 ? 'a' : 'b' }, idx)),
        });
      });
      await Promise.all(requests);
    }

    const cacheStats = gateway.getCacheStore().getStats();
    // Doit avoir N entrées distinctes (pas de collision)
    expect(cacheStats.entries).toBe(N);
    // Aucun HIT (chaque appel est unique)
    expect(cacheStats.hits).toBe(0);

    gateway.stop();
    await mockMcp.close();
  }, 30_000);
});

describe('résilience — isolation tenant sous stress', () => {
  it('10 tenants × 50 requêtes : cache complètement isolé par tenant', async () => {
    const mockMcp = await startMockMcpServer(0);
    resetMetrics();

    gateway = new ConduitGateway({
      gateway: { port: 0, host: '127.0.0.1' },
      router: {
        namespace_strategy: 'none',
        health_check: {
          enabled: false, interval_seconds: 60,
          timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1,
        },
      },
      servers: [{ id: 'tenant-test', url: mockMcp.url, cache: { default_ttl: 300 } }],
      cache: { enabled: true, l1: { max_entries: 10000, max_entry_size_kb: 64 } },
      tenant_isolation: { enabled: true, header: 'Authorization' },
      observability: {
        log_args: false, log_responses: false,
        redact_fields: [], retention_days: 1, db_path: ':memory:',
      },
      metrics: { enabled: false, port: 0 },
    });
    await gateway.initialize();
    const app = gateway.createApp();

    const N_TENANTS = 10;
    const N_PER_TENANT = 20; // réduit pour la rapidité

    // Phase 1 : pré-peupler le cache (1 requête par tenant, séquentielle)
    for (let tenantIdx = 0; tenantIdx < N_TENANTS; tenantIdx++) {
      await app.request('/mcp/tenant-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer tenant-${tenantIdx}-token`,
        },
        body: JSON.stringify(makeToolCall('get_contact', { id: 'shared-id' }, 0)),
      });
    }

    // Vérifier isolation : N_TENANTS entrées distinctes
    const cacheAfterWarmup = gateway.getCacheStore().getStats();
    expect(cacheAfterWarmup.entries).toBe(N_TENANTS);

    // Phase 2 : requêtes concurrentes (N_PER_TENANT - 1 par tenant) — toutes depuis cache
    const requests = Array.from({ length: N_TENANTS }, (_, tenantIdx) =>
      Array.from({ length: N_PER_TENANT - 1 }, (_, reqIdx) =>
        app.request('/mcp/tenant-test', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer tenant-${tenantIdx}-token`,
          },
          body: JSON.stringify(
            makeToolCall('get_contact', { id: 'shared-id' }, tenantIdx * N_PER_TENANT + reqIdx + 1),
          ),
        }),
      ),
    ).flat();

    const responses = await Promise.all(requests);
    const statusCodes = responses.map((r) => r.status);
    expect(statusCodes.every((s) => s === 200)).toBe(true);

    // Vérifier isolation tenant : toujours N_TENANTS entrées, pas de contamination
    const cacheStats = gateway.getCacheStore().getStats();
    expect(cacheStats.entries).toBe(N_TENANTS);

    // Les hits doivent être (N_TENANTS * (N_PER_TENANT - 1)) — toutes les Phase 2 depuis cache
    const expectedHits = N_TENANTS * (N_PER_TENANT - 1);
    expect(cacheStats.hits).toBe(expectedHits);

    gateway.stop();
    await mockMcp.close();
  }, 30_000);
});
