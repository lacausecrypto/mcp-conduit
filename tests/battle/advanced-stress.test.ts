/**
 * Battle tests avancés — stress sur les composants internes.
 *
 * Couvre :
 * 1. Batch JSON-RPC stress (Promise.allSettled)
 * 2. Namespace collision sous charge
 * 3. Cache LRU eviction sous pression
 * 4. Inflight dedup avec erreurs mixtes
 * 5. Config validation edge cases
 * 6. Pipeline with all features enabled simultaneously
 * 7. Redactor deep nesting
 * 8. W3C Trace Context propagation stress
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { startMockMcpServer, type MockMcpServer } from '../e2e/mock-mcp-server.js';
import { resetMetrics } from '../../src/observability/metrics.js';
import { redact, createRedactor } from '../../src/observability/redactor.js';
import { generateCacheKey } from '../../src/cache/cache-key.js';
import { decideCachePolicy } from '../../src/cache/cache-policy.js';
import { InflightTracker } from '../../src/cache/inflight.js';
import { CacheStore } from '../../src/cache/cache-store.js';
import { validateConfig, mergeWithDefaults } from '../../src/config/schema.js';
import { parseTraceparent, formatTraceparent, resolveTraceId, generateSpanId } from '../../src/observability/trace.js';
import type { Hono } from 'hono';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeConfig(mockUrl: string, overrides: Partial<ConduitGatewayConfig> = {}): ConduitGatewayConfig {
  return {
    gateway: { port: 0, host: '127.0.0.1' },
    router: {
      namespace_strategy: 'none',
      health_check: { enabled: false, interval_seconds: 60, timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1 },
    },
    servers: [{ id: 'adv', url: mockUrl, cache: { default_ttl: 300 } }],
    cache: { enabled: true, l1: { max_entries: 100, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: { log_args: false, log_responses: false, redact_fields: [], retention_days: 1, db_path: ':memory:' },
    metrics: { enabled: false, port: 0 },
    ...overrides,
  };
}

async function post(app: Hono, serverId: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(`/mcp/${serverId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function toolCall(name: string, args: Record<string, unknown>, id: number | string = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

// ─── 1. Batch JSON-RPC stress ─────────────────────────────────────────

describe('Battle — batch JSON-RPC', () => {
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
    await gateway.stop(1000);
    await mockServer.close();
  });

  it('batch de 50 requêtes — toutes traitées individuellement', async () => {
    const batch = Array.from({ length: 50 }, (_, i) => ({
      jsonrpc: '2.0', id: i + 1, method: 'tools/call',
      params: { name: 'get_contact', arguments: { id: `batch-${i}` } },
    }));

    const res = await post(app, 'adv', batch);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: number; result?: unknown; error?: unknown }>;
    expect(body).toHaveLength(50);

    // Chaque réponse doit avoir l'ID correspondant
    for (let i = 0; i < 50; i++) {
      expect(body[i]?.id).toBe(i + 1);
    }
  });

  it('batch avec mélange de méthodes valides et invalides', async () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_contact', arguments: { id: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nonexistent_tool', arguments: {} } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_contact', arguments: { id: '3' } } },
    ];

    const res = await post(app, 'adv', batch);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: number; result?: unknown; error?: unknown }>;
    expect(body).toHaveLength(3);

    // Les IDs 1 et 3 devraient réussir (ou au moins avoir un résultat), ID 2 en erreur
    expect(body[0]?.id).toBe(1);
    expect(body[1]?.id).toBe(2);
    expect(body[2]?.id).toBe(3);
  });

  it('batch vide retourne un tableau vide ou erreur', async () => {
    const res = await post(app, 'adv', []);
    // Un batch vide est un JSON-RPC invalide
    expect(res.status).toBe(400);
  });
});

// ─── 2. Cache LRU eviction ────────────────────────────────────────────

describe('Battle — cache LRU eviction sous pression', () => {
  it('CacheStore évicte les entrées les plus anciennes quand max_entries atteint', () => {
    const store = new CacheStore({ max_entries: 10, max_entry_size_kb: 64 });

    // Remplir le cache avec 15 entrées (max = 10)
    for (let i = 0; i < 15; i++) {
      store.set(`key-${i}`, {
        result: { value: i },
        createdAt: Date.now(),
        ttl: 300,
        toolName: 'tool',
        serverId: 'srv',
      });
    }

    // Le cache ne doit pas dépasser max_entries
    expect(store.size).toBeLessThanOrEqual(10);

    // Les 5 premières entrées devraient avoir été évictées
    expect(store.get('key-0')).toBeUndefined();
    expect(store.get('key-1')).toBeUndefined();

    // Les dernières devraient être présentes
    expect(store.get('key-14')).toBeDefined();
    expect(store.get('key-13')).toBeDefined();
  });

  it('CacheStore rejette les entrées trop grandes (max_entry_size_kb)', () => {
    const store = new CacheStore({ max_entries: 100, max_entry_size_kb: 1 }); // 1 Ko max

    const bigResult = { data: 'x'.repeat(2048) }; // > 1Ko
    store.set('big-key', {
      result: bigResult,
      createdAt: Date.now(),
      ttl: 300,
      toolName: 'tool',
      serverId: 'srv',
    });

    // L'entrée trop grande ne doit pas être en cache
    expect(store.get('big-key')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('CacheStore gère 10000 entrées sans crash', () => {
    const store = new CacheStore({ max_entries: 10000, max_entry_size_kb: 64 });

    for (let i = 0; i < 10000; i++) {
      store.set(`key-${i}`, {
        result: { i },
        createdAt: Date.now(),
        ttl: 300,
        toolName: `tool-${i % 10}`,
        serverId: `srv-${i % 3}`,
      });
    }

    expect(store.size).toBe(10000);

    // Invalidation par serveur
    const deleted = store.deleteByServer('srv-0');
    expect(deleted).toBeGreaterThan(0);
    expect(store.size).toBeLessThan(10000);
  });

  it('deleteByTool supprime uniquement les entrées du bon outil/serveur', () => {
    const store = new CacheStore({ max_entries: 100, max_entry_size_kb: 64 });

    for (let i = 0; i < 20; i++) {
      store.set(`key-${i}`, {
        result: { i },
        createdAt: Date.now(),
        ttl: 300,
        toolName: i < 10 ? 'tool-a' : 'tool-b',
        serverId: 'srv',
      });
    }

    expect(store.size).toBe(20);
    const deleted = store.deleteByTool('tool-a', 'srv');
    expect(deleted).toBe(10);
    expect(store.size).toBe(10);
  });
});

// ─── 3. Inflight dedup avec erreurs ───────────────────────────────────

describe('Battle — inflight dedup edge cases', () => {
  it('factory qui throw → toutes les requêtes coalescées reçoivent l\'erreur', async () => {
    const tracker = new InflightTracker();
    const error = new Error('upstream failed');

    const p1 = tracker.deduplicate('key1', async () => { throw error; });
    const p2 = tracker.deduplicate('key1', async () => ({ value: 'should not run' }));

    await expect(p1).rejects.toThrow('upstream failed');
    await expect(p2).rejects.toThrow('upstream failed');
    expect(tracker.size).toBe(0);
  });

  it('factory lente → requêtes concurrentes coalescées correctement', async () => {
    const tracker = new InflightTracker();
    let callCount = 0;

    const factory = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return { value: 'result' };
    };

    const promises = Array.from({ length: 10 }, () =>
      tracker.deduplicate('slow-key', factory),
    );

    const results = await Promise.all(promises);

    // Factory ne doit être appelée qu'une seule fois
    expect(callCount).toBe(1);

    // Toutes les réponses identiques
    for (const r of results) {
      expect(r.result).toEqual({ value: 'result' });
    }

    // Au moins 9 coalescées
    const coalesced = results.filter((r) => r.wasCoalesced).length;
    expect(coalesced).toBe(9);
  });

  it('clés différentes → pas de coalescence croisée', async () => {
    const tracker = new InflightTracker();
    let callCount = 0;

    const factory = async () => {
      callCount++;
      return { value: callCount };
    };

    const p1 = tracker.deduplicate('key-a', factory);
    const p2 = tracker.deduplicate('key-b', factory);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(callCount).toBe(2);
    expect(r1.wasCoalesced).toBe(false);
    expect(r2.wasCoalesced).toBe(false);
  });
});

// ─── 4. Cache key determinism ─────────────────────────────────────────

describe('Battle — cache key determinism', () => {
  it('mêmes args dans un ordre différent → même clé', () => {
    const key1 = generateCacheKey({ serverId: 's', toolName: 't', args: { a: 1, b: 2, c: 3 } });
    const key2 = generateCacheKey({ serverId: 's', toolName: 't', args: { c: 3, a: 1, b: 2 } });
    expect(key1).toBe(key2);
  });

  it('args imbriqués dans un ordre différent → même clé', () => {
    const key1 = generateCacheKey({ serverId: 's', toolName: 't', args: { nested: { z: 1, a: 2 } } });
    const key2 = generateCacheKey({ serverId: 's', toolName: 't', args: { nested: { a: 2, z: 1 } } });
    expect(key1).toBe(key2);
  });

  it('serverId différent → clé différente', () => {
    const key1 = generateCacheKey({ serverId: 'a', toolName: 't', args: {} });
    const key2 = generateCacheKey({ serverId: 'b', toolName: 't', args: {} });
    expect(key1).not.toBe(key2);
  });

  it('tenantId différent → clé différente (isolation)', () => {
    const key1 = generateCacheKey({ serverId: 's', toolName: 't', args: {}, tenantId: 'tenant-a' });
    const key2 = generateCacheKey({ serverId: 's', toolName: 't', args: {}, tenantId: 'tenant-b' });
    expect(key1).not.toBe(key2);
  });

  it('ignoreArgs filtre les champs spécifiés', () => {
    const key1 = generateCacheKey({ serverId: 's', toolName: 't', args: { query: 'test', timestamp: 123 }, ignoreArgs: ['timestamp'] });
    const key2 = generateCacheKey({ serverId: 's', toolName: 't', args: { query: 'test', timestamp: 999 }, ignoreArgs: ['timestamp'] });
    expect(key1).toBe(key2);
  });

  it('1000 clés uniques — aucune collision', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      keys.add(generateCacheKey({ serverId: 's', toolName: 't', args: { id: i } }));
    }
    expect(keys.size).toBe(1000);
  });
});

// ─── 5. Cache policy edge cases ───────────────────────────────────────

describe('Battle — cache policy edge cases', () => {
  it('annotations multiples — destructive > readOnly > idempotent', () => {
    const r1 = decideCachePolicy('t', { destructiveHint: true, readOnlyHint: true }, { default_ttl: 300 });
    expect(r1.shouldCache).toBe(false);
    expect(r1.isDestructive).toBe(true);
  });

  it('override TTL=0 désactive le cache même avec readOnlyHint', () => {
    const r = decideCachePolicy('t', { readOnlyHint: true }, { default_ttl: 300, overrides: { t: { ttl: 0 } } });
    expect(r.shouldCache).toBe(false);
  });

  it('override invalidates déclenche l\'invalidation', () => {
    const r = decideCachePolicy('create_x', {}, { default_ttl: 300, overrides: { create_x: { ttl: 0, invalidates: ['get_x', 'list_x'] } } });
    expect(r.shouldCache).toBe(false);
    expect(r.isDestructive).toBe(true);
    expect(r.invalidates).toEqual(['get_x', 'list_x']);
  });

  it('aucune annotation → pas de cache (conservateur)', () => {
    const r = decideCachePolicy('unknown', {}, { default_ttl: 300 });
    expect(r.shouldCache).toBe(false);
  });
});

// ─── 6. Redactor deep nesting ─────────────────────────────────────────

describe('Battle — redactor sous pression', () => {
  it('objet imbriqué 50 niveaux — pas de stack overflow', () => {
    let obj: Record<string, unknown> = { password: 'secret' };
    for (let i = 0; i < 50; i++) {
      obj = { [`level${i}`]: obj };
    }

    const result = redact(obj, ['password']);
    // Vérifier que la valeur tout en bas est masquée
    let current = result as Record<string, unknown>;
    for (let i = 49; i >= 0; i--) {
      current = current[`level${i}`] as Record<string, unknown>;
    }
    expect(current['password']).toBe('[REDACTED]');
  });

  it('tableau de 1000 objets — tous masqués', () => {
    const arr = Array.from({ length: 1000 }, (_, i) => ({ id: i, token: `tok-${i}` }));
    const result = redact(arr, ['token']) as Array<{ id: number; token: string }>;
    expect(result).toHaveLength(1000);
    for (const item of result) {
      expect(item.token).toBe('[REDACTED]');
    }
  });

  it('createRedactor réutilisable — même résultat 1000 fois', () => {
    const redactor = createRedactor(['secret', 'password']);
    for (let i = 0; i < 1000; i++) {
      const r = redactor({ secret: 'val', safe: 'ok' }) as Record<string, unknown>;
      expect(r['secret']).toBe('[REDACTED]');
      expect(r['safe']).toBe('ok');
    }
  });
});

// ─── 7. W3C Trace Context stress ──────────────────────────────────────

describe('Battle — W3C Trace Context', () => {
  it('1000 traceparent parse/format cycles — tous cohérents', () => {
    for (let i = 0; i < 1000; i++) {
      const spanId = generateSpanId();
      const traceId = `${spanId}${spanId}`; // 32 hex chars
      const tp = formatTraceparent(traceId, spanId);

      const parsed = parseTraceparent(tp);
      expect(parsed).not.toBeNull();
      expect(parsed!.traceId).toBe(traceId);
      expect(parsed!.parentId).toBe(spanId);
      expect(parsed!.flags).toBe('01');
    }
  });

  it('resolveTraceId avec traceparent invalide → fallback custom header', () => {
    const invalid = [
      'not-a-traceparent',
      '00-short-id-01',
      '00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-0000000000000000-01', // non-hex
      '',
      '   ',
    ];

    for (const tp of invalid) {
      const id = resolveTraceId({ traceparent: tp, 'x-conduit-trace-id': 'fallback-ok' });
      expect(id).toBe('fallback-ok');
    }
  });

  it('generateSpanId produit 1000 IDs uniques de 16 chars hex', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = generateSpanId();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(1000);
  });
});

// ─── 8. Config validation edge cases ──────────────────────────────────

describe('Battle — config validation', () => {
  it('config minimale valide', () => {
    const config = mergeWithDefaults({
      servers: [{ id: 'test', url: 'http://localhost:3000/mcp' }],
    });
    const errors = validateConfig(config);
    expect(errors).toHaveLength(0);
  });

  it('config stdio valide', () => {
    const config = mergeWithDefaults({
      servers: [{
        id: 'stdio-test',
        url: 'stdio://echo',
        transport: 'stdio',
        command: 'echo',
        args: ['hello'],
      }],
    });
    const errors = validateConfig(config);
    expect(errors).toHaveLength(0);
  });

  it('config stdio sans command → erreur', () => {
    const config = mergeWithDefaults({
      servers: [{ id: 'bad-stdio', url: 'stdio://x', transport: 'stdio' }],
    });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path.includes('command'))).toBe(true);
  });

  it('config stdio avec replicas → erreur', () => {
    const config = mergeWithDefaults({
      servers: [{ id: 'bad-stdio', url: 'stdio://x', transport: 'stdio', command: 'echo', replicas: ['http://r1'] }],
    });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path.includes('replicas'))).toBe(true);
  });

  it('config L2 cache sans redis_url → erreur', () => {
    const config = mergeWithDefaults({
      servers: [{ id: 'test', url: 'http://localhost:3000/mcp' }],
      cache: { enabled: true, l1: { max_entries: 100, max_entry_size_kb: 64 }, l2: { enabled: true, redis_url: '' } },
    });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path.includes('l2.redis_url'))).toBe(true);
  });

  it('port invalide détecté', () => {
    const config = mergeWithDefaults({
      gateway: { port: 99999, host: '0.0.0.0' },
      servers: [{ id: 'test', url: 'http://localhost:3000/mcp' }],
    });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path.includes('port'))).toBe(true);
  });

  it('server ID avec caractères spéciaux → erreur', () => {
    const config = mergeWithDefaults({
      servers: [{ id: 'bad server!', url: 'http://localhost:3000/mcp' }],
    });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path.includes('id'))).toBe(true);
  });

  it('server URL invalide → erreur', () => {
    const config = mergeWithDefaults({
      servers: [{ id: 'test', url: 'not-a-url' }],
    });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path.includes('url'))).toBe(true);
  });
});
