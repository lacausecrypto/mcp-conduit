/**
 * Rate Limiter haut niveau pour MCP Conduit.
 *
 * Hiérarchie des limites (toutes vérifiées, la plus restrictive gagne) :
 * 1. Limite globale (toutes requêtes confondues)
 * 2. Limite par client
 * 3. Limite par serveur (overrides)
 * 4. Limite par outil (per_tool dans les overrides)
 * 5. Limite client+serveur+outil (la plus spécifique)
 *
 * Séparation client/serveur pour la gestion du cache :
 * - Les limites "client" s'appliquent avant la vérification du cache
 * - Les limites "serveur" s'appliquent seulement en cas de cache miss
 *
 * Supports both SlidingWindowLimiter (memory) and RedisLimiter (distributed)
 * backends via the RateLimitBackend interface.
 */

import { SlidingWindowLimiter } from './limiter.js';
import { RequestQueue } from './queue.js';
import type { RateLimitConfig, RateLimitCheck, RateLimitCheckResult, ToolRateLimitConfig, RateLimitBackend } from './types.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export class RateLimiter {
  private readonly config: RateLimitConfig;
  /** The backing rate limit store (memory or Redis). */
  readonly limiter: RateLimitBackend;
  private readonly queue: RequestQueue | null;

  constructor(config: RateLimitConfig, limiter?: RateLimitBackend) {
    this.config = config;
    this.limiter = limiter ?? new SlidingWindowLimiter();
    this.queue = config.queue?.enabled
      ? new RequestQueue(config.queue)
      : null;
  }

  /**
   * Construit les vérifications côté client (globale + par-client).
   * S'appliquent avant la vérification du cache.
   */
  getClientChecks(clientId: string): RateLimitCheck[] {
    const checks: RateLimitCheck[] = [];

    if (this.config.global) {
      checks.push(...buildChecks('global', this.config.global, 'global'));
    }

    if (this.config.per_client) {
      checks.push(...buildChecks(`client:${clientId}`, this.config.per_client, 'client'));
    }

    return checks;
  }

  /**
   * Construit les vérifications côté serveur (par-serveur + par-outil).
   * S'appliquent uniquement en cas de cache miss.
   */
  getServerChecks(clientId: string, serverId: string, toolName: string): RateLimitCheck[] {
    const checks: RateLimitCheck[] = [];

    if (!this.config.overrides) return checks;

    const override = this.config.overrides.find((o) => o.server === serverId);
    if (!override) return checks;

    // Limite par serveur
    checks.push(...buildChecks(`server:${serverId}`, override, 'server'));

    // Limite par outil
    if (toolName && override.per_tool) {
      const toolConfig = override.per_tool[toolName];
      if (toolConfig) {
        checks.push(...buildChecks(`server:${serverId}:tool:${toolName}`, toolConfig, 'tool'));
      }
    }

    // Limite client+serveur+outil
    if (toolName) {
      const clientSpecificKey = `client:${clientId}:server:${serverId}:tool:${toolName}`;
      checks.push(...buildChecks(clientSpecificKey, override, `client-server-tool`));
    }

    return checks;
  }

  /**
   * Toutes les vérifications combinées.
   */
  getChecks(clientId: string, serverId: string, toolName: string): RateLimitCheck[] {
    return [
      ...this.getClientChecks(clientId),
      ...this.getServerChecks(clientId, serverId, toolName),
    ];
  }

  /**
   * Vérifie toutes les limites applicables SANS les consommer.
   */
  async check(clientId: string, serverId: string, toolName: string): Promise<RateLimitCheckResult> {
    return this.evaluateChecks(this.getChecks(clientId, serverId, toolName), false);
  }

  /**
   * Vérifie ET consomme toutes les limites applicables.
   */
  async consume(clientId: string, serverId: string, toolName: string): Promise<RateLimitCheckResult> {
    return this.evaluateChecks(this.getChecks(clientId, serverId, toolName), true);
  }

  /**
   * Vérifie ET consomme uniquement les limites côté client.
   */
  async consumeClientLimits(clientId: string): Promise<RateLimitCheckResult> {
    return this.evaluateChecks(this.getClientChecks(clientId), true);
  }

  /**
   * Vérifie ET consomme uniquement les limites côté serveur/outil.
   */
  async consumeServerLimits(clientId: string, serverId: string, toolName: string): Promise<RateLimitCheckResult> {
    return this.evaluateChecks(this.getServerChecks(clientId, serverId, toolName), true);
  }

  /**
   * Vérifie et consomme les limites avec file d'attente optionnelle.
   * Si bloqué et queue activée, attend la libération de capacité.
   * Queue only works with the SlidingWindowLimiter backend.
   */
  async consumeWithQueue(
    clientId: string,
    serverId: string,
    toolName: string,
  ): Promise<RateLimitCheckResult> {
    const checks = this.getChecks(clientId, serverId, toolName);

    // Vérification sans consommation pour trouver la limite bloquante
    const preview = await this.evaluateChecks(checks, false);
    if (preview.allowed) {
      return this.evaluateChecks(checks, true);
    }

    // Queue only works with SlidingWindowLimiter (sync backend)
    if (!this.queue || !preview.blocking_key || !(this.limiter instanceof SlidingWindowLimiter)) {
      return this.evaluateChecks(checks, true);
    }

    // Attendre dans la file sur la limite bloquante
    try {
      await this.queue.enqueue(
        preview.blocking_key,
        preview.blocking_limit ?? 1,
        preview.blocking_window_ms ?? MS_PER_MINUTE,
        this.limiter,
      );
      // Après résolution de la queue, consommer les autres limites
      return this.evaluateChecks(
        checks.filter((c) => c.key !== preview.blocking_key),
        true,
      );
    } catch {
      // Timeout ou file pleine → retourner l'erreur originale
      return preview as RateLimitCheckResult;
    }
  }

  /**
   * Retourne le quota actuel d'un client.
   */
  async getClientQuota(clientId: string): Promise<{
    limits: { label: string; remaining: number; limit: number; reset_at: number }[];
  }> {
    const checks = this.getClientChecks(clientId);
    const limits = await Promise.all(
      checks.map(async (check) => {
        const result = await Promise.resolve(this.limiter.check(check.key, check.limit, check.window_ms));
        return {
          label: check.label,
          remaining: result.remaining,
          limit: check.limit,
          reset_at: result.reset_at,
        };
      }),
    );
    return { limits };
  }

  /**
   * Retourne tous les buckets actifs avec leur utilisation.
   * Only available for the SlidingWindowLimiter backend.
   */
  getAllBuckets(): { key: string; count: number; oldest: number }[] {
    const buckets: { key: string; count: number; oldest: number }[] = [];
    // Only works for SlidingWindowLimiter (exposes internal store)
    const limiterAny = this.limiter as unknown as { store: Map<string, number[]> };
    if (limiterAny.store) {
      for (const [storageKey, timestamps] of limiterAny.store) {
        buckets.push({
          key: storageKey,
          count: timestamps.length,
          oldest: timestamps[0] ?? 0,
        });
      }
    }
    return buckets;
  }

  /**
   * Remet à zéro tous les compteurs d'un client.
   */
  resetClient(clientId: string): void {
    // Support both sync and async reset
    const resetResult = this.limiter.reset(`client:${clientId}`);
    if (resetResult instanceof Promise) {
      resetResult.catch((err: unknown) => {
        console.error('[Conduit/RateLimiter] Error resetting client:', err);
      });
    }
    const globalReset = this.limiter.reset('global');
    if (globalReset instanceof Promise) {
      globalReset.catch((err: unknown) => {
        console.error('[Conduit/RateLimiter] Error resetting global:', err);
      });
    }
  }

  /**
   * Remet à zéro tous les compteurs.
   */
  resetAll(): void {
    const result = this.limiter.resetAll();
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        console.error('[Conduit/RateLimiter] Error resetting all:', err);
      });
    }
  }

  /** Arrête la file d'attente interne */
  stop(): void {
    this.queue?.stop();
  }

  private async evaluateChecks(checks: RateLimitCheck[], consume: boolean): Promise<RateLimitCheckResult> {
    if (checks.length === 0) {
      return {
        allowed: true,
        remaining: Infinity,
        limit: Infinity,
        reset_at: Date.now() + MS_PER_MINUTE,
      };
    }

    // Vérifier toutes les limites — la plus restrictive gagne
    for (const check of checks) {
      const result = await Promise.resolve(
        consume
          ? this.limiter.consume(check.key, check.limit, check.window_ms)
          : this.limiter.check(check.key, check.limit, check.window_ms),
      );

      if (!result.allowed) {
        return {
          ...result,
          blocked_by: check.label,
          blocking_key: check.key,
          blocking_limit: check.limit,
          blocking_window_ms: check.window_ms,
        };
      }
    }

    // Toutes les limites passent → retourner la plus restrictive en termes de remaining.
    let mostRestrictive: RateLimitCheckResult | null = null;
    for (const check of checks) {
      const result = await Promise.resolve(this.limiter.check(check.key, check.limit, check.window_ms));
      if (mostRestrictive === null || result.remaining < mostRestrictive.remaining) {
        mostRestrictive = { ...result, allowed: true };
      }
    }

    return mostRestrictive ?? {
      allowed: true,
      remaining: Infinity,
      limit: Infinity,
      reset_at: Date.now() + MS_PER_MINUTE,
    };
  }
}

/** Construit les checks à partir d'une config de limites */
function buildChecks(
  key: string,
  config: ToolRateLimitConfig,
  labelPrefix: string,
): RateLimitCheck[] {
  const checks: RateLimitCheck[] = [];

  if (config.requests_per_minute !== undefined) {
    checks.push({
      key,
      limit: config.requests_per_minute,
      window_ms: MS_PER_MINUTE,
      label: `${labelPrefix}/minute`,
    });
  }
  if (config.requests_per_hour !== undefined) {
    checks.push({
      key,
      limit: config.requests_per_hour,
      window_ms: MS_PER_HOUR,
      label: `${labelPrefix}/heure`,
    });
  }
  if (config.requests_per_day !== undefined) {
    checks.push({
      key,
      limit: config.requests_per_day,
      window_ms: MS_PER_DAY,
      label: `${labelPrefix}/jour`,
    });
  }

  return checks;
}
