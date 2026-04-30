/**
 * Cache L2 basé sur Redis.
 *
 * Stocke les entrées de cache sous forme JSON avec TTL Redis natif.
 * Utilisé comme couche derrière le cache L1 LRU en mémoire pour
 * partager le cache entre instances du gateway (K8s multi-pod).
 *
 * Pattern de clé : {prefix}{cacheKey}
 * Exemple : conduit:cache:a1b2c3d4e5...
 */

import type { CacheEntry } from './types.js';

type RedisClientType = Awaited<ReturnType<typeof import('redis').createClient>>;

/** Statistiques du cache L2 */
export interface L2CacheStats {
  hits: number;
  misses: number;
  writes: number;
  /** Writes skipped by the in-flight coalesce window (audit Sprint 3 #7). */
  writes_coalesced: number;
  errors: number;
  connected: boolean;
}

export class RedisCacheStore {
  private client: RedisClientType | null = null;
  private readonly redisUrl: string;
  private readonly keyPrefix: string;
  private readonly maxEntrySizeBytes: number;
  private connected = false;

  /** Compteurs de stats */
  private _hits = 0;
  private _misses = 0;
  private _writes = 0;
  private _writesCoalesced = 0;
  private _errors = 0;

  /**
   * Audit Sprint 3 #7 — L2 stampede write deduplication.
   *
   * Even with single-flight at the upstream layer, all coalesced callers
   * still race to `set()` the same key with the same payload. Without
   * deduping, a 50-way concurrent miss yields 50 Redis writes (and 50× the
   * downstream traffic). We track the last successful write per key and skip
   * subsequent writes that arrive within the coalesce window — the first
   * write was identical (single upstream call) so duplicates are safe to
   * drop.
   *
   * The window is short: just enough to absorb the burst from a single
   * stampede, not so long that it dampens legitimate refreshes.
   */
  private readonly recentWrites = new Map<string, number>();
  private static readonly WRITE_COALESCE_WINDOW_MS = 200;
  /** Cap to keep the dedup map from growing unbounded under churn. */
  private static readonly RECENT_WRITES_MAX = 4096;

  constructor(
    redisUrl: string,
    keyPrefix = 'conduit:cache:',
    maxEntrySizeKb = 512,
  ) {
    this.redisUrl = redisUrl;
    this.keyPrefix = keyPrefix;
    this.maxEntrySizeBytes = maxEntrySizeKb * 1024;
  }

