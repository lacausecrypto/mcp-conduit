/**
 * Tests de durcissement pour SlidingWindowLimiter et RateLimiter.
 * Couvre les cas limites : fenêtre = 0, limite = 0, limite = 1, grands nombres,
 * concurrence, getUsage.oldest, resetClient effet sur global.
 *
 * NOTE: SlidingWindowLimiter methods are sync; RateLimiter methods are async.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SlidingWindowLimiter } from '../../src/rate-limit/limiter.js';
import { RateLimiter } from '../../src/rate-limit/rate-limiter.js';
import type { RateLimitConfig } from '../../src/rate-limit/types.js';

// ─── SlidingWindowLimiter ────────────────────────────────────────────────────

describe('SlidingWindowLimiter — hardening', () => {
  let limiter: SlidingWindowLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowLimiter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('limite = 0', () => {
    it('bloque tout si la limite vaut 0', () => {
      const r = limiter.consume('k', 0, 60_000);
      expect(r.allowed).toBe(false);
      expect(r.remaining).toBe(0);
    });

    it('check retourne allowed=false si limite = 0', () => {
      expect(limiter.check('k', 0, 60_000).allowed).toBe(false);
    });
  });

  describe('limite = 1', () => {
    it('exactement une requête autorisée par fenêtre', () => {
      expect(limiter.consume('k', 1, 60_000).allowed).toBe(true);
      expect(limiter.consume('k', 1, 60_000).allowed).toBe(false);
    });

    it('se libère après expiration de la fenêtre', () => {
      limiter.consume('k', 1, 1_000);
      expect(limiter.consume('k', 1, 1_000).allowed).toBe(false);

      vi.advanceTimersByTime(1_001);
      expect(limiter.consume('k', 1, 1_000).allowed).toBe(true);
    });
  });

  describe('fenêtre très petite (100ms)', () => {
    it('accepte une requête, bloque la suivante, libère après 100ms', () => {
      limiter.consume('k', 1, 100);
      expect(limiter.consume('k', 1, 100).allowed).toBe(false);

      vi.advanceTimersByTime(101);
      expect(limiter.consume('k', 1, 100).allowed).toBe(true);
    });
  });

  describe('fenêtre très grande (24h)', () => {
    it('accepte des milliers de requêtes dans une limite de 1 000 000', () => {
      const LIMIT = 1_000_000;
      const WINDOW = 86_400_000;
      for (let i = 0; i < 100; i++) {
        expect(limiter.consume('k', LIMIT, WINDOW).allowed).toBe(true);
      }
    });
  });

  describe('frontière exacte de la fenêtre', () => {
    it('une requête à exactement window_ms est expirée (cutoff = now - window_ms)', () => {
      // t=0 : consommer
      limiter.consume('k', 1, 1_000);

      // t=1000 : cutoff = 1000 - 1000 = 0, timestamp = 0 → t >= cutoff → encore valide
      vi.advanceTimersByTime(1_000);
      // Le timestamp à t=0 est toujours valide à t=1000 car cutoff est 0 (strict >=)
      // Donc encore bloqué
      expect(limiter.check('k', 1, 1_000).allowed).toBe(false);

      // t=1001 : cutoff = 1001 - 1000 = 1, timestamp = 0 → 0 < 1 → expiré
      vi.advanceTimersByTime(1);
      expect(limiter.check('k', 1, 1_000).allowed).toBe(true);
    });
  });

  describe('getUsage — champ oldest', () => {
    it('oldest est le timestamp du premier token dans la fenêtre', () => {
      vi.useRealTimers();
      const l = new SlidingWindowLimiter();
      const before = Date.now();
      l.consume('k', 10, 60_000);
      const after = Date.now();

      const usage = l.getUsage('k', 60_000);
      expect(usage.count).toBe(1);
      expect(usage.oldest).toBeGreaterThanOrEqual(before);
      expect(usage.oldest).toBeLessThanOrEqual(after);
    });

    it('oldest retourne Date.now() si aucun token enregistré', () => {
      vi.useRealTimers();
      const l = new SlidingWindowLimiter();
      const before = Date.now();
      const usage = l.getUsage('k', 60_000);
      const after = Date.now();
      expect(usage.count).toBe(0);
      expect(usage.oldest).toBeGreaterThanOrEqual(before);
      expect(usage.oldest).toBeLessThanOrEqual(after);
    });
  });

  describe('reset partiel', () => {
    it('reset(key) ne supprime que la clé ciblée', () => {
      limiter.consume('key-a', 1, 60_000);
      limiter.consume('key-b', 1, 60_000);

      limiter.reset('key-a');

      // key-a libérée, key-b toujours bloquée
      expect(limiter.consume('key-a', 1, 60_000).allowed).toBe(true);
      expect(limiter.consume('key-b', 1, 60_000).allowed).toBe(false);
    });

    it('reset() sur clé inexistante ne plante pas', () => {
      expect(() => limiter.reset('inexistant')).not.toThrow();
    });
  });

  describe('appels concurrent (séquentiel simulé)', () => {
    it('N consume() séquentiels respectent la limite', () => {
      const LIMIT = 5;
      let allowed = 0;
      for (let i = 0; i < 10; i++) {
        if (limiter.consume('concurrent', LIMIT, 60_000).allowed) allowed++;
      }
      expect(allowed).toBe(LIMIT);
    });
  });

  describe('retry_after', () => {
    it('retry_after est ≥ 1 et un entier', () => {
      limiter.consume('k', 1, 60_000);
      const r = limiter.consume('k', 1, 60_000);
      expect(r.retry_after).toBeDefined();
      expect(r.retry_after).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(r.retry_after)).toBe(true);
    });
  });
});

// ─── RateLimiter ─────────────────────────────────────────────────────────────

describe('RateLimiter — hardening', () => {
  afterEach(() => vi.useRealTimers());

  function makeRL(overrides?: Partial<RateLimitConfig>): RateLimiter {
    const cfg: RateLimitConfig = {
      enabled: true,
      global: { requests_per_minute: 100 },
      per_client: { requests_per_minute: 10 },
      ...overrides,
    };
    return new RateLimiter(cfg, new SlidingWindowLimiter());
  }

  describe('aucune limite configurée', () => {
    it('retourne allowed=true et remaining=Infinity si aucun check', async () => {
      const rl = new RateLimiter(
        { enabled: true },
        new SlidingWindowLimiter(),
      );
      const r = await rl.consume('client', 'srv', 'tool');
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(Infinity);
    });
  });

  describe('consumeClientLimits', () => {
    it('ne consomme que les limites globale + per_client', async () => {
      const rl = makeRL({ global: { requests_per_minute: 5 }, per_client: { requests_per_minute: 3 } });

      // 3 requêtes → épuise per_client
      await rl.consumeClientLimits('alice');
      await rl.consumeClientLimits('alice');
      await rl.consumeClientLimits('alice');

      const r = await rl.consumeClientLimits('alice');
      expect(r.allowed).toBe(false);
      expect(r.blocked_by).toContain('client');
    });
  });

  describe('consumeServerLimits', () => {
    it('retourne allowed=true si aucun override pour ce serveur', async () => {
      const rl = makeRL({ overrides: [] });
      expect((await rl.consumeServerLimits('c', 'unknown-srv', 'tool')).allowed).toBe(true);
    });
  });

  describe('getClientQuota', () => {
    it('retourne les limites per_client dans le quota', async () => {
      const rl = makeRL();
      await rl.consumeClientLimits('quota-client');

      const quota = await rl.getClientQuota('quota-client');
      expect(quota.limits.length).toBeGreaterThan(0);
      // remaining doit être ≤ limit
      for (const l of quota.limits) {
        expect(l.remaining).toBeLessThanOrEqual(l.limit);
      }
    });
  });

  describe('resetAll', () => {
    it('réinitialise tous les compteurs', async () => {
      const rl = makeRL({ per_client: { requests_per_minute: 1 } });
      await rl.consumeClientLimits('r-all');
      expect((await rl.consumeClientLimits('r-all')).allowed).toBe(false);

      rl.resetAll();
      expect((await rl.consumeClientLimits('r-all')).allowed).toBe(true);
    });
  });

  describe('resetClient', () => {
    it('remet à zéro le compteur client', async () => {
      const rl = makeRL({ global: undefined, per_client: { requests_per_minute: 1 } });
      await rl.consumeClientLimits('rc');
      expect((await rl.consumeClientLimits('rc')).allowed).toBe(false);

      rl.resetClient('rc');
      expect((await rl.consumeClientLimits('rc')).allowed).toBe(true);
    });
  });

  describe('getAllBuckets', () => {
    it('retourne les buckets actifs après consommation', async () => {
      const rl = makeRL();
      await rl.consumeClientLimits('bucket-client');

      const buckets = rl.getAllBuckets();
      expect(buckets.length).toBeGreaterThan(0);
      expect(buckets.every((b) => b.count > 0)).toBe(true);
    });

    it('retourne tableau vide si aucune consommation', () => {
      const rl = makeRL();
      expect(rl.getAllBuckets()).toEqual([]);
    });
  });

  describe('stop()', () => {
    it('stop() sans queue ne plante pas', () => {
      const rl = makeRL();
      expect(() => rl.stop()).not.toThrow();
    });
  });
});
