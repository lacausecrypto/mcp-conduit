/**
 * Sliding Window Rate Limiter.
 *
 * Algorithme :
 * - Maintient un tableau de timestamps de requêtes par clé (key:window_ms)
 * - À chaque requête, supprime les timestamps antérieurs à (now - window_ms)
 * - Si count < limit → autoriser et enregistrer le timestamp
 * - Si count >= limit → refuser avec retry_after
 */

import type { RateLimitResult } from './types.js';

export class SlidingWindowLimiter {
  /** Map clé_stockage → tableau de timestamps (ms) triés croissants */
  private readonly store = new Map<string, number[]>();

  /**
   * Construit la clé de stockage interne en combinant la clé applicative
   * et la fenêtre temporelle, pour éviter tout partage entre fenêtres différentes.
   */
  private storageKey(key: string, window_ms: number): string {
    return `${key}:${window_ms}`;
  }

  /**
   * Retourne les timestamps valides pour une clé/fenêtre.
   * Supprime les timestamps expirés en place.
   */
  private getValid(key: string, window_ms: number): number[] {
    const sk = this.storageKey(key, window_ms);
    const now = Date.now();
    const cutoff = now - window_ms;

    const all = this.store.get(sk) ?? [];
    const valid = all.filter((t) => t >= cutoff);
    this.store.set(sk, valid);
    return valid;
  }

  /**
   * Vérifie si une requête est dans les limites SANS la consommer.
   */
  check(key: string, limit: number, window_ms: number): RateLimitResult {
    const valid = this.getValid(key, window_ms);
    const count = valid.length;
    const allowed = count < limit;
    const remaining = Math.max(0, limit - count);

    // reset_at = expiration du timestamp le plus ancien + 1 fenêtre
    const oldestTs = valid[0];
    const reset_at = oldestTs !== undefined
      ? oldestTs + window_ms
      : Date.now() + window_ms;

    const result: RateLimitResult = { allowed, remaining, limit, reset_at };
    if (!allowed) {
      const retryMs = reset_at - Date.now();
      result.retry_after = Math.max(1, Math.ceil(retryMs / 1000));
    }
    return result;
  }

  /**
   * Vérifie ET consomme un token.
   * Enregistre le timestamp de la requête si autorisée.
   */
  consume(key: string, limit: number, window_ms: number): RateLimitResult {
    const valid = this.getValid(key, window_ms);
    const count = valid.length;

    if (count >= limit) {
      const oldestTs = valid[0];
      const reset_at = oldestTs !== undefined
        ? oldestTs + window_ms
        : Date.now() + window_ms;
      const retryMs = reset_at - Date.now();
      return {
        allowed: false,
        remaining: 0,
        limit,
        reset_at,
        retry_after: Math.max(1, Math.ceil(retryMs / 1000)),
      };
    }

    const now = Date.now();
    valid.push(now);
    this.store.set(this.storageKey(key, window_ms), valid);

    return {
      allowed: true,
      remaining: limit - valid.length,
      limit,
      reset_at: now + window_ms,
    };
  }

  /**
   * Retourne l'utilisation actuelle pour une clé/fenêtre.
   */
  getUsage(key: string, window_ms: number): { count: number; oldest: number } {
    const valid = this.getValid(key, window_ms);
    return {
      count: valid.length,
      oldest: valid[0] ?? Date.now(),
    };
  }

  /**
   * Réinitialise le compteur d'une clé.
   */
  reset(key: string): void {
    // Supprime toutes les entrées dont la clé commence par `key:`
    for (const sk of this.store.keys()) {
      if (sk.startsWith(`${key}:`)) {
        this.store.delete(sk);
      }
    }
  }

  /**
   * Réinitialise tous les compteurs.
   */
  resetAll(): void {
    this.store.clear();
  }

  /** Nombre de buckets actifs (pour les tests) */
  get size(): number {
    return this.store.size;
  }
}
