import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CacheStore } from '../../src/cache/cache-store.js';
import type { CacheEntry } from '../../src/cache/types.js';
import type { L1CacheConfig } from '../../src/config/types.js';

const DEFAULT_L1_CONFIG: L1CacheConfig = { max_entries: 100, max_entry_size_kb: 64 };

function makeEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    result: { content: 'test result' },
    createdAt: Date.now(),
    ttl: 300,
    toolName: 'get_contact',
    serverId: 'server-1',
    ...overrides,
  };
}

describe('CacheStore', () => {
  let store: CacheStore;

  beforeEach(() => {
    store = new CacheStore(DEFAULT_L1_CONFIG);
  });

  describe('opérations de base', () => {
    it('retourne undefined pour une clé absente', () => {
      expect(store.get('missing-key')).toBeUndefined();
    });

    it('stocke et récupère une entrée', () => {
      const entry = makeEntry();
      store.set('key-1', entry);
      expect(store.get('key-1')).toEqual(entry);
    });

    it('met à jour une entrée existante', () => {
      const e1 = makeEntry({ result: { value: 'first' } });
      const e2 = makeEntry({ result: { value: 'second' } });
      store.set('key-1', e1);
      store.set('key-1', e2);
      expect(store.get('key-1')).toEqual(e2);
    });

    it('supprime une entrée existante', () => {
      store.set('key-1', makeEntry());
      expect(store.delete('key-1')).toBe(true);
      expect(store.get('key-1')).toBeUndefined();
    });

    it('retourne false pour la suppression d\'une clé absente', () => {
      expect(store.delete('nonexistent')).toBe(false);
    });
  });

  describe('expiration TTL', () => {
    it('retourne undefined pour une entrée expirée', () => {
      vi.useFakeTimers();
      const entry = makeEntry({ ttl: 1, createdAt: Date.now() });
      store.set('key-1', entry);
      vi.advanceTimersByTime(2000);
      expect(store.get('key-1')).toBeUndefined();
      vi.useRealTimers();
    });

    it('retourne l\'entrée avant son expiration', () => {
      vi.useFakeTimers();
      const entry = makeEntry({ ttl: 60, createdAt: Date.now() });
      store.set('key-1', entry);
      vi.advanceTimersByTime(30000);
      expect(store.get('key-1')).toEqual(entry);
      vi.useRealTimers();
    });
  });

  describe('statistiques', () => {
    it('commence avec des statistiques à zéro', () => {
      const stats = store.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.entries).toBe(0);
      expect(stats.hitRate).toBe(0);
    });

    it('incrémente les hits lors d\'un accès réussi', () => {
      store.set('key-1', makeEntry());
      store.get('key-1');
      expect(store.getStats().hits).toBe(1);
    });

    it('incrémente les misses lors d\'un accès raté', () => {
      store.get('missing');
      expect(store.getStats().misses).toBe(1);
    });

    it('calcule le taux de succès correctement', () => {
      store.set('key-1', makeEntry());
      store.get('key-1'); // hit
      store.get('key-1'); // hit
      store.get('missing'); // miss
      const stats = store.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3, 5);
    });
  });

  describe('invalidation par serveur', () => {
    it('supprime toutes les entrées d\'un serveur', () => {
      store.set('key-1', makeEntry({ serverId: 'server-a' }));
      store.set('key-2', makeEntry({ serverId: 'server-a' }));
      store.set('key-3', makeEntry({ serverId: 'server-b' }));

      expect(store.deleteByServer('server-a')).toBe(2);
      expect(store.get('key-1')).toBeUndefined();
      expect(store.get('key-2')).toBeUndefined();
      expect(store.get('key-3')).toBeDefined();
    });

    it('retourne 0 pour un serveur sans entrées', () => {
      expect(store.deleteByServer('nonexistent-server')).toBe(0);
    });

    it('nettoie le toolIndex après deleteByServer (pas de références périmées)', () => {
      store.set('key-1', makeEntry({ toolName: 'get_contact', serverId: 'server-a' }));
      store.set('key-2', makeEntry({ toolName: 'get_contact', serverId: 'server-a' }));

      // Suppression par serveur
      store.deleteByServer('server-a');

      // Ajout d'une nouvelle entrée pour le même outil
      store.set('key-new', makeEntry({ toolName: 'get_contact', serverId: 'server-a' }));

      // La nouvelle entrée doit être accessible
      expect(store.get('key-new')).toBeDefined();

      // La suppression par outil ne doit retourner que 1 (la nouvelle entrée)
      expect(store.deleteByTool('get_contact', 'server-a')).toBe(1);
    });
  });

  describe('invalidation par outil', () => {
    it('supprime toutes les entrées d\'un outil spécifique sur un serveur', () => {
      store.set('key-1', makeEntry({ toolName: 'get_contact', serverId: 'server-a' }));
      store.set('key-2', makeEntry({ toolName: 'get_contact', serverId: 'server-a' }));
      store.set('key-3', makeEntry({ toolName: 'search_leads', serverId: 'server-a' }));
      store.set('key-4', makeEntry({ toolName: 'get_contact', serverId: 'server-b' }));

      expect(store.deleteByTool('get_contact', 'server-a')).toBe(2);
      expect(store.get('key-1')).toBeUndefined();
      expect(store.get('key-2')).toBeUndefined();
      expect(store.get('key-3')).toBeDefined();
      expect(store.get('key-4')).toBeDefined();
    });
  });

  describe('invalidation par préfixe', () => {
    it('supprime les entrées dont la clé commence par le préfixe', () => {
      store.set('abc-key-1', makeEntry());
      store.set('abc-key-2', makeEntry());
      store.set('xyz-key-3', makeEntry());

      expect(store.deleteByPrefix('abc-')).toBe(2);
      expect(store.get('abc-key-1')).toBeUndefined();
      expect(store.get('xyz-key-3')).toBeDefined();
    });
  });

  describe('vider le cache', () => {
    it('supprime toutes les entrées et réinitialise les métriques', () => {
      store.set('key-1', makeEntry());
      store.get('key-1');
      store.get('missing');
      store.clear();

      expect(store.size).toBe(0);
      const stats = store.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe('recordSkip', () => {
    it('incrémente le compteur de skips', () => {
      store.recordSkip();
      store.recordSkip();
      expect(store.getStats().skips).toBe(2);
    });
  });
});
