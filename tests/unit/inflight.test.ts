import { describe, it, expect, vi } from 'vitest';
import { InflightTracker } from '../../src/cache/inflight.js';

describe('InflightTracker', () => {
  describe('déduplication basique', () => {
    it('exécute la factory pour la première requête', async () => {
      const tracker = new InflightTracker();
      const factory = vi.fn().mockResolvedValue({ data: 'result' });
      const { result, wasCoalesced } = await tracker.deduplicate('key-1', factory);
      expect(factory).toHaveBeenCalledOnce();
      expect(result).toEqual({ data: 'result' });
      expect(wasCoalesced).toBe(false);
    });
  });

  describe('déduplication de requêtes concurrentes', () => {
    it('coalesce plusieurs requêtes simultanées vers la même clé', async () => {
      const tracker = new InflightTracker();
      let resolveFactory!: (value: Record<string, unknown>) => void;
      const factoryPromise = new Promise<Record<string, unknown>>((resolve) => {
        resolveFactory = resolve;
      });
      const factory = vi.fn().mockReturnValue(factoryPromise);

      const p1 = tracker.deduplicate('key-1', factory);
      const p2 = tracker.deduplicate('key-1', factory);
      const p3 = tracker.deduplicate('key-1', factory);

      expect(factory).toHaveBeenCalledOnce();
      resolveFactory({ value: 42 });

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1.result).toEqual({ value: 42 });
      expect(r2.result).toEqual({ value: 42 });
      expect(r3.result).toEqual({ value: 42 });
      expect(r1.wasCoalesced).toBe(false);
      expect(r2.wasCoalesced).toBe(true);
      expect(r3.wasCoalesced).toBe(true);
    });

    it('ne déduplique pas des requêtes avec des clés différentes', async () => {
      const tracker = new InflightTracker();
      const factory = vi.fn()
        .mockResolvedValueOnce({ data: 'result-a' })
        .mockResolvedValueOnce({ data: 'result-b' });

      const [r1, r2] = await Promise.all([
        tracker.deduplicate('key-a', factory),
        tracker.deduplicate('key-b', factory),
      ]);

      expect(factory).toHaveBeenCalledTimes(2);
      expect(r1.result).toEqual({ data: 'result-a' });
      expect(r2.result).toEqual({ data: 'result-b' });
    });
  });

  describe('nettoyage après résolution', () => {
    it('supprime l\'entrée inflight après résolution', async () => {
      const tracker = new InflightTracker();
      const factory = vi.fn().mockResolvedValue({});
      expect(tracker.size).toBe(0);
      const promise = tracker.deduplicate('key-1', factory);
      expect(tracker.has('key-1')).toBe(true);
      await promise;
      expect(tracker.has('key-1')).toBe(false);
      expect(tracker.size).toBe(0);
    });

    it('supprime l\'entrée inflight même en cas d\'erreur', async () => {
      const tracker = new InflightTracker();
      const factory = vi.fn().mockRejectedValue(new Error('erreur réseau'));
      await expect(tracker.deduplicate('key-1', factory)).rejects.toThrow('erreur réseau');
      expect(tracker.has('key-1')).toBe(false);
    });

    it('permet une nouvelle requête après la résolution', async () => {
      const tracker = new InflightTracker();
      const factory = vi.fn()
        .mockResolvedValueOnce({ round: 1 })
        .mockResolvedValueOnce({ round: 2 });

      const r1 = await tracker.deduplicate('key-1', factory);
      const r2 = await tracker.deduplicate('key-1', factory);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(r1.result).toEqual({ round: 1 });
      expect(r2.result).toEqual({ round: 2 });
    });
  });

  describe('snapshot inflight', () => {
    it('retourne un snapshot vide au démarrage', () => {
      const tracker = new InflightTracker();
      expect(tracker.getInflightSnapshot()).toEqual([]);
    });

    it('inclut les requêtes en cours dans le snapshot', async () => {
      const tracker = new InflightTracker();
      let resolve!: (v: Record<string, unknown>) => void;
      const factory = vi.fn().mockReturnValue(
        new Promise<Record<string, unknown>>((r) => { resolve = r; }),
      );
      const promise = tracker.deduplicate('key-1', factory);
      const snapshot = tracker.getInflightSnapshot();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]?.key).toBe('key-1');
      resolve({});
      await promise;
    });
  });

  describe('gestion des erreurs', () => {
    it('propage les erreurs à tous les appelants coalescés', async () => {
      const tracker = new InflightTracker();
      let rejectFactory!: (error: Error) => void;
      const factoryPromise = new Promise<Record<string, unknown>>((_resolve, reject) => {
        rejectFactory = reject;
      });
      const factory = vi.fn().mockReturnValue(factoryPromise);

      const p1 = tracker.deduplicate('key-1', factory);
      const p2 = tracker.deduplicate('key-1', factory);
      rejectFactory(new Error('erreur partagée'));

      await expect(p1).rejects.toThrow('erreur partagée');
      await expect(p2).rejects.toThrow('erreur partagée');
    });
  });
});
