/**
 * Métriques Prometheus pour MCP Conduit.
 * Expose les compteurs, jauges et histogrammes via prom-client.
 */

import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export class ConduitMetrics {
  public readonly registry: Registry;

  /** Compteur total de requêtes par (serveur, méthode, outil, statut, statut_cache) */
  public readonly requestsTotal: Counter<'server' | 'method' | 'tool' | 'status' | 'cache_status'>;

  /** Histogramme de la durée des requêtes en secondes */
  public readonly requestDurationSeconds: Histogram<'server' | 'method' | 'tool'>;

  /** Jauge des connexions actives par serveur */
  public readonly activeConnections: Gauge<'server'>;

  /** Jauge de l'état de santé des backends (1=sain, 0=dégradé) */
  public readonly backendHealth: Gauge<'server'>;

  /** Compteur de succès du cache par (serveur, outil) */
  public readonly cacheHitsTotal: Counter<'server' | 'tool'>;

  /** Compteur d'échecs du cache par (serveur, outil) */
  public readonly cacheMissesTotal: Counter<'server' | 'tool'>;

  /** Jauge du nombre d'entrées dans le cache */
  public readonly cacheEntries: Gauge<never>;

  /** Compteur de requêtes dédupliquées (coalescées) */
  public readonly dedupCoalescedTotal: Counter<'server' | 'tool'>;

  /** Compteur d'erreurs par type */
  public readonly errorsTotal: Counter<'server' | 'type'>;

  /** Compteur total d'entrées de log */
  public readonly logEntriesTotal: Counter<never>;

  // =========================================================================
  // Nouvelles métriques — Phase 2 (Auth & ACL)
  // =========================================================================

  /** Compteur d'échecs d'authentification par raison */
  public readonly authFailuresTotal: Counter<'reason'>;

  /** Compteur de refus ACL par client, serveur et outil */
  public readonly aclDenialsTotal: Counter<'client' | 'server' | 'tool'>;

  // =========================================================================
  // Nouvelles métriques — Phase 3 (Rate Limiting)
  // =========================================================================

  /** Compteur de rejets de rate limit par client, serveur et type de limite */
  public readonly rateLimitRejectionsTotal: Counter<'client' | 'server' | 'limit_type'>;

  /** Histogramme du temps d'attente dans la file de rate limit */
  public readonly rateLimitQueueWaitSeconds: Histogram<never>;

  /** Jauge des connexions actives par (serveur, réplica) */
  public readonly backendActiveConnections: Gauge<'server' | 'replica'>;

  // =========================================================================
  // Nouvelles métriques — Guardrails IA
  // =========================================================================

  /** Compteur d'actions guardrails par règle, action et outil */
  public readonly guardrailActionsTotal: Counter<'rule' | 'action' | 'tool'>;

  // =========================================================================
  // Nouvelles métriques — Phase 4 (Circuit Breaker)
  // =========================================================================

  /** Jauge de l'état du circuit breaker par (serveur, réplica): 0=closed, 1=open, 2=half-open */
  public readonly circuitState: Gauge<'server' | 'replica'>;

  /** Compteur du nombre de fois où un circuit a été ouvert */
  public readonly circuitTripsTotal: Counter<'server'>;

  constructor() {
    this.registry = new Registry();

    this.requestsTotal = new Counter({
      name: 'conduit_requests_total',
      help: 'Nombre total de requêtes traitées par la passerelle Conduit',
      labelNames: ['server', 'method', 'tool', 'status', 'cache_status'] as const,
      registers: [this.registry],
    });

    this.requestDurationSeconds = new Histogram({
      name: 'conduit_request_duration_seconds',
      help: 'Durée des requêtes en secondes',
      labelNames: ['server', 'method', 'tool'] as const,
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry],
    });

    this.activeConnections = new Gauge({
      name: 'conduit_active_connections',
      help: 'Nombre de connexions actives par serveur en amont',
      labelNames: ['server'] as const,
      registers: [this.registry],
    });

    this.backendHealth = new Gauge({
      name: 'conduit_backend_health',
      help: 'État de santé des backends en amont (1=sain, 0=dégradé)',
      labelNames: ['server'] as const,
      registers: [this.registry],
    });

    this.cacheHitsTotal = new Counter({
      name: 'conduit_cache_hits_total',
      help: 'Nombre total de succès du cache par serveur et outil',
      labelNames: ['server', 'tool'] as const,
      registers: [this.registry],
    });

    this.cacheMissesTotal = new Counter({
      name: 'conduit_cache_misses_total',
      help: 'Nombre total d\'échecs du cache par serveur et outil',
      labelNames: ['server', 'tool'] as const,
      registers: [this.registry],
    });

    this.cacheEntries = new Gauge({
      name: 'conduit_cache_entries',
      help: 'Nombre d\'entrées actuellement dans le cache',
      labelNames: [] as const,
      registers: [this.registry],
    });

    this.dedupCoalescedTotal = new Counter({
      name: 'conduit_dedup_coalesced_total',
      help: 'Nombre total de requêtes dédupliquées (coalescées)',
      labelNames: ['server', 'tool'] as const,
      registers: [this.registry],
    });

    this.errorsTotal = new Counter({
      name: 'conduit_errors_total',
      help: 'Nombre total d\'erreurs par serveur et type',
      labelNames: ['server', 'type'] as const,
      registers: [this.registry],
    });

    this.logEntriesTotal = new Counter({
      name: 'conduit_log_entries_total',
      help: 'Nombre total d\'entrées de log créées',
      labelNames: [] as const,
      registers: [this.registry],
    });

    this.authFailuresTotal = new Counter({
      name: 'conduit_auth_failures_total',
      help: 'Nombre total d\'échecs d\'authentification',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });

    this.aclDenialsTotal = new Counter({
      name: 'conduit_acl_denials_total',
      help: 'Nombre total de refus ACL',
      labelNames: ['client', 'server', 'tool'] as const,
      registers: [this.registry],
    });

    this.rateLimitRejectionsTotal = new Counter({
      name: 'conduit_rate_limit_rejections_total',
      help: 'Nombre total de rejets par rate limit',
      labelNames: ['client', 'server', 'limit_type'] as const,
      registers: [this.registry],
    });

    this.rateLimitQueueWaitSeconds = new Histogram({
      name: 'conduit_rate_limit_queue_wait_seconds',
      help: 'Temps d\'attente dans la file de rate limit',
      labelNames: [] as const,
      buckets: [0.1, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    this.backendActiveConnections = new Gauge({
      name: 'conduit_backend_active_connections',
      help: 'Nombre de connexions actives par serveur et réplica',
      labelNames: ['server', 'replica'] as const,
      registers: [this.registry],
    });

    this.guardrailActionsTotal = new Counter({
      name: 'conduit_guardrail_actions_total',
      help: 'Nombre total d\'actions guardrails par règle, action et outil',
      labelNames: ['rule', 'action', 'tool'] as const,
      registers: [this.registry],
    });

    this.circuitState = new Gauge({
      name: 'conduit_circuit_state',
      help: 'Circuit breaker state per server and replica (0=closed, 1=open, 2=half-open)',
      labelNames: ['server', 'replica'] as const,
      registers: [this.registry],
    });

    this.circuitTripsTotal = new Counter({
      name: 'conduit_circuit_trips_total',
      help: 'Number of times the circuit breaker has opened',
      labelNames: ['server'] as const,
      registers: [this.registry],
    });
  }

  /** Met à jour la jauge du nombre d'entrées dans le cache. */
  updateCacheEntries(count: number): void {
    this.cacheEntries.set(count);
  }

  /** Exporte les métriques au format Prometheus texte. */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}

/** Instance globale des métriques (singleton) */
let metricsInstance: ConduitMetrics | null = null;

export function getMetrics(): ConduitMetrics {
  if (!metricsInstance) {
    metricsInstance = new ConduitMetrics();
  }
  return metricsInstance;
}

export function resetMetrics(): void {
  metricsInstance = null;
}
