/**
 * Backend de discovery HTTP (self-registration).
 *
 * Les serveurs MCP s'enregistrent via POST /conduit/discover/register
 * et envoient des heartbeats périodiques. Les serveurs qui ne
 * renouvellent pas leur enregistrement dans le délai stale_timeout
 * sont automatiquement supprimés.
 */

import type { DiscoveryBackend, DiscoveredServer } from './types.js';

interface Registration {
  server: DiscoveredServer;
  lastSeen: number;
}

export class HttpRegistryBackend implements DiscoveryBackend {
  readonly name = 'http-registry';

  /** Enregistrements actifs : serverId → registration */
  private readonly registrations = new Map<string, Registration>();
  private readonly staleTimeoutMs: number;

  constructor(staleTimeoutSeconds: number) {
    this.staleTimeoutMs = staleTimeoutSeconds * 1000;
  }

  /**
   * Enregistre ou met à jour un serveur (heartbeat).
   * Appelé depuis l'endpoint admin POST /conduit/discover/register.
   */
  register(server: DiscoveredServer): void {
    this.registrations.set(server.id, {
      server,
      lastSeen: Date.now(),
    });
  }

  /**
   * Désinscrit un serveur manuellement.
   * Appelé depuis l'endpoint admin DELETE /conduit/discover/deregister/:id.
   */
  deregister(serverId: string): boolean {
    return this.registrations.delete(serverId);
  }

  /**
   * Retourne tous les serveurs encore vivants (non-stale).
   */
  async poll(): Promise<DiscoveredServer[]> {
    const now = Date.now();
    const alive: DiscoveredServer[] = [];

    for (const [id, reg] of this.registrations) {
      if (now - reg.lastSeen > this.staleTimeoutMs) {
        // Stale — supprimer silencieusement
        this.registrations.delete(id);
      } else {
        alive.push(reg.server);
      }
    }

    return alive;
  }

  /** Nombre d'enregistrements actifs. */
  get size(): number {
    return this.registrations.size;
  }
}