  private prefix(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /** Connexion à Redis. */
  async connect(): Promise<void> {
    const { createClient } = await import('redis');
    this.client = createClient({
      url: this.redisUrl,
      socket: { connectTimeout: 3000, reconnectStrategy: false },
    });

    this.client.on('error', (err: unknown) => {
      console.error('[Conduit/Redis] Cache L2 Redis error:', err);
    });

    await this.client.connect();
    this.connected = true;
  }

  /** Déconnexion. */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.disconnect();
      this.connected = false;
    }
  }

  /** Health check. */
  async ping(): Promise<boolean> {
    try {
      if (!this.client || !this.connected) return false;
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Récupère une entrée du cache L2.
   * Retourne undefined si absente, expirée, ou en erreur.
   * Timeout court (100ms) pour ne pas ralentir le pipeline.
   */
  async get(key: string): Promise<CacheEntry | undefined> {
    if (!this.client || !this.connected) return undefined;

    try {
      const raw = await Promise.race([
        this.client.get(this.prefix(key)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
      ]);

      if (!raw) {
        this._misses++;
        return undefined;
      }

      const entry = JSON.parse(raw) as CacheEntry;

      // Vérifier le TTL applicatif (ceinture et bretelles avec TTL Redis)
      const age = (Date.now() - entry.createdAt) / 1000;
      if (age > entry.ttl) {
        this._misses++;
        return undefined;
      }

      this._hits++;
      return entry;
    } catch {
      this._errors++;
      return undefined;
    }
  }

  /**
   * Stocke une entrée dans le cache L2.
   * Fire-and-forget : les erreurs sont comptées mais pas propagées.
   * Coalesces stampede-induced duplicate writes in a short window.
   */
  set(key: string, entry: CacheEntry, ttlSeconds: number): void {
    if (!this.client || !this.connected) return;

    const json = JSON.stringify(entry);

    // Guard taille max
    if (json.length > this.maxEntrySizeBytes) return;

    const now = Date.now();
    const recent = this.recentWrites.get(key);
    if (recent !== undefined && recent > now) {
      // A write for this key landed less than WRITE_COALESCE_WINDOW_MS ago.
      // The payload was produced by the same single-flight upstream call,
      // so re-writing it is redundant Redis traffic.
      this._writesCoalesced++;
      return;
    }
    this.markWrite(key, now);

    this._writes++;
    this.client.set(this.prefix(key), json, { EX: Math.max(1, Math.ceil(ttlSeconds)) })
      .catch(() => { this._errors++; });
  }

  /**
   * Records a write timestamp and prunes the in-memory dedup map to keep it
   * bounded. Pruning expires entries are removed lazily here rather than via
   * a background timer.
   */
  private markWrite(key: string, now: number): void {
    const expiresAt = now + RedisCacheStore.WRITE_COALESCE_WINDOW_MS;
    this.recentWrites.set(key, expiresAt);

    if (this.recentWrites.size > RedisCacheStore.RECENT_WRITES_MAX) {
      // Remove every expired entry; if still over the cap, drop the oldest
      // (insertion-order) until we are under the limit. Map iteration is
      // O(n) so this only fires when the cap is exceeded.
      for (const [k, v] of this.recentWrites) {
        if (v <= now) this.recentWrites.delete(k);
        if (this.recentWrites.size <= RedisCacheStore.RECENT_WRITES_MAX) break;
      }
      while (this.recentWrites.size > RedisCacheStore.RECENT_WRITES_MAX) {
        const firstKey = this.recentWrites.keys().next().value;
        if (firstKey === undefined) break;
        this.recentWrites.delete(firstKey);
      }
    }
  }

  /** Supprime une clé spécifique. */
  async delete(key: string): Promise<boolean> {
    if (!this.client || !this.connected) return false;
    try {
      const count = await this.client.del(this.prefix(key));
      return count > 0;
    } catch {
      this._errors++;
      return false;
    }
  }

  /**
   * Supprime toutes les clés correspondant à un pattern (SCAN-based, non-blocking).
   */
  async deleteByPattern(pattern: string): Promise<number> {
    if (!this.client || !this.connected) return 0;
    let deleted = 0;
    try {
      for await (const keys of this.client.scanIterator({
        MATCH: `${this.keyPrefix}${pattern}`,
        COUNT: 100,
      })) {
        if (keys.length > 0) {
          await Promise.all(keys.map((k) => this.client!.del(k)));
          deleted += keys.length;
        }
      }
    } catch {
      this._errors++;
    }
    return deleted;
  }

  /**
   * Supprime toutes les entrées appartenant à un outil donné sur un serveur.
   * Scan+inspect est utilisé ici car l'invalidation destructive est rare.
   */
  async deleteByTool(toolName: string, serverId: string): Promise<number> {
    if (!this.client || !this.connected) return 0;

    let deleted = 0;
    try {
      for await (const keys of this.client.scanIterator({
        MATCH: `${this.keyPrefix}*`,
        COUNT: 100,
      })) {
        for (const key of keys) {
          const raw = await this.client.get(key);
          if (!raw) continue;

          let entry: CacheEntry;
          try {
            entry = JSON.parse(raw) as CacheEntry;
          } catch {
            this._errors++;
            continue;
          }

          if (entry.toolName === toolName && entry.serverId === serverId) {
            deleted += await this.client.del(key);
          }
        }
      }
    } catch {
      this._errors++;
    }

    return deleted;
  }

  /** Vide tout le cache L2 (toutes les clés sous le prefix). */
  async flush(): Promise<number> {
    return this.deleteByPattern('*');
  }

  /** Retourne les statistiques du cache L2. */
  getStats(): L2CacheStats {
    return {
      hits: this._hits,
      misses: this._misses,
      writes: this._writes,
      writes_coalesced: this._writesCoalesced,
      errors: this._errors,
      connected: this.connected,
    };
  }
}
