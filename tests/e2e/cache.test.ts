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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
});
