/**
 * Client MCP côté sortie (egress).
 * Transmet les requêtes aux serveurs MCP en amont via HTTP.
 * Gère les réponses JSON simples et les flux SSE.
 * Intègre le circuit breaker pour prévenir les cascades d'échecs.
 */

import type { ServerConfig } from '../config/types.js';
import type { CircuitBreaker } from '../router/circuit-breaker.js';
import type { IMcpClient } from './mcp-client-interface.js';

/** Délai d'expiration par défaut pour les requêtes en amont (30 secondes) */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Résultat d'une requête vers un serveur MCP en amont */
export interface UpstreamResponse {
  /** Corps de la réponse en cas de JSON simple */
  body?: unknown;
  /** Statut HTTP */
  status: number;
  /** En-têtes de réponse */
  headers: Record<string, string>;
  /** Indique si la réponse est un flux SSE */
  isStream: boolean;
  /** Flux brut si isStream est true */
  rawResponse?: Response;
}

/** Options pour une requête en amont */
export interface UpstreamRequestOptions {
  sessionId?: string;
  body: unknown;
  /** En-têtes supplémentaires à transmettre (trace ID, auth, etc.) */
  extraHeaders?: Record<string, string>;
  /** Délai d'expiration en millisecondes (défaut : 30 secondes) */
  timeoutMs?: number;
}

export class McpClient implements IMcpClient {
  private readonly server: ServerConfig;
  private sessionId: string | undefined;
  /** Compteur de connexions actives (pour le load balancing least-connections) */
  private _activeConnections = 0;
  /** Circuit breaker for this client (optional) */
  private _circuitBreaker: CircuitBreaker | undefined;

  constructor(server: ServerConfig) {
    this.server = server;
  }

  /** Attach a circuit breaker to this client. Called by the registry after construction. */
  setCircuitBreaker(cb: CircuitBreaker): void {
    this._circuitBreaker = cb;
  }

  /** Returns the attached circuit breaker, if any. */
  getCircuitBreaker(): CircuitBreaker | undefined {
    return this._circuitBreaker;
  }

  /**
   * Transmet une requête JSON-RPC au serveur MCP en amont.
   * Préserve les en-têtes de session MCP et propage le trace ID.
   * Honors the circuit breaker: returns an error immediately if the circuit is open.
   */
  async forward(options: UpstreamRequestOptions): Promise<UpstreamResponse> {
    // Circuit breaker check — fast-fail if open
    if (this._circuitBreaker && !this._circuitBreaker.canExecute()) {
      throw new Error(
        `Circuit breaker open for server "${this.server.id}" — request rejected to prevent cascade`,
      );
    }

    this._activeConnections++;
    try {
      const result = await this._doForward(options);
      // Success — inform circuit breaker
      this._circuitBreaker?.onSuccess();
      return result;
    } catch (error) {
      // Failure — inform circuit breaker
      this._circuitBreaker?.onFailure();
      throw error;
    } finally {
      this._activeConnections--;
    }
  }

  private async _doForward(options: UpstreamRequestOptions): Promise<UpstreamResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };

    // Propagation du session ID MCP si disponible
    const effectiveSessionId = options.sessionId ?? this.sessionId;
    if (effectiveSessionId) {
      headers['Mcp-Session-Id'] = effectiveSessionId;
    }

    // Propagation des en-têtes supplémentaires (trace, auth, groupe)
    if (options.extraHeaders) {
      Object.assign(headers, options.extraHeaders);
    }

    const timeoutMs = options.timeoutMs ?? this.server.timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options.body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // Capture du session ID depuis la réponse (handshake initialize)
    const responseSessionId = response.headers.get('Mcp-Session-Id');
    if (responseSessionId) {
      this.sessionId = responseSessionId;
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    const isStream = contentType.includes('text/event-stream');

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    if (isStream) {
      return {
        status: response.status,
        headers: responseHeaders,
        isStream: true,
        rawResponse: response,
      };
    }

    let body: unknown;
    try {
      body = await response.json() as unknown;
    } catch {
      throw new Error(
        `Le serveur en amont "${this.server.id}" a retourné une réponse non-JSON (HTTP ${response.status})`,
      );
    }

    return {
      body,
      status: response.status,
      headers: responseHeaders,
      isStream: false,
    };
  }

  /**
   * Effectue une requête GET vers le serveur en amont (pour les flux SSE de notifications).
   */
  async openSseStream(
    extraHeaders?: Record<string, string>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
    };

    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(this.server.url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Retourne le session ID actuel. */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Définit manuellement le session ID (handshake). */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** Nombre de connexions actives (load balancing least-connections). */
  get activeConnections(): number {
    return this._activeConnections;
  }

  get serverId(): string {
    return this.server.id;
  }

  get serverUrl(): string {
    return this.server.url;
  }
}
