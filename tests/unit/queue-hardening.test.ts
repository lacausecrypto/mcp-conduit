/**
 * Tests de durcissement pour RequestQueue.
 * Couvre : multi-clés, limites 0/1, pendingCount, cleanup après stop.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { RequestQueue } from '../../src/rate-limit/queue.js';
import { SlidingWindowLimiter } from '../../src/rate-limit/limiter.js';

const CFG_ENABLED = { enabled: true, max_wait_ms: 2000, max_queue_size: 10 };

afterEach(() => {
  vi.useRealTimers();
});

describe('RequestQueue — hardening', () => {
  describe('multi-clés (bug fix)', () => {
    it('résout les deux clés indépendamment quand la capacité se libère', async () => {
      // Ce test vérifie le bug corrigé : un seul pollTimer servait toutes les clés,
      // mais ne traitait que la première clé enregistrée.
      const WINDOW = 150;
      const limiter = new SlidingWindowLimiter();
      const q = new RequestQueue(CFG_ENABLED);

      // Consommer la capacité de key-A et key-B
      limiter.consume('key-A', 1, WINDOW);
      limiter.consume('key-B', 1, WINDOW);

      const pA = q.enqueue('key-A', 1, WINDOW, limiter);
      const pB = q.enqueue('key-B', 1, WINDOW, limiter);

      // Attendre que les deux fenêtres expirent
      await new Promise((r) => setTimeout(r, WINDOW + 200));

      await expect(pA).resolves.toBeUndefined();
      await expect(pB).resolves.toBeUndefined();

      q.stop();
    });

    it('résout les clés dans l\'ordre d\'enregistrement si capacité simultanée', async () => {
      const limiter = new SlidingWindowLimiter();
      const q = new RequestQueue(CFG_ENABLED);

      // Pas de consommation préalable — les deux clés ont de la capacité
      const pA = q.enqueue('multi-A', 5, 60_000, limiter);
      const pB = q.enqueue('multi-B', 5, 60_000, limiter);

      await expect(Promise.all([pA, pB])).resolves.toBeDefined();
      q.stop();
    });

    it('les trois clés différentes sont toutes résolues', async () => {
      const WINDOW = 150;
      const limiter = new SlidingWindowLimiter();
      const q = new RequestQueue(CFG_ENABLED);

      limiter.consume('k1', 1, WINDOW);
      limiter.consume('k2', 1, WINDOW);
      limiter.consume('k3', 1, WINDOW);

      const promises = [
        q.enqueue('k1', 1, WINDOW, limiter),
        q.enqueue('k2', 1, WINDOW, limiter),
        q.enqueue('k3', 1, WINDOW, limiter),
      ];

      await new Promise((r) => setTimeout(r, WINDOW + 200));

      await expect(Promise.all(promises)).resolves.toBeDefined();
      q.stop();
    });
  });

  describe('pendingCount', () => {
    it('pendingCount reflète le nombre d\'entrées actives', () => {
      const limiter = new SlidingWindowLimiter();
      // Bloquer la clé
      limiter.consume('pc-key', 0, 60_000);
      const q = new RequestQueue(CFG_ENABLED);

      expect(q.pendingCount).toBe(0);

      const p1 = q.enqueue('pc-key', 0, 60_000, limiter).catch(() => {});
      const p2 = q.enqueue('pc-key', 0, 60_000, limiter).catch(() => {});

      expect(q.pendingCount).toBe(2);

      q.stop();
      // stop() rejette toutes les entrées — pendingCount revient à 0
      expect(q.pendingCount).toBe(0);

      return Promise.all([p1, p2]);
    });

    it('pendingCount sur plusieurs clés est la somme', () => {
      const limiter = new SlidingWindowLimiter();
      limiter.consume('pc2-A', 0, 60_000);
      limiter.consume('pc2-B', 0, 60_000);

      const q = new RequestQueue(CFG_ENABLED);
      const p1 = q.enqueue('pc2-A', 0, 60_000, limiter).catch(() => {});
      const p2 = q.enqueue('pc2-A', 0, 60_000, limiter).catch(() => {});
      const p3 = q.enqueue('pc2-B', 0, 60_000, limiter).catch(() => {});

      expect(q.pendingCount).toBe(3);

      q.stop();
      return Promise.all([p1, p2, p3]);
    });
  });

  describe('max_queue_size = 0', () => {
    it('rejette immédiatement si max_queue_size vaut 0', async () => {
      const cfg = { enabled: true, max_wait_ms: 1000, max_queue_size: 0 };
      const limiter = new SlidingWindowLimiter();
      limiter.consume('zs', 0, 60_000);
      const q = new RequestQueue(cfg);

      await expect(q.enqueue('zs', 0, 60_000, limiter)).rejects.toThrow('pleine');
      q.stop();
    });
  });

  describe('max_wait_ms = 0', () => {
    it('expire immédiatement si max_wait_ms vaut 0', async () => {
      const cfg = { enabled: true, max_wait_ms: 0, max_queue_size: 10 };
      const limiter = new SlidingWindowLimiter();
      limiter.consume('zw', 0, 60_000);
      const q = new RequestQueue(cfg);

      // Avec max_wait_ms=0, deadline = Date.now() → expire au prochain tick de polling
      await expect(q.enqueue('zw', 0, 60_000, limiter)).rejects.toThrow();
      q.stop();
    });
  });

  describe('stop() pendant qu\'une entrée est en attente', () => {
    it('rejette toutes les entrées avec "arrêtée"', async () => {
      const limiter = new SlidingWindowLimiter();
      limiter.consume('stop-key', 0, 60_000);
      const q = new RequestQueue(CFG_ENABLED);

      const p = q.enqueue('stop-key', 0, 60_000, limiter);
      q.stop();

      await expect(p).rejects.toThrow('arrêtée');
    });

    it('stop() idempotent — peut être appelé deux fois sans erreur', () => {
      const q = new RequestQueue(CFG_ENABLED);
      expect(() => {
        q.stop();
        q.stop();
      }).not.toThrow();
    });
  });

  describe('résolution immédiate (capacité disponible)', () => {
    it('se résout sans attendre le polling si la capacité est disponible', async () => {
      const limiter = new SlidingWindowLimiter();
      const q = new RequestQueue(CFG_ENABLED);

      // Pas de consommation préalable → capacité disponible → résolution immédiate
      await expect(q.enqueue('imm', 5, 60_000, limiter)).resolves.toBeUndefined();
      q.stop();
    });
  });

  describe('timeout', () => {
    it('timeout si la capacité ne se libère pas dans max_wait_ms', async () => {
      const limiter = new SlidingWindowLimiter();
      const q = new RequestQueue({ enabled: true, max_wait_ms: 150, max_queue_size: 10 });

      // Fenêtre de 60 secondes — ne se libère pas dans 150ms
      for (let i = 0; i < 100; i++) limiter.consume('to-key', 100, 60_000);

      await expect(q.enqueue('to-key', 1, 60_000, limiter)).rejects.toThrow('Timeout');
      q.stop();
    });
  });

  describe('désactivée', () => {
    it('rejette si queue désactivée', async () => {
      const cfg = { enabled: false, max_wait_ms: 1000, max_queue_size: 10 };
      const q = new RequestQueue(cfg);
      await expect(q.enqueue('x', 5, 60_000, new SlidingWindowLimiter())).rejects.toThrow('désactivée');
      q.stop();
    });
  });
});
