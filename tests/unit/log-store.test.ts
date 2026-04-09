import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LogStore } from '../../src/observability/log-store.js';
import type { LogEntry } from '../../src/observability/types.js';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    trace_id: `trace-${Math.random().toString(36).slice(2)}`,
    client_id: 'client-1',
    server_id: 'server-1',
    method: 'tools/call',
    tool_name: 'get_contact',
    args: { id: '123' },
    duration_ms: 42,
    status: 'success',
    response_size: 256,
    cache_status: 'MISS',
    ...overrides,
  };
}

describe('LogStore', () => {
  let store: LogStore;

  beforeEach(() => {
    // Utilise une base SQLite en mémoire pour les tests
    store = new LogStore(':memory:', 30);
  });

  afterEach(() => {
    store.close();
  });

  describe('insert et getAll', () => {
    it('insère une entrée et la récupère', () => {
      const entry = makeEntry();
      store.insert(entry);

      const results = store.getAll();
      expect(results).toHaveLength(1);
      expect(results[0]?.trace_id).toBe(entry.trace_id);
      expect(results[0]?.method).toBe('tools/call');
      expect(results[0]?.status).toBe('success');
    });

    it('insère plusieurs entrées', () => {
      store.insert(makeEntry({ trace_id: 'trace-1' }));
      store.insert(makeEntry({ trace_id: 'trace-2' }));
      store.insert(makeEntry({ trace_id: 'trace-3' }));

      expect(store.getAll()).toHaveLength(3);
    });

    it('sérialise et désérialise les args JSON', () => {
      const entry = makeEntry({ args: { id: '123', filter: { active: true } } });
      store.insert(entry);

      const results = store.getAll();
      expect(results[0]?.args).toEqual({ id: '123', filter: { active: true } });
    });

    it('gère les champs optionnels nuls', () => {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        trace_id: 'trace-null',
        client_id: '',
        server_id: '',
        method: 'initialize',
        duration_ms: 10,
        status: 'success',
        response_size: 0,
      };
      store.insert(entry);

      const results = store.getAll();
      expect(results[0]?.tool_name).toBeUndefined();
      expect(results[0]?.args).toBeUndefined();
    });
  });

  describe('filtres', () => {
    beforeEach(() => {
      store.insert(makeEntry({ server_id: 'server-a', tool_name: 'get_contact', status: 'success', cache_status: 'HIT' }));
      store.insert(makeEntry({ server_id: 'server-a', tool_name: 'search_leads', status: 'error', cache_status: 'MISS' }));
      store.insert(makeEntry({ server_id: 'server-b', tool_name: 'get_contact', status: 'success', cache_status: 'MISS' }));
    });

    it('filtre par serveur', () => {
      const results = store.getAll({ server: 'server-a' });
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.server_id).toBe('server-a');
      }
    });

    it('filtre par outil', () => {
      const results = store.getAll({ tool: 'get_contact' });
      expect(results).toHaveLength(2);
    });

    it('filtre par statut', () => {
      const results = store.getAll({ status: 'error' });
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe('error');
    });

    it('applique la pagination (limit)', () => {
      const results = store.getAll({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('applique la pagination (offset)', () => {
      const allResults = store.getAll();
      const paginated = store.getAll({ limit: 10, offset: 2 });
      expect(paginated).toHaveLength(Math.max(0, allResults.length - 2));
    });
  });

  describe('getByTraceId', () => {
    it('récupère les logs d\'une trace spécifique', () => {
      store.insert(makeEntry({ trace_id: 'trace-abc' }));
      store.insert(makeEntry({ trace_id: 'trace-abc' }));
      store.insert(makeEntry({ trace_id: 'trace-xyz' }));

      const results = store.getByTraceId('trace-abc');
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.trace_id).toBe('trace-abc');
      }
    });

    it('retourne un tableau vide pour une trace inconnue', () => {
      expect(store.getByTraceId('unknown-trace')).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('retourne des statistiques vides si pas de logs', () => {
      const stats = store.getStats();
      expect(stats.total_requests).toBe(0);
      expect(stats.avg_latency_ms).toBe(0);
    });

    it('calcule les statistiques correctement', () => {
      store.insert(makeEntry({ status: 'success', duration_ms: 100, cache_status: 'HIT' }));
      store.insert(makeEntry({ status: 'success', duration_ms: 200, cache_status: 'MISS' }));
      store.insert(makeEntry({ status: 'error', duration_ms: 50, cache_status: 'MISS' }));

      const stats = store.getStats();
      expect(stats.total_requests).toBe(3);
      expect(stats.error_rate).toBeCloseTo(1 / 3, 5);
      expect(stats.cache_hit_rate).toBeCloseTo(1 / 3, 5);
      expect(stats.avg_latency_ms).toBeCloseTo((100 + 200 + 50) / 3, 0);
    });
  });

  describe('purgeOldEntries', () => {
    it('supprime les entrées plus anciennes que la rétention', () => {
      // Insertion d'une entrée avec un timestamp ancien
      const oldEntry = makeEntry({
        timestamp: new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString(),
      });
      const recentEntry = makeEntry({ timestamp: new Date().toISOString() });

      store.insert(oldEntry);
      store.insert(recentEntry);

      const deleted = store.purgeOldEntries();
      expect(deleted).toBe(1);
      expect(store.getAll()).toHaveLength(1);
    });

    it('ne supprime pas les entrées récentes', () => {
      store.insert(makeEntry());
      store.insert(makeEntry());

      const deleted = store.purgeOldEntries();
      expect(deleted).toBe(0);
      expect(store.getAll()).toHaveLength(2);
    });
  });

  describe('startPeriodicPurge', () => {
    it('retourne un handle de timer annulable', () => {
      vi.useFakeTimers();
      const timer = store.startPeriodicPurge(1000);
      expect(timer).toBeDefined();
      clearInterval(timer);
      vi.useRealTimers();
    });
  });
});
