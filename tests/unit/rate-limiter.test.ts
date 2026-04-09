/**
 * Tests unitaires pour RateLimiter haut niveau.
 * All RateLimiter methods are now async — every call requires await.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter } from '../../src/rate-limit/rate-limiter.js';
import { SlidingWindowLimiter } from '../../src/rate-limit/limiter.js';
import type { RateLimitConfig } from '../../src/rate-limit/types.js';

function makeConfig(overrides?: Partial<RateLimitConfig>): RateLimitConfig {
  return {
    enabled: true,
    global: { requests_per_minute: 1000 },
    per_client: { requests_per_minute: 10 },
    overrides: [
      {
        server: 'salesforce',
        requests_per_minute: 50,
        per_tool: {
          search_leads: { requests_per_minute: 5 },
        },
      },
    ],
    ...overrides,
  };
}

describe('RateLimiter', () => {
  let limiter: RateLimiter;
  let rawLimiter: SlidingWindowLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    rawLimiter = new SlidingWindowLimiter();
    limiter = new RateLimiter(makeConfig(), rawLimiter);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('limite globale', () => {
    it('s\'applique à toutes les requêtes', async () => {
      const config = makeConfig({ global: { requests_per_minute: 2 } });
      const rl = new RateLimiter(config, new SlidingWindowLimiter());

      await rl.consume('client-a', 'srv', 'tool');
      await rl.consume('client-b', 'srv', 'tool');

      const r = await rl.consume('client-c', 'srv', 'tool');
      expect(r.allowed).toBe(false);
      expect(r.blocked_by).toContain('global');
    });
  });

  describe('limite par client', () => {
    it('chaque client a sa propre limite', async () => {
      const config = makeConfig({ per_client: { requests_per_minute: 2 }, global: undefined });
      const rl = new RateLimiter(config, new SlidingWindowLimiter());

      await rl.consume('client-a', 'srv', 'tool');
      await rl.consume('client-a', 'srv', 'tool');

      const r = await rl.consume('client-a', 'srv', 'tool');
      expect(r.allowed).toBe(false);
      expect(r.blocked_by).toContain('client');

      // L'autre client n'est pas affecté
      expect((await rl.consume('client-b', 'srv', 'tool')).allowed).toBe(true);
    });
  });

  describe('limite par serveur', () => {
    it('limite de serveur vérifiée', async () => {
      const config = makeConfig({
        global: undefined,
        per_client: undefined,
        overrides: [{ server: 'salesforce', requests_per_minute: 2 }],
      });
      const rl = new RateLimiter(config, new SlidingWindowLimiter());

      await rl.consumeServerLimits('client-a', 'salesforce', 'get_contact');
      await rl.consumeServerLimits('client-a', 'salesforce', 'get_contact');

      const r = await rl.consumeServerLimits('client-a', 'salesforce', 'get_contact');
      expect(r.allowed).toBe(false);
      expect(r.blocked_by).toContain('server');
    });
  });

  describe('limite par outil', () => {
    it('override d\'outil plus restrictif gagne', async () => {
      const config = makeConfig({
        global: undefined,
        per_client: undefined,
        overrides: [{
          server: 'salesforce',
          requests_per_minute: 100,
          per_tool: { search_leads: { requests_per_minute: 2 } },
        }],
      });
      const rl = new RateLimiter(config, new SlidingWindowLimiter());

      await rl.consumeServerLimits('client-a', 'salesforce', 'search_leads');
      await rl.consumeServerLimits('client-a', 'salesforce', 'search_leads');

      const r = await rl.consumeServerLimits('client-a', 'salesforce', 'search_leads');
      expect(r.allowed).toBe(false);
      expect(r.blocked_by).toContain('tool');
    });
  });

  describe('limite la plus restrictive gagne', () => {
    it('global autorise mais client refuse → rejeté', async () => {
      const config = makeConfig({
        global: { requests_per_minute: 1000 },
        per_client: { requests_per_minute: 1 },
        overrides: undefined,
      });
      const rl = new RateLimiter(config, new SlidingWindowLimiter());

      await rl.consumeClientLimits('client-a');

      const r = await rl.consumeClientLimits('client-a');
      expect(r.allowed).toBe(false);
      expect(r.blocked_by).toContain('client');
    });
  });

  describe('consumeClientLimits / consumeServerLimits', () => {
    it('consumeClientLimits ne compte pas les limites serveur', async () => {
      const config = makeConfig({
        global: undefined,
        per_client: { requests_per_minute: 100 },
        overrides: [{ server: 'salesforce', requests_per_minute: 1 }],
      });
      const rl = new RateLimiter(config, new SlidingWindowLimiter());

      // La limite serveur est 1, mais on ne la consomme pas ici
      await rl.consumeClientLimits('client-a');
      const r = await rl.consumeClientLimits('client-a');
      expect(r.allowed).toBe(true); // limite client = 100
    });
  });

  describe('getClientQuota', () => {
    it('retourne les informations de quota correctes', async () => {
      const config = makeConfig({ per_client: { requests_per_minute: 10, requests_per_day: 100 }, global: undefined, overrides: undefined });
      const rl = new RateLimiter(config, new SlidingWindowLimiter());

      await rl.consumeClientLimits('client-a');
      await rl.consumeClientLimits('client-a');

      const quota = await rl.getClientQuota('client-a');
      expect(quota.limits.length).toBeGreaterThan(0);

      const minuteLimit = quota.limits.find((l) => l.label.includes('minute'));
      expect(minuteLimit).toBeDefined();
      expect(minuteLimit?.remaining).toBe(8); // 10 - 2
      expect(minuteLimit?.limit).toBe(10);
    });
  });

  describe('resetClient / resetAll', () => {
    it('resetClient remet à zéro les limites d\'un client', async () => {
      const config = makeConfig({ global: undefined, per_client: { requests_per_minute: 1 }, overrides: undefined });
      const rl = new RateLimiter(config, new SlidingWindowLimiter());

      await rl.consumeClientLimits('client-a');
      expect((await rl.consumeClientLimits('client-a')).allowed).toBe(false);

      rl.resetClient('client-a');
      expect((await rl.consumeClientLimits('client-a')).allowed).toBe(true);
    });

    it('resetAll remet à zéro tous les compteurs', async () => {
      const config = makeConfig({ global: { requests_per_minute: 1 }, per_client: undefined, overrides: undefined });
      const rl = new RateLimiter(config, new SlidingWindowLimiter());

      await rl.consumeClientLimits('client-a');
      expect((await rl.consumeClientLimits('client-a')).allowed).toBe(false);

      rl.resetAll();
      expect((await rl.consumeClientLimits('client-a')).allowed).toBe(true);
    });
  });
});
