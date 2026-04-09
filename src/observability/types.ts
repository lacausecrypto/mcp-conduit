/**
 * Types pour la couche d'observabilité de la passerelle Conduit.
 * Définit la structure des entrées de log et les états associés.
 */

/** Statut d'une requête traitée par la passerelle */
export type RequestStatus = 'success' | 'error' | 'cache_hit';

/** Statut du cache pour une requête */
export type CacheLogStatus = 'HIT' | 'MISS' | 'BYPASS' | 'SKIP';

/** Entrée de log structurée pour chaque interaction MCP */
export interface LogEntry {
  /** Horodatage ISO 8601 */
  timestamp: string;
  /** Identifiant de trace unique (X-Conduit-Trace-Id) */
  trace_id: string;
  /** Identifiant du client (depuis l'en-tête auth ou l'IP) */
  client_id: string;
  /** Identifiant du serveur en amont */
  server_id: string;
  /** Méthode MCP (tools/call, tools/list, etc.) */
  method: string;
  /** Nom de l'outil (pour tools/call) */
  tool_name?: string;
  /** Arguments de l'appel (sanitisés et masqués) */
  args?: Record<string, unknown>;
  /** Durée de traitement en millisecondes */
  duration_ms: number;
  /** Statut de la requête */
  status: RequestStatus;
  /** Taille de la réponse en octets */
  response_size: number;
  /** Code d'erreur JSON-RPC (si erreur) */
  error_code?: number;
  /** Message d'erreur (si erreur) */
  error_message?: string;
  /** Statut du cache pour cette requête */
  cache_status?: CacheLogStatus;
  /** Nom de la règle guardrail déclenchée (si applicable) */
  guardrail_rule?: string;
  /** Action guardrail prise : block, alert, etc. (si applicable) */
  guardrail_action?: string;
}

/** Filtres pour les requêtes de logs */
export interface LogFilters {
  server?: string;
  tool?: string;
  status?: RequestStatus;
  from?: string;
  to?: string;
  trace_id?: string;
  client_id?: string;
  limit?: number;
  offset?: number;
}

/** Statistiques agrégées des logs */
export interface LogStats {
  total_requests: number;
  requests_per_minute: number;
  avg_latency_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  error_rate: number;
  cache_hit_rate: number;
}
