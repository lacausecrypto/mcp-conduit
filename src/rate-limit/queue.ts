/**
 * File d'attente pour les requêtes bloquées par le rate limiter.
 *
 * Comportement :
 * - Une requête en attente vérifie périodiquement (tous les 100ms) si
 *   de la capacité est disponible.
 * - Si la capacité se libère → résolution de la promesse (la requête peut continuer)
 * - Si max_wait_ms est dépassé → rejet (timeout)
 * - Si la file est pleine (max_queue_size) → rejet immédiat
 */

import type { SlidingWindowLimiter } from './limiter.js';

export interface QueueConfig {
  enabled: boolean;
  max_wait_ms: number;
  max_queue_size: number;
}

/** Entrée dans la file d'attente */
interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  deadline: number;
}

/** État d'une clé dans la file d'attente (inclut les paramètres du limiter) */
interface QueueKeyState {
  entries: QueueEntry[];
  limiter: SlidingWindowLimiter;
  limit: number;
  window_ms: number;
}

const POLL_INTERVAL_MS = 100;

export class RequestQueue {
  private readonly config: QueueConfig;
  /** File par clé de rate limit — inclut les paramètres du limiter associé */
  private readonly queues = new Map<string, QueueKeyState>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: QueueConfig) {
    this.config = config;
  }

  /**
   * Met une requête en file d'attente jusqu'à ce que de la capacité soit disponible.
   *
   * @param key - Clé du bucket rate limit
   * @param limit - Limite numérique
   * @param window_ms - Taille de la fenêtre temporelle
   * @param limiter - Instance SlidingWindowLimiter à interroger
   * @returns Promesse résolue quand la requête peut continuer, rejetée si timeout ou file pleine
   */
  enqueue(
    key: string,
    limit: number,
    window_ms: number,
    limiter: SlidingWindowLimiter,
  ): Promise<void> {
    if (!this.config.enabled) {
      return Promise.reject(new Error('La file d\'attente est désactivée'));
    }

    const existing = this.queues.get(key);
    const currentEntries = existing?.entries ?? [];
    if (currentEntries.length >= this.config.max_queue_size) {
      return Promise.reject(new Error('File d\'attente pleine'));
    }

    return new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + this.config.max_wait_ms;
      const entry: QueueEntry = { resolve, reject, deadline };

      if (existing) {
        existing.entries.push(entry);
      } else {
        this.queues.set(key, { entries: [entry], limiter, limit, window_ms });
      }

      // Démarrer le timer de polling si pas déjà actif
      this.ensurePolling();
    });
  }

  private ensurePolling(): void {
    if (this.pollTimer !== null) return;

    this.pollTimer = setInterval(() => {
      this.processAllPendingRequests();
    }, POLL_INTERVAL_MS);
  }

  /**
   * Traite toutes les clés en attente. Chaque clé utilise son propre
   * limiter/limit/window_ms, ce qui permet la gestion correcte de
   * plusieurs clés différentes dans la même instance de queue.
   */
  private processAllPendingRequests(): void {
    const now = Date.now();

    for (const [key, keyState] of this.queues) {
      const { entries, limiter, limit, window_ms } = keyState;

      if (entries.length === 0) {
        this.queues.delete(key);
        continue;
      }

      // Rejeter les entrées expirées
      let i = 0;
      while (i < entries.length) {
        const entry = entries[i];
        if (entry === undefined) {
          i++;
          continue;
        }
        if (now >= entry.deadline) {
          entry.reject(new Error('Timeout dans la file d\'attente'));
          entries.splice(i, 1);
        } else {
          i++;
        }
      }

      // Résoudre les entrées si de la capacité est disponible
      let j = 0;
      while (j < entries.length) {
        const checkResult = limiter.check(key, limit, window_ms);
        if (!checkResult.allowed) break;

        const entry = entries[j];
        if (entry === undefined) {
          j++;
          continue;
        }
        // Consommer le slot et résoudre
        limiter.consume(key, limit, window_ms);
        entry.resolve();
        entries.splice(j, 1);
      }

      if (entries.length === 0) {
        this.queues.delete(key);
      }
    }

    this.stopPollingIfEmpty();
  }

  private stopPollingIfEmpty(): void {
    if (this.queues.size === 0 && this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Nombre total d'entrées en attente */
  get pendingCount(): number {
    let total = 0;
    for (const keyState of this.queues.values()) {
      total += keyState.entries.length;
    }
    return total;
  }

  /** Arrête le polling (nettoyage) */
  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Rejeter toutes les entrées restantes
    for (const keyState of this.queues.values()) {
      for (const entry of keyState.entries) {
        entry.reject(new Error('File d\'attente arrêtée'));
      }
    }
    this.queues.clear();
  }
}
