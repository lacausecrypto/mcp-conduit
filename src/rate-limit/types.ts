/**
 * Types pour le rate limiting.
 */

/** Résultat d'une vérification de rate limit */
export interface RateLimitResult {
  allowed: boolean;
  /** Requêtes restantes dans la fenêtre */
  remaining: number;
  /** Limite totale */
  limit: number;
  /** Timestamp (ms) de réinitialisation de la fenêtre */
  reset_at: number;
  /** Secondes à attendre avant de réessayer (si rejeté) */
  retry_after?: number;
}

/** Résultat d'une vérification de rate limit avec métadonnées de blocage */
export interface RateLimitCheckResult extends RateLimitResult {
  /** Label de la limite bloquante */
  blocked_by?: string;
  /** Clé de la limite bloquante (pour la queue) */
  blocking_key?: string;
  /** Limite numérique de la limite bloquante */
  blocking_limit?: number;
  /** Fenêtre temporelle de la limite bloquante (ms) */
  blocking_window_ms?: number;
}

/** Vérification individuelle de rate limit */
export interface RateLimitCheck {
  key: string;
  limit: number;
  window_ms: number;
  /** Label pour les messages d'erreur */
  label: string;
}

/** Configuration de rate limit par outil */
export interface ToolRateLimitConfig {
  requests_per_minute?: number;
  requests_per_hour?: number;
  requests_per_day?: number;
}

/** Configuration de rate limit pour un serveur spécifique */
export interface ServerRateLimitOverride {
  server: string;
  requests_per_minute?: number;
  requests_per_hour?: number;
  requests_per_day?: number;
  per_tool?: Record<string, ToolRateLimitConfig>;
}

/** Configuration globale du rate limiting */
export interface RateLimitConfig {
  enabled: boolean;
  /** Backend: 'memory' (défaut) ou 'redis' pour le mode distribué */
  backend?: 'memory' | 'redis';
  /** URL Redis (requis si backend === 'redis') */
  redis_url?: string;
  global?: ToolRateLimitConfig;
  per_client?: ToolRateLimitConfig;
  overrides?: ServerRateLimitOverride[];
  queue?: {
    enabled: boolean;
    max_wait_ms: number;
    max_queue_size: number;
  };
}

/**
 * Interface commune pour les backends de rate limiting.
 * Implémentée par SlidingWindowLimiter (mémoire) et RedisLimiter (Redis).
 * Les méthodes peuvent retourner des valeurs synchrones ou des Promises.
 */
export interface RateLimitBackend {
  consume(key: string, limit: number, window_ms: number): Promise<RateLimitResult> | RateLimitResult;
  check(key: string, limit: number, window_ms: number): Promise<RateLimitResult> | RateLimitResult;
  reset(key: string): Promise<void> | void;
  resetAll(): Promise<void> | void;
  getUsage(key: string, window_ms: number): Promise<{ count: number }> | { count: number };
}
