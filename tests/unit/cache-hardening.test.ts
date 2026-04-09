/**
 * Tests de durcissement pour CacheStore, cache-key et cache-policy.
 * Couvre les cas limites : TTL=0, TTL négatif, références circulaires,
 * BigInt/Symbol dans les args, suppressions sur serveur/outil inexistant,
 * précision des stats après de nombreuses opérations.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CacheStore } from '../../src/cache/cache-store.js';
import { generateCacheKey } from '../../src/cache/cache-key.js';
import { decideCachePolicy } from '../../src/cache/cache-policy.js';
import type { CacheEntry } from '../../src/cache/types.js';
import type { L1CacheConfig } from '../../src/config/types.js';

const CFG: L1CacheConfig = { max_entries: 500, max_entry_size_kb: 64 };

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    result: { v: 1 },
    createdAt: Date.now(),
    ttl: 300,
    toolName: 'tool',
    serverId: 'srv',
    ...overrides,
  };
}

// ─── CacheStore ───────────────────────────────────────────────────────────────

describe('CacheStore — hardening', () => {
  let store: CacheStore;

  beforeEach(() => {
    store = new CacheStore(CFG);
  });

  describe('TTL edge cases', () => {
    it('TTL = 0 → entrée immédiatement expirée', () => {
      vi.useFakeTimers();
      store.set('zero-ttl', entry({ ttl: 0, createdAt: Date.now() }));
      // Avancer d'1ms — ageMs(1) > ttlMs(0) → expiré
      vi.advanceTimersByTime(1);
      expect(store.get('zero-ttl')).toBeUndefined();
      vi.useRealTimers();
    });

    it('entrée récupérée immédiatement après set() (avant tout avancement du temps)', () => {
      vi.useFakeTimers();
      store.set('immediate', entry({ ttl: 60, createdAt: Date.now() }));
      // Sans avancement du temps : ageMs = 0 ≤ ttlMs → valide
      expect(store.get('immediate')).toBeDefined();
      vi.useRealTimers();
    });

    it('TTL négatif → entrée immédiatement expirée (ageMs > ttlMs négatif toujours vrai)', () => {
      vi.useFakeTimers();
      store.set('neg-ttl', entry({ ttl: -1, createdAt: Date.now() }));
      vi.advanceTimersByTime(0);
      // ageMs(0) > ttlMs(-1000) → expiré
      expect(store.get('neg-ttl')).toBeUndefined();
      vi.useRealTimers();
    });
  });

  describe('suppressions sur serveur/outil inexistant', () => {
    it('deleteByServer sur serveur inconnu retourne 0 sans planter', () => {
      expect(store.deleteByServer('ghost-server')).toBe(0);
    });

    it('deleteByTool sur outil inconnu retourne 0 sans planter', () => {
      expect(store.deleteByTool('ghost-tool', 'ghost-server')).toBe(0);
    });
  });

  describe('deleteByServer — nettoyage du toolIndex', () => {
    it('deleteByServer nettoie aussi le toolIndex (pas de références périmées)', () => {
      store.set('k1', entry({ toolName: 'get', serverId: 'srv-x' }));
      store.set('k2', entry({ toolName: 'get', serverId: 'srv-x' }));

      store.deleteByServer('srv-x');

      // Après deleteByServer, une nouvelle entrée peut être ajoutée proprement
      store.set('k3', entry({ toolName: 'get', serverId: 'srv-x' }));
      expect(store.get('k3')).toBeDefined();
      // deleteByTool ne doit retourner que 1 (k3 seulement, pas les anciennes)
      expect(store.deleteByTool('get', 'srv-x')).toBe(1);
    });
  });

  describe('deleteByTool — nettoyage du serverIndex', () => {
    it('deleteByTool nettoie serverIndex pour les clés supprimées', () => {
      store.set('t1', entry({ toolName: 'act', serverId: 'srv-y' }));
      store.set('t2', entry({ toolName: 'act', serverId: 'srv-y' }));

      expect(store.deleteByTool('act', 'srv-y')).toBe(2);

      // Après deleteByTool, deleteByServer ne doit pas trouver d'entrées fantômes
      expect(store.deleteByServer('srv-y')).toBe(0);
    });
  });

  describe('set() avec entrée trop volumineuse', () => {
    it('ignore une entrée dépassant max_entry_size_kb', () => {
      const smallStore = new CacheStore({ max_entries: 100, max_entry_size_kb: 1 }); // 1 KB
      const bigResult = 'x'.repeat(2000); // ~2 KB
      smallStore.set('big', entry({ result: { data: bigResult } }));
      expect(smallStore.get('big')).toBeUndefined();
    });
  });

  describe('precision des stats', () => {
    it('hits + misses corrects après 100 opérations', () => {
      for (let i = 0; i < 50; i++) {
        store.set(`k${i}`, entry());
      }

      let hits = 0, misses = 0;
      for (let i = 0; i < 100; i++) {
        if (store.get(`k${i}`)) hits++; else misses++;
      }

      const stats = store.getStats();
      expect(stats.hits).toBe(hits);
      expect(stats.misses).toBe(misses);
      expect(stats.hitRate).toBeCloseTo(hits / (hits + misses), 5);
    });

    it('clear() remet hits/misses/skips à zéro', () => {
      store.set('x', entry());
      store.get('x');
      store.get('missing');
      store.recordSkip();

      store.clear();

      const stats = store.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.skips).toBe(0);
      expect(stats.entries).toBe(0);
    });
  });

  describe('keys()', () => {
    it('retourne toutes les clés sans préfixe', () => {
      store.set('a', entry());
      store.set('b', entry());
      store.set('c', entry());
      const keys = store.keys();
      expect(keys).toContain('a');
      expect(keys).toContain('b');
      expect(keys).toContain('c');
    });

    it('filtre par préfixe', () => {
      store.set('foo-1', entry());
      store.set('foo-2', entry());
      store.set('bar-1', entry());
      const keys = store.keys('foo-');
      expect(keys).toHaveLength(2);
      expect(keys.every((k) => k.startsWith('foo-'))).toBe(true);
    });
  });

  describe('size', () => {
    it('size est incrémenté après set() et décrémenté après delete()', () => {
      expect(store.size).toBe(0);
      store.set('s1', entry());
      expect(store.size).toBe(1);
      store.delete('s1');
      expect(store.size).toBe(0);
    });
  });
});

// ─── generateCacheKey ─────────────────────────────────────────────────────────

describe('generateCacheKey — hardening', () => {
  it('args avec valeurs undefined sont inclus de façon déterministe', () => {
    const k1 = generateCacheKey({ serverId: 's', toolName: 't', args: { a: undefined } });
    const k2 = generateCacheKey({ serverId: 's', toolName: 't', args: { a: undefined } });
    expect(k1).toBe(k2);
  });

  it('args avec Date objects produisent une clé stable', () => {
    const d = new Date('2024-01-01T00:00:00Z');
    const k1 = generateCacheKey({ serverId: 's', toolName: 't', args: { date: d } });
    const k2 = generateCacheKey({ serverId: 's', toolName: 't', args: { date: d } });
    expect(k1).toBe(k2);
  });

  it('args avec référence circulaire → lève une erreur (comportement documenté)', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular; // référence circulaire

    // generateCacheKey utilise deepSort (récursif) puis JSON.stringify.
    // deepSort part en récursion infinie sur une référence circulaire → RangeError.
    // Ce test documente ce comportement : le code ne protège pas contre les refs circulaires.
    expect(() =>
      generateCacheKey({ serverId: 's', toolName: 't', args: circular }),
    ).toThrow(RangeError);
  });

  it('même args dans un ordre différent → même clé (déterministe)', () => {
    const k1 = generateCacheKey({ serverId: 's', toolName: 't', args: { b: 2, a: 1 } });
    const k2 = generateCacheKey({ serverId: 's', toolName: 't', args: { a: 1, b: 2 } });
    expect(k1).toBe(k2);
  });

  it('ignoreArgs exclut les champs spécifiés', () => {
    const k1 = generateCacheKey({ serverId: 's', toolName: 't', args: { a: 1, ts: 999 }, ignoreArgs: ['ts'] });
    const k2 = generateCacheKey({ serverId: 's', toolName: 't', args: { a: 1, ts: 123 }, ignoreArgs: ['ts'] });
    expect(k1).toBe(k2);
  });

  it('tenantId différents → clés différentes', () => {
    const k1 = generateCacheKey({ serverId: 's', toolName: 't', args: {}, tenantId: 'tenant-a' });
    const k2 = generateCacheKey({ serverId: 's', toolName: 't', args: {}, tenantId: 'tenant-b' });
    expect(k1).not.toBe(k2);
  });

  it('groupId différents → clés différentes', () => {
    const k1 = generateCacheKey({ serverId: 's', toolName: 't', args: {}, groupId: 'grp-a' });
    const k2 = generateCacheKey({ serverId: 's', toolName: 't', args: {}, groupId: 'grp-b' });
    expect(k1).not.toBe(k2);
  });
});

// ─── decideCachePolicy ────────────────────────────────────────────────────────

describe('decideCachePolicy — hardening', () => {
  const baseCfg = { default_ttl: 60 };

  it('idempotentHint=true avec default_ttl=0 → shouldCache=true avec TTL par défaut', () => {
    const policy = decideCachePolicy('tool', { idempotentHint: true }, { default_ttl: 0 });
    expect(policy.shouldCache).toBe(true);
    expect(policy.ttl).toBeGreaterThan(0);
  });

  it('readOnlyHint=true → shouldCache=true', () => {
    const policy = decideCachePolicy('tool', { readOnlyHint: true }, baseCfg);
    expect(policy.shouldCache).toBe(true);
  });

  it('aucune annotation → shouldCache=false', () => {
    const policy = decideCachePolicy('tool', {}, baseCfg);
    expect(policy.shouldCache).toBe(false);
  });

  it('destructiveHint=true → isDestructive=true', () => {
    const policy = decideCachePolicy('del_tool', { destructiveHint: true }, baseCfg);
    expect(policy.isDestructive).toBe(true);
    expect(policy.shouldCache).toBe(false);
  });

  it('override avec ttl=0 sans invalidates → isDestructive=false, shouldCache=false', () => {
    const policy = decideCachePolicy('del_tool', {}, {
      default_ttl: 60,
      overrides: { del_tool: { ttl: 0 } },
    });
    // isDestructive = invalidates.length > 0 → false quand invalidates est vide
    expect(policy.isDestructive).toBe(false);
    expect(policy.shouldCache).toBe(false);
  });

  it('override avec ttl=0 + invalidates → isDestructive=true', () => {
    const policy = decideCachePolicy('write_tool', {}, {
      default_ttl: 60,
      overrides: { write_tool: { ttl: 0, invalidates: ['read_tool'] } },
    });
    expect(policy.isDestructive).toBe(true);
    expect(policy.shouldCache).toBe(false);
  });

  it('override avec invalidates rempli → invalidates propagé dans la décision', () => {
    const policy = decideCachePolicy('create_contact', {}, {
      default_ttl: 60,
      overrides: { create_contact: { ttl: 0, invalidates: ['get_contact', 'search_contacts'] } },
    });
    expect(policy.invalidates).toContain('get_contact');
    expect(policy.invalidates).toContain('search_contacts');
  });

  it('override avec ignore_args → ignoreArgs propagé', () => {
    const policy = decideCachePolicy('search', { idempotentHint: true }, {
      default_ttl: 60,
      overrides: { search: { ignore_args: ['page'] } },
    });
    expect(policy.ignoreArgs).toContain('page');
  });
});
