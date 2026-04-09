/**
 * Déduplication des requêtes en vol (inflight deduplication).
 * Lorsque plusieurs agents envoient la même requête simultanément,
 * une seule requête est transmise en amont et tous les appelants
 * reçoivent le même résultat.
 */

import type { ToolCallResult } from './types.js';

/** Entrée du registre des requêtes en cours */
interface InflightEntry {
  promise: Promise<ToolCallResult>;
  startedAt: number;
  coalesced: number;
}

export class InflightTracker {
  /** Registre des requêtes en cours : clé de cache → promesse partagée */
  private readonly inflight: Map<string, InflightEntry>;

  constructor() {
    this.inflight = new Map();
  }

  /**
   * Vérifie si une requête est déjà en cours pour cette clé.
   * Si oui, retourne la promesse partagée existante.
   * Si non, exécute le fabricant de requête et enregistre la promesse.
   */
  async deduplicate(
    key: string,
    factory: () => Promise<ToolCallResult>,
  ): Promise<{ result: ToolCallResult; wasCoalesced: boolean }> {
    const existing = this.inflight.get(key);

    if (existing) {
      existing.coalesced++;
      const result = await existing.promise;
      return { result, wasCoalesced: true };
    }

    // Envelopper dans un try pour gérer le cas où factory() throw
    // de manière synchrone (avant de retourner une Promise).
    let promise: Promise<ToolCallResult>;
    try {
      promise = factory();
    } catch (err) {
      // factory() a throw synchronement — pas d'entrée dans la map à nettoyer
      throw err;
    }

    const tracked = promise.finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, {
      promise: tracked,
      startedAt: Date.now(),
      coalesced: 0,
    });

    const result = await tracked;
    return { result, wasCoalesced: false };
  }

  /** Retourne le nombre de requêtes actuellement en vol. */
  get size(): number {
    return this.inflight.size;
  }

  /** Retourne un snapshot des requêtes en cours pour l'API d'administration. */
  getInflightSnapshot(): Array<{ key: string; startedAt: number; coalesced: number }> {
    return Array.from(this.inflight.entries()).map(([key, entry]) => ({
      key,
      startedAt: entry.startedAt,
      coalesced: entry.coalesced,
    }));
  }

  /** Vérifie si une clé donnée est actuellement en cours de traitement. */
  has(key: string): boolean {
    return this.inflight.has(key);
  }
}
