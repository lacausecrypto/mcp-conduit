/**
 * Tests unitaires pour SlidingWindowLimiter.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SlidingWindowLimiter } from '../../src/rate-limit/limiter.js';

describe('SlidingWindowLimiter', () => {
  let limiter: SlidingWindowLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowLimiter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('check (sans consommation)', () => {
    it('retourne allowed=true si en-dessous de la limite', () => {
      const result = limiter.check('test', 5, 60_000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5);
      expect(result.limit).toBe(5);
    });

    it('ne consomme pas de token', () => {
      limiter.check('test', 1, 60_000);
      limiter.check('test', 1, 60_000);
      // Toujours allowed car aucun token consommé
      expect(limiter.check('test', 1, 60_000).allowed).toBe(true);
    });
  });

  describe('consume', () => {
    it('requête dans la limite → autorisée, remaining décrémenté', () => {
      const r1 = limiter.consume('test', 3, 60_000);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);

      const r2 = limiter.consume('test', 3, 60_000);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);
    });

    it('requêtes au-delà de la limite → rejetées avec retry_after', () => {
      limiter.consume('test', 2, 60_000);
      limiter.consume('test', 2, 60_000);

      const r3 = limiter.consume('test', 2, 60_000);
      expect(r3.allowed).toBe(false);
      expect(r3.remaining).toBe(0);
      expect(r3.retry_after).toBeGreaterThan(0);
    });

    it('retry_after est en secondes entières ≥ 1', () => {
      limiter.consume('test', 1, 60_000);
      const r = limiter.consume('test', 1, 60_000);
      expect(r.retry_after).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(r.retry_after)).toBe(true);
    });
  });

  describe('fenêtre glissante', () => {
    it('les anciens tokens expirent, libérant de la capacité', () => {
      const WINDOW = 10_000; // 10 secondes
      limiter.consume('test', 2, WINDOW);
      limiter.consume('test', 2, WINDOW);

      // Limite atteinte
      expect(limiter.consume('test', 2, WINDOW).allowed).toBe(false);

      // Avancer le temps au-delà de la fenêtre
      vi.advanceTimersByTime(WINDOW + 1);

      // Maintenant la capacité est libérée
      const r = limiter.consume('test', 2, WINDOW);
      expect(r.allowed).toBe(true);
    });
  });

  describe('reset', () => {
    it('reset vide les compteurs d\'une clé', () => {
      limiter.consume('test', 1, 60_000);
      expect(limiter.consume('test', 1, 60_000).allowed).toBe(false);

      limiter.reset('test');
      expect(limiter.consume('test', 1, 60_000).allowed).toBe(true);
    });

    it('resetAll vide tous les compteurs', () => {
      limiter.consume('key-a', 1, 60_000);
      limiter.consume('key-b', 1, 60_000);

      limiter.resetAll();

      expect(limiter.consume('key-a', 1, 60_000).allowed).toBe(true);
      expect(limiter.consume('key-b', 1, 60_000).allowed).toBe(true);
    });
  });

  describe('isolation des fenêtres', () => {
    it('même clé, fenêtres différentes → stockage isolé', () => {
      // Consommer 3 tokens en fenêtre de 1 minute
      limiter.consume('key', 3, 60_000);
      limiter.consume('key', 3, 60_000);
      limiter.consume('key', 3, 60_000);

      // La fenêtre journalière (distinct) doit rester intacte
      const dayResult = limiter.consume('key', 100, 86_400_000);
      expect(dayResult.allowed).toBe(true);
      expect(dayResult.remaining).toBe(99); // 100 - 1 consommé

      // La fenêtre minute est épuisée
      const minuteResult = limiter.consume('key', 3, 60_000);
      expect(minuteResult.allowed).toBe(false);
    });
  });

  describe('getUsage', () => {
    it('retourne le compte correct', () => {
      limiter.consume('test', 10, 60_000);
      limiter.consume('test', 10, 60_000);

      const usage = limiter.getUsage('test', 60_000);
      expect(usage.count).toBe(2);
    });
  });

  // ── Battle-test #1 — unbounded keys / memory leak ─────────────────────────
  describe('memory bounded under unique-key flood', () => {
    it('expired buckets are pruned on access (no zombie keys)', () => {
      const l = new SlidingWindowLimiter();
      l.consume('one-shot', 5, 100);
      expect(l.size).toBe(1);
      // Advance past the window so the timestamp is expired.
      vi.advanceTimersByTime(150);
      // Any access through getValid should now drop the empty bucket.
      l.check('one-shot', 5, 100);
      expect(l.size).toBe(0);
    });

    it('hard cap on map size — oldest insertion-order buckets evicted', () => {
      const l = new SlidingWindowLimiter({ maxBuckets: 100 });
      for (let i = 0; i < 1_000; i++) {
        l.consume(`k-${i}`, 100, 60_000);
      }
      // Cap is 100; the eviction target is 90% (90), and the loop pushes
      // back up to 100 by the time it exits. Either way we're bounded.
      expect(l.size).toBeLessThanOrEqual(100);
      expect(l.size).toBeGreaterThan(0);
    });

    it('flood of unique keys does not produce a zombie map at quiet time', () => {
      const l = new SlidingWindowLimiter();
      for (let i = 0; i < 5_000; i++) {
        l.consume(`flood-${i}`, 5, 50);
      }
      vi.advanceTimersByTime(60); // past window
      // Quiet time: no consume() calls, but the next operation that touches
      // each key would prune it. Simulate by checking each key once.
      for (let i = 0; i < 5_000; i++) {
        l.check(`flood-${i}`, 5, 50);
      }
      expect(l.size).toBe(0);
    });

    it('reset resets remaining slots immediately (no stale buckets)', () => {
      const l = new SlidingWindowLimiter();
      l.consume('user', 3, 60_000);
      l.consume('user', 3, 60_000);
      expect(l.size).toBe(1);
      l.reset('user');
      expect(l.size).toBe(0);
    });
  });
});
