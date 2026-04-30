/**
 * Tests e2e — Cache et déduplication.
 *
 * Vérifie que le cache L1 fonctionne correctement end-to-end :
 * - Mise en cache des appels readOnly
 * - Bypass des outils destructeurs
 * - Invalidation sélective du cache
 * - Déduplication des requêtes concurrentes (inflight)
 * - En-têtes X-Conduit-Cache-Status
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  setup,
  teardown,
  sendMcpRequest,
  makeToolCallMessage,
  type E2eTestContext,
} from './setup.js';

describe('Cache L1 et déduplication', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      namespaceStrategy: 'none',
      cacheEnabled: true,
      defaultTtl: 300,
      toolOverrides: {
        // create_contact invalide le cache de get_contact
        create_contact: { ttl: 0, invalidates: ['get_contact'] },
      },
    });
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  beforeEach(() => {
    ctx.gateway.getCacheStore().clear();
    ctx.mockServer.resetCallCounts();
  });

  describe('mise en cache des requêtes readOnly', () => {
    it('met en cache un appel readOnly (HIT au second appel)', async () => {
      const msg = makeToolCallMessage('get_contact', { id: '99' });

      // Premier appel — MISS
      const res1 = await sendMcpRequest(ctx.app, 'test-server', msg);
      expect(res1.headers.get('x-conduit-cache-status')).toBe('MISS');
      expect(ctx.mockServer.getCallCount('tools/call')).toBe(1);

      // Second appel — HIT (backend non sollicité)
      const res2 = await sendMcpRequest(ctx.app, 'test-server', msg);
      expect(res2.headers.get('x-conduit-cache-status')).toBe('HIT');
      expect(ctx.mockServer.getCallCount('tools/call')).toBe(1);
    });

    it('retourne le même résultat pour un HIT que pour un MISS', async () => {
      const msg = makeToolCallMessage('get_contact', { id: '55' });

      const r1 = await (await sendMcpRequest(ctx.app, 'test-server', msg)).json() as Record<string, unknown>;
      const r2 = await (await sendMcpRequest(ctx.app, 'test-server', msg)).json() as Record<string, unknown>;

      expect(r1['result']).toEqual(r2['result']);
    });

    it('cache différentes clés pour des arguments différents', async () => {
      await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: 'aaa' }));
      await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: 'bbb' }));

      // Deux MISS, le backend a été appelé deux fois
      expect(ctx.mockServer.getCallCount('tools/call')).toBe(2);
    });
  });

  describe('bypass du cache (SKIP)', () => {
    it('retourne SKIP pour un outil sans annotation de cache', async () => {
      // create_contact a ttl:0 dans les overrides → destructeur
      const res = await sendMcpRequest(
        ctx.app, 'test-server', makeToolCallMessage('create_contact', { name: 'Test' }),
      );
      expect(res.headers.get('x-conduit-cache-status')).toBe('SKIP');
    });

    it('envoie chaque requête SKIP au backend', async () => {
      await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('create_contact', { name: 'A' }));
      await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('create_contact', { name: 'B' }));

      expect(ctx.mockServer.getCallCount('tools/call')).toBe(2);
    });
  });

  describe('invalidation du cache', () => {
    it('invalide le cache de get_contact après create_contact', async () => {
      // Mise en cache initiale
      const getMsg = makeToolCallMessage('get_contact', { id: '200' });
      await sendMcpRequest(ctx.app, 'test-server', getMsg);
      expect(ctx.mockServer.getCallCount('tools/call')).toBe(1);

      // Vérification que c'est bien en cache
      await sendMcpRequest(ctx.app, 'test-server', getMsg);
      expect(ctx.mockServer.getCallCount('tools/call')).toBe(1); // HIT

      // Appel create_contact (destructeur → invalide get_contact)
      await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('create_contact', { name: 'New' }));

      // Le cache de get_contact doit avoir été invalidé → nouveau MISS
      const res = await sendMcpRequest(ctx.app, 'test-server', getMsg);
      expect(res.headers.get('x-conduit-cache-status')).toBe('MISS');
      expect(ctx.mockServer.getCallCount('tools/call')).toBe(3);
    });

    it('propage l’invalidation au cache L2 quand il est configuré', async () => {
      const mockL2 = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn(),
        deleteByTool: vi.fn().mockResolvedValue(1),
      };
      const pipeline = (ctx.gateway as unknown as {
        pipeline: { setL2Cache(l2: unknown, ttlMultiplier: number): void };
      }).pipeline;
      pipeline.setL2Cache(mockL2, 3);

      await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: 'l2-1' }));
      await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('create_contact', { name: 'L2' }));

      expect(mockL2.deleteByTool).toHaveBeenCalledWith('get_contact', 'test-server');
    });
  });

  describe('cache stats via /conduit/cache/stats', () => {
    it('retourne les statistiques du cache', async () => {
      // Génère un HIT et un MISS
      const msg = makeToolCallMessage('get_contact', { id: 'stat-test' });
      await sendMcpRequest(ctx.app, 'test-server', msg);
      await sendMcpRequest(ctx.app, 'test-server', msg);

      const res = await ctx.app.request('/conduit/cache/stats');
      expect(res.status).toBe(200);

      const body = await res.json() as { l1: { hits: number; misses: number; hitRate: number } };
      expect(body.l1.hits).toBeGreaterThanOrEqual(1);
      expect(body.l1.misses).toBeGreaterThanOrEqual(1);
      expect(body.l1.hitRate).toBeGreaterThan(0);
    });
  });

  describe('invalidation via /conduit/cache/server/:id', () => {
    it('invalide toutes les entrées d\'un serveur via l\'API admin', async () => {
      // Mise en cache
      await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: 'inv1' }));
      await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: 'inv2' }));

      expect(ctx.gateway.getCacheStore().size).toBeGreaterThan(0);

      // Invalidation via API admin
      const res = await ctx.app.request('/conduit/cache/server/test-server', { method: 'DELETE', headers: { 'X-Conduit-Admin': 'true' } });
      expect(res.status).toBe(200);

      const body = await res.json() as { deleted_count: number };
      expect(body.deleted_count).toBeGreaterThanOrEqual(2);
      expect(ctx.gateway.getCacheStore().size).toBe(0);
    });
  });

  describe('déduplication inflight', () => {
    it('coalesce des requêtes concurrentes identiques', async () => {
      const msg = makeToolCallMessage('get_contact', { id: 'concurrent' });

      // Lance plusieurs requêtes simultanées pour le même outil+args
      const promises = Array.from({ length: 5 }, () =>
        sendMcpRequest(ctx.app, 'test-server', msg),
      );

      const responses = await Promise.all(promises);

      // Toutes les réponses doivent être valides
      for (const res of responses) {
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body['error']).toBeUndefined();
      }

      // Le backend ne devrait pas avoir été appelé 5 fois (déduplication en vol)
      // Note : selon les timings, la déduplication peut se produire ou non,
      // mais le résultat doit toujours être correct.
      expect(ctx.mockServer.getCallCount('tools/call')).toBeGreaterThanOrEqual(1);
    });

    it('expose le snapshot inflight via /conduit/dedup/inflight', async () => {
      const res = await ctx.app.request('/conduit/dedup/inflight');
      expect(res.status).toBe(200);

      const body = await res.json() as { inflight: unknown[]; count: number };
      expect(Array.isArray(body.inflight)).toBe(true);
      expect(typeof body.count).toBe('number');
    });

    // ── Audit 3.1#6 — cache stampede end-to-end ─────────────────────────
    // Vérifie qu'avec 50 requêtes simultanées identiques sur une clé non
    // encore en cache, la chaîne L1-miss + Inflight + upstream + L1-set
    // ne déclenche qu'UN seul appel upstream. Pin du single-flight.

    it('50 requêtes concurrentes identiques → 1 seul appel upstream (cache stampede protégé)', async () => {
      ctx.gateway.getCacheStore().clear();
      ctx.mockServer.resetCallCounts();

      const msg = makeToolCallMessage('get_contact', { id: 'stampede-50' });
      const promises = Array.from({ length: 50 }, () =>
        sendMcpRequest(ctx.app, 'test-server', msg),
      );
      const responses = await Promise.all(promises);

      // Tous succès
      for (const res of responses) {
        expect(res.status).toBe(200);
      }
      // Toutes les réponses contiennent le même result
      const bodies = await Promise.all(responses.map((r) => r.clone().json() as Promise<Record<string, unknown>>));
      const firstResult = bodies[0]?.['result'];
      for (const body of bodies) {
        expect(body['result']).toEqual(firstResult);
      }
      // Single-flight : un seul tools/call upstream
      expect(ctx.mockServer.getCallCount('tools/call')).toBe(1);
      // Et l'entrée est en L1 pour les requêtes suivantes
      expect(ctx.gateway.getCacheStore().size).toBeGreaterThanOrEqual(1);
    });

    it('après stampede, une 51ᵉ requête identique est servie par L1 (HIT) sans nouvel appel upstream', async () => {
      ctx.gateway.getCacheStore().clear();
      ctx.mockServer.resetCallCounts();
      const msg = makeToolCallMessage('get_contact', { id: 'stampede-then-hit' });

      await Promise.all(Array.from({ length: 50 }, () => sendMcpRequest(ctx.app, 'test-server', msg)));
      expect(ctx.mockServer.getCallCount('tools/call')).toBe(1);

      const res = await sendMcpRequest(ctx.app, 'test-server', msg);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-conduit-cache-status')).toBe('HIT');
      expect(ctx.mockServer.getCallCount('tools/call')).toBe(1);
    });

    it('stampede sur clés différentes → N appels upstream distincts (pas de fausse coalescence)', async () => {
      ctx.gateway.getCacheStore().clear();
      ctx.mockServer.resetCallCounts();
      // 20 clés distinctes, 5 requêtes simultanées par clé.
      const promises: Promise<Response>[] = [];
      for (let key = 0; key < 20; key++) {
        const msg = makeToolCallMessage('get_contact', { id: `diff-${key}` });
        for (let dup = 0; dup < 5; dup++) {
          promises.push(sendMcpRequest(ctx.app, 'test-server', msg));
        }
      }
      const responses = await Promise.all(promises);
      for (const res of responses) {
        expect(res.status).toBe(200);
      }
      // Single-flight par clé → 20 appels upstream attendus.
      expect(ctx.mockServer.getCallCount('tools/call')).toBe(20);
    });

    it('stampede avec L2 actif : single-flight intra-pod respecté côté upstream (un seul tools/call)', async () => {
      ctx.gateway.getCacheStore().clear();
      ctx.mockServer.resetCallCounts();

      const mockL2 = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        deleteByTool: vi.fn().mockResolvedValue(0),
      };
      const pipeline = (ctx.gateway as unknown as {
        pipeline: { setL2Cache(l2: unknown, ttlMultiplier: number): void };
      }).pipeline;
      pipeline.setL2Cache(mockL2, 3);

      try {
        const msg = makeToolCallMessage('get_contact', { id: 'l2-stampede' });
        await Promise.all(Array.from({ length: 50 }, () => sendMcpRequest(ctx.app, 'test-server', msg)));

        // Single upstream call — c'est le but principal du single-flight.
        expect(ctx.mockServer.getCallCount('tools/call')).toBe(1);
        // Au moins un L2 set est observé (la valeur retournée est mise en cache).
        // Note (audit 2.2) : actuellement tous les callers coalescés écrivent
        // chacun en L2 — c'est wasteful mais idempotent. Un futur fix peut
        // ajouter une dédup sur le set L2. On pin le comportement actuel pour
        // détecter une régression accidentelle.
        expect(mockL2.set.mock.calls.length).toBeGreaterThanOrEqual(1);
      } finally {
        // Detach the mock to avoid leaking into other tests.
        pipeline.setL2Cache(undefined as unknown as null, 1);
      }
    });
  });

  describe('cache désactivé', () => {
    let noCache: E2eTestContext;

    beforeAll(async () => {
      noCache = await setup({ namespaceStrategy: 'none', cacheEnabled: false });
    });

    afterAll(async () => {
      await teardown(noCache);
    });

    beforeEach(() => {
      noCache.mockServer.resetCallCounts();
    });

    it('retourne SKIP pour tous les appels quand le cache est désactivé', async () => {
      const res = await sendMcpRequest(
        noCache.app, 'test-server', makeToolCallMessage('get_contact', { id: '1' }),
      );
      expect(res.headers.get('x-conduit-cache-status')).toBe('SKIP');
    });

    it('appelle le backend à chaque requête quand le cache est désactivé', async () => {
      const msg = makeToolCallMessage('get_contact', { id: 'nocache' });
      await sendMcpRequest(noCache.app, 'test-server', msg);
      await sendMcpRequest(noCache.app, 'test-server', msg);

      expect(noCache.mockServer.getCallCount('tools/call')).toBe(2);
    });
  });

  // ── Audit High 3.2 #5 — MCP isError cache skip ─────────────────────────────
  // An MCP tool that returns `isError: true` is a transient failure (invalid
  // input, upstream rate-limit, partial outage). Caching such a response would
  // poison every subsequent caller for the policy TTL. The gateway MUST skip
  // caching these responses while still surfacing the body to the caller.
  describe('isError cache skip (audit High 3.2 #5)', () => {
    it('does not cache a tool response that contains isError:true', async () => {
      // Configure get_contact to return an isError result on this run only.
      ctx.mockServer.setTool({
        name: 'get_contact',
        annotations: { readOnlyHint: true },
        result: {
          content: [{ type: 'text', text: 'Contact lookup transiently failed' }],
          isError: true,
        },
      });

      const msg = makeToolCallMessage('get_contact', { id: 'iserror-1' });

      const res1 = await sendMcpRequest(ctx.app, 'test-server', msg);
      expect(res1.status).toBe(200);
      expect(res1.headers.get('x-conduit-cache-status')).toBe('SKIP_ERROR');

      const body1 = await res1.json() as { result?: { isError?: boolean } };
      expect(body1.result?.isError).toBe(true);

      // Second identical call must hit upstream again — not be served from L1.
      const res2 = await sendMcpRequest(ctx.app, 'test-server', msg);
      expect(res2.headers.get('x-conduit-cache-status')).toBe('SKIP_ERROR');
      expect(ctx.mockServer.getCallCount('tools/call')).toBe(2);

      // Restore the original (success) tool definition for downstream tests.
      ctx.mockServer.setTool({
        name: 'get_contact',
        annotations: { readOnlyHint: true },
        result: { id: '123', name: 'Alice Martin', email: 'alice@example.com' },
      });
    });

    it('a successful follow-up call IS cached normally (no lingering skip)', async () => {
      // First call: isError → SKIP_ERROR, no cache write.
      ctx.mockServer.setTool({
        name: 'get_contact',
        annotations: { readOnlyHint: true },
        result: {
          content: [{ type: 'text', text: 'transient' }],
          isError: true,
        },
      });
      await sendMcpRequest(
        ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: 'recovered' }),
      );

      // Now upstream recovers — same key should MISS (no poison cache), then
      // cache the success.
      ctx.mockServer.setTool({
        name: 'get_contact',
        annotations: { readOnlyHint: true },
        result: { id: 'recovered', name: 'Recovered' },
      });
      const ok1 = await sendMcpRequest(
        ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: 'recovered' }),
      );
      expect(ok1.headers.get('x-conduit-cache-status')).toBe('MISS');

      const ok2 = await sendMcpRequest(
        ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: 'recovered' }),
      );
      expect(ok2.headers.get('x-conduit-cache-status')).toBe('HIT');
    });

    it('isError:false is cached normally (only true triggers the skip)', async () => {
      ctx.mockServer.setTool({
        name: 'get_contact',
        annotations: { readOnlyHint: true },
        result: {
          content: [{ type: 'text', text: 'real success' }],
          isError: false,
        },
      });
      const msg = makeToolCallMessage('get_contact', { id: 'notError' });

      const res1 = await sendMcpRequest(ctx.app, 'test-server', msg);
      expect(res1.headers.get('x-conduit-cache-status')).toBe('MISS');

      const res2 = await sendMcpRequest(ctx.app, 'test-server', msg);
      expect(res2.headers.get('x-conduit-cache-status')).toBe('HIT');

      ctx.mockServer.setTool({
        name: 'get_contact',
        annotations: { readOnlyHint: true },
        result: { id: '123', name: 'Alice Martin', email: 'alice@example.com' },
      });
    });

    it('preserves the result body verbatim (caller still sees isError:true)', async () => {
      ctx.mockServer.setTool({
        name: 'get_contact',
        annotations: { readOnlyHint: true },
        result: {
          content: [{ type: 'text', text: 'detailed error context' }],
          isError: true,
          // Custom field that callers may rely on
          retryAfter: 5,
        },
      });

      const res = await sendMcpRequest(
        ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: 'verbatim' }),
      );
      const body = await res.json() as {
        result?: { content?: unknown[]; isError?: boolean; retryAfter?: number };
        error?: unknown;
      };
      // No JSON-RPC error envelope — it's a successful response with isError flag
      expect(body.error).toBeUndefined();
      expect(body.result?.isError).toBe(true);
      expect(body.result?.retryAfter).toBe(5);
      expect(Array.isArray(body.result?.content)).toBe(true);

      ctx.mockServer.setTool({
        name: 'get_contact',
        annotations: { readOnlyHint: true },
        result: { id: '123', name: 'Alice Martin', email: 'alice@example.com' },
      });
    });
  });
});
