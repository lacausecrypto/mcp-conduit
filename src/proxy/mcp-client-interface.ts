/**
 * Interface commune pour les clients MCP.
 * Permet de supporter plusieurs transports (HTTP, stdio)
 * tout en gardant une API uniforme pour le pipeline et le routeur.
 */

import type { CircuitBreaker } from '../router/circuit-breaker.js';
import type { UpstreamResponse, UpstreamRequestOptions } from './mcp-client.js';

export type { UpstreamResponse, UpstreamRequestOptions };

/**
 * Interface que tout client MCP doit implémenter.
 * Le pipeline, le routeur et le registre interagissent
 * exclusivement via cette interface.
 */
export interface IMcpClient {
  /** Transmet une requête JSON-RPC au serveur MCP en amont. */
  forward(options: UpstreamRequestOptions): Promise<UpstreamResponse>;

  /** Ouvre un flux SSE de notifications (HTTP uniquement). */
  openSseStream(
    extraHeaders?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<Response>;

  /** Retourne le session ID actuel. */
  getSessionId(): string | undefined;

  /** Définit manuellement le session ID (handshake). */
  setSessionId(id: string): void;

  /** Attache un circuit breaker. */
  setCircuitBreaker(cb: CircuitBreaker): void;

  /** Retourne le circuit breaker attaché. */
  getCircuitBreaker(): CircuitBreaker | undefined;

  /** Nombre de connexions actives (load balancing least-connections). */
  readonly activeConnections: number;

  /** Identifiant du serveur. */
  readonly serverId: string;

  /** URL du serveur (ou identifiant pour stdio). */
  readonly serverUrl: string;
}
