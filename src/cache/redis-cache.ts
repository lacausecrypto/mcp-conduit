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
  private _errors = 0;

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
   */
  set(key: string, entry: CacheEntry, ttlSeconds: number): void {
    if (!this.client || !this.connected) return;

    const json = JSON.stringify(entry);

    // Guard taille max
    if (json.length > this.maxEntrySizeBytes) return;

    this._writes++;
    this.client.set(this.prefix(key), json, { EX: Math.max(1, Math.ceil(ttlSeconds)) })
      .catch(() => { this._errors++; });
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
      errors: this._errors,
      connected: this.connected,
    };
  }
}
