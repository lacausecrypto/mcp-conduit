/**
 * Journalisation structurée de toutes les interactions MCP.
 * Chaque requête est enregistrée avec ses métadonnées complètes.
 * Les données sensibles sont masquées avant la journalisation.
 */

import type { LogEntry, RequestStatus, CacheLogStatus } from './types.js';
import type { LogStore } from './log-store.js';
import { sanitizeMetricLabel, type ConduitMetrics } from './metrics.js';
import { redact } from './redactor.js';
import { sanitizeArgs } from '../utils/sanitize.js';

/** Contexte d'une requête en cours de traitement */
export interface RequestLogContext {
  traceId: string;
  clientId: string;
  serverId: string;
  method: string;
  toolName?: string;
  args?: Record<string, unknown>;
  startTime: number;
}

/** Résultat du traitement d'une requête */
export interface RequestLogResult {
  status: RequestStatus;
  responseSize: number;
  cacheStatus?: CacheLogStatus;
  errorCode?: number;
  errorMessage?: string;
  guardrailRule?: string;
  guardrailAction?: string;
}

/** Configuration du logger */
export interface LoggerConfig {
  logArgs: boolean;
  logResponses: boolean;
  redactFields: string[];
}

export class ConduitLogger {
  private readonly store: LogStore;
  private readonly metrics: ConduitMetrics;
  private readonly config: LoggerConfig;

  constructor(store: LogStore, metrics: ConduitMetrics, config: LoggerConfig) {
    this.store = store;
    this.metrics = metrics;
    this.config = config;
  }

  /** Hot-reload: update observability settings without restarting. */
  updateObservabilityConfig(logArgs: boolean, logResponses: boolean, redactFields: string[]): void {
    this.config.logArgs = logArgs;
    this.config.logResponses = logResponses;
    this.config.redactFields = redactFields;
  }

  /**
   * Enregistre le résultat d'une requête traitée par la passerelle.
   * Masque les données sensibles avant la persistance.
   */
  log(context: RequestLogContext, result: RequestLogResult): void {
    const durationMs = Date.now() - context.startTime;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      trace_id: context.traceId,
      client_id: context.clientId,
      server_id: context.serverId,
      method: context.method,
      duration_ms: durationMs,
      status: result.status,
      response_size: result.responseSize,
    };

    if (context.toolName !== undefined) {
      entry.tool_name = context.toolName;
    }

    if (this.config.logArgs && context.args !== undefined) {
      // Tronque d'abord les chaînes trop longues, puis masque les champs sensibles
      const sanitized = sanitizeArgs(context.args) as Record<string, unknown>;
      entry.args = redact(sanitized, this.config.redactFields) as Record<string, unknown>;
    }

    if (result.cacheStatus !== undefined) {
      entry.cache_status = result.cacheStatus;
    }

    if (result.errorCode !== undefined) {
      entry.error_code = result.errorCode;
    }

    if (result.errorMessage !== undefined) {
      entry.error_message = result.errorMessage;
    }

    if (result.guardrailRule !== undefined) {
      entry.guardrail_rule = result.guardrailRule;
    }

    if (result.guardrailAction !== undefined) {
      entry.guardrail_action = result.guardrailAction;
    }

    // Persistance en base de données
    try {
      this.store.insert(entry);
    } catch (error) {
      console.error('[Conduit] Erreur lors de la journalisation :', error);
    }

    // Mise à jour des métriques Prometheus.
    // tool/method come from the upstream payload and are user-influenced;
    // sanitizeMetricLabel caps length and charset so a hostile caller cannot
    // inflate cardinality by submitting unique tool names per request.
    const safeServer = sanitizeMetricLabel(context.serverId);
    const safeMethod = sanitizeMetricLabel(context.method);
    const safeTool = sanitizeMetricLabel(context.toolName);
    this.metrics.requestsTotal.inc({
      server: safeServer,
      method: safeMethod,
      tool: safeTool,
      status: result.status,
      cache_status: result.cacheStatus ?? '',
    });

    this.metrics.requestDurationSeconds.observe(
      {
        server: safeServer,
        method: safeMethod,
        tool: safeTool,
      },
      durationMs / 1000,
    );

    this.metrics.logEntriesTotal.inc();

    // Compteurs de cache
    if (result.cacheStatus === 'HIT') {
      this.metrics.cacheHitsTotal.inc({
        server: safeServer,
        tool: safeTool,
      });
    } else if (result.cacheStatus === 'MISS') {
      this.metrics.cacheMissesTotal.inc({
        server: safeServer,
        tool: safeTool,
      });
    }

    // Compteur d'erreurs
    if (result.status === 'error') {
      this.metrics.errorsTotal.inc({
        server: safeServer,
        type: result.errorCode === -32603 ? 'upstream_error' : 'internal',
      });
    }
  }
}
