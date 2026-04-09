/**
 * Cache L1 en mémoire basé sur LRU (Least Recently Used).
 * Fournit les opérations de base avec TTL par entrée, éviction par taille,
 * et suppression par index pour l'invalidation ciblée.
 */

import { LRUCache } from 'lru-cache';
import type { CacheEntry, CacheStats } from './types.js';
import type { L1CacheConfig } from '../config/types.js';

/** Métriques internes du cache store */
interface StoreMetrics {
  hits: number;
  misses: number;
  skips: number;
}

export class CacheStore {
  private readonly cache: LRUCache<string, CacheEntry>;
  private readonly metrics: StoreMetrics;
  /** Index secondaire : serverId → Set<cacheKey> pour l'invalidation par serveur */
  private readonly serverIndex: Map<string, Set<string>>;
  /** Index secondaire : toolName@serverId → Set<cacheKey> pour l'invalidation par outil */
  private readonly toolIndex: Map<string, Set<string>>;
  /** Taille maximale d'une entrée en octets */
  private readonly maxEntryBytes: number;

  constructor(config: L1CacheConfig) {
    const maxEntryBytes = config.max_entry_size_kb * 1024;
    this.maxEntryBytes = maxEntryBytes;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const store = this;

    this.cache = new LRUCache<string, CacheEntry>({
      max: config.max_entries,
      sizeCalculation: (entry) => {
        return Math.min(
          Buffer.byteLength(JSON.stringify(entry), 'utf-8'),
          maxEntryBytes,
        );
      },
      maxSize: config.max_entries * maxEntryBytes,
      ttl: 0,
      allowStale: false,
      // Nettoie les index secondaires lors d'une éviction LRU silencieuse
      dispose(value: CacheEntry, key: string) {
        store.serverIndex.get(value.serverId)?.delete(key);
        const toolIndexKey = `${value.toolName}@${value.serverId}`;
        store.toolIndex.get(toolIndexKey)?.delete(key);
      },
    });

    this.metrics = { hits: 0, misses: 0, skips: 0 };
    this.serverIndex = new Map();
    this.toolIndex = new Map();
  }

  /**
   * Récupère une entrée du cache.
   * Vérifie l'expiration TTL manuellement.
   */
  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.metrics.misses++;
      return undefined;
    }

    const ageMs = Date.now() - entry.createdAt;
    const ttlMs = entry.ttl * 1000;

    if (ageMs > ttlMs) {
      this.delete(key);
      this.metrics.misses++;
      return undefined;
    }

    this.metrics.hits++;
    return entry;
  }

  /**
   * Stocke une entrée dans le cache avec son TTL.
   * Rejette les entrées dépassant max_entry_size_kb pour éviter les OOM.
   * Met à jour les index secondaires pour l'invalidation.
   */
  set(key: string, entry: CacheEntry): void {
    const sizeBytes = Buffer.byteLength(JSON.stringify(entry), 'utf-8');
    if (sizeBytes > this.maxEntryBytes) {
      // Entrée trop volumineuse — ne pas mettre en cache
      return;
    }
    this.cache.set(key, entry);

    if (!this.serverIndex.has(entry.serverId)) {
      this.serverIndex.set(entry.serverId, new Set());
    }
    this.serverIndex.get(entry.serverId)!.add(key);

    const toolIndexKey = `${entry.toolName}@${entry.serverId}`;
    if (!this.toolIndex.has(toolIndexKey)) {
      this.toolIndex.set(toolIndexKey, new Set());
    }
    this.toolIndex.get(toolIndexKey)!.add(key);
  }

  /**
   * Supprime une entrée spécifique du cache.
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.serverIndex.get(entry.serverId)?.delete(key);
      const toolIndexKey = `${entry.toolName}@${entry.serverId}`;
      this.toolIndex.get(toolIndexKey)?.delete(key);
    }
    return this.cache.delete(key);
  }

  /**
   * Invalide toutes les entrées d'un serveur donné.
   * Nettoie les index secondaires (toolIndex) pour éviter les références périmées.
   */
  deleteByServer(serverId: string): number {
    const keys = this.serverIndex.get(serverId);
    if (!keys) {
      return 0;
    }

    let count = 0;
    for (const key of Array.from(keys)) {
      // Récupérer l'entrée avant suppression pour nettoyer toolIndex
      const entry = this.cache.get(key);
      if (entry) {
        const toolIndexKey = `${entry.toolName}@${entry.serverId}`;
        this.toolIndex.get(toolIndexKey)?.delete(key);
      }
      this.cache.delete(key);
      count++;
    }

    this.serverIndex.delete(serverId);
    return count;
  }

  /**
   * Invalide toutes les entrées d'un outil spécifique sur un serveur.
   */
  deleteByTool(toolName: string, serverId: string): number {
    const toolIndexKey = `${toolName}@${serverId}`;
    const keys = this.toolIndex.get(toolIndexKey);
    if (!keys) {
      return 0;
    }

    let count = 0;
    for (const key of Array.from(keys)) {
      this.cache.delete(key);
      count++;
    }

    const serverKeys = this.serverIndex.get(serverId);
    if (serverKeys) {
      for (const key of Array.from(keys)) {
        serverKeys.delete(key);
      }
    }

    this.toolIndex.delete(toolIndexKey);
    return count;
  }

  /**
   * Invalide toutes les entrées dont la clé commence par un préfixe donné.
   */
  deleteByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Retourne la liste de toutes les clés du cache, avec filtrage optionnel.
   */
  keys(prefix?: string): string[] {
    const allKeys = Array.from(this.cache.keys());
    if (!prefix) {
      return allKeys;
    }
    return allKeys.filter((k) => k.startsWith(prefix));
  }

  /**
   * Retourne les statistiques du cache.
   */
  getStats(): CacheStats {
    const total = this.metrics.hits + this.metrics.misses;
    return {
      hits: this.metrics.hits,
      misses: this.metrics.misses,
      skips: this.metrics.skips,
      entries: this.cache.size,
      hitRate: total > 0 ? this.metrics.hits / total : 0,
    };
  }

  /** Incrémente le compteur de skips (requêtes non-cacheables). */
  recordSkip(): void {
    this.metrics.skips++;
  }

  /** Vide intégralement le cache et réinitialise les métriques. */
  clear(): void {
    this.cache.clear();
    this.serverIndex.clear();
    this.toolIndex.clear();
    this.metrics.hits = 0;
    this.metrics.misses = 0;
    this.metrics.skips = 0;
  }

  /** Retourne le nombre d'entrées actuellement dans le cache. */
  get size(): number {
    return this.cache.size;
  }
}
