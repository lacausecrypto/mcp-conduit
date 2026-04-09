/**
 * Discovery Manager — orchestre les backends de discovery et
 * réconcilie les serveurs découverts avec le registre gateway.
 *
 * Cycle de réconciliation :
 * 1. Poll tous les backends
 * 2. Merge les résultats (dedup par ID)
 * 3. Comparer avec les serveurs actuellement enregistrés
 * 4. Ajouter les nouveaux serveurs
 * 5. Supprimer les serveurs disparus (stale)
 */

import type { ServerConfig, ServerCacheConfig } from '../config/types.js';
import type { ServerRegistry } from '../router/registry.js';
import type { IMcpClient } from '../proxy/mcp-client-interface.js';
import { createMcpClient } from '../proxy/client-factory.js';
import type { DiscoveryBackend, DiscoveredServer, DiscoveryConfig } from './types.js';

export class DiscoveryManager {
  private readonly backends: DiscoveryBackend[];
  private readonly registry: ServerRegistry;
  private readonly clients: Map<string, IMcpClient>;
  private readonly configServers: ServerConfig[];
  private readonly defaultCache: ServerCacheConfig;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number;

  /** IDs des serveurs gérés par le discovery (vs config statique) */
  private readonly managedServerIds = new Set<string>();

  constructor(
    config: DiscoveryConfig,
    backends: DiscoveryBackend[],
    registry: ServerRegistry,
    clients: Map<string, IMcpClient>,
    configServers: ServerConfig[],
  ) {
    this.backends = backends;
    this.registry = registry;
    this.clients = clients;
    this.configServers = configServers;
    this.defaultCache = config.default_cache;
    this.pollIntervalMs = config.poll_interval_seconds * 1000;
  }

  /** Démarre le polling périodique. */
  async start(): Promise<void> {
    // Init backends
    for (const backend of this.backends) {
      if (backend.start) {
        await backend.start();
      }
    }

    // First reconciliation
    await this.reconcile();

    // Start periodic polling
    this.pollTimer = setInterval(() => {
      void this.reconcile().catch((err) => {
        console.error('[Conduit/Discovery] Reconciliation error:', err);
      });
    }, this.pollIntervalMs);
  }

  /** Arrête le polling et les backends. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    for (const backend of this.backends) {
      if (backend.stop) backend.stop();
    }
  }

  /**
   * Cycle de réconciliation : poll → merge → diff → add/remove.
   */
  async reconcile(): Promise<{ added: string[]; removed: string[] }> {
    // 1. Poll all backends
    const allDiscovered: DiscoveredServer[] = [];
    const results = await Promise.allSettled(
      this.backends.map((b) => b.poll()),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allDiscovered.push(...result.value);
      }
    }

    // 2. Dedup by ID
    const discoveredMap = new Map<string, DiscoveredServer>();
    for (const server of allDiscovered) {
      discoveredMap.set(server.id, server);
    }

    // 3. Diff with current managed servers
    const discoveredIds = new Set(discoveredMap.keys());
    const staticIds = new Set(this.configServers.map((s) => s.id));
    const added: string[] = [];
    const removed: string[] = [];

    // 4. Add new discovered servers (not in static config)
    for (const [id, discovered] of discoveredMap) {
      if (staticIds.has(id)) continue; // Don't touch statically configured servers
      if (this.managedServerIds.has(id)) continue; // Already managed

      const serverConfig: ServerConfig = {
        id: discovered.id,
        url: discovered.url,
        cache: { ...this.defaultCache },
      };
      if (discovered.transport) serverConfig.transport = discovered.transport;
      if (discovered.command) serverConfig.command = discovered.command;
      if (discovered.args) serverConfig.args = discovered.args;

      try {
        const client = createMcpClient(serverConfig);
        this.clients.set(id, client);
        await this.registry.addServer(serverConfig, client);
        this.managedServerIds.add(id);
        added.push(id);
        console.log(`[Conduit/Discovery] Server "${id}" registered (${discovered.url})`);
      } catch (err) {
        console.warn(`[Conduit/Discovery] Failed to register "${id}":`, err);
      }
    }

    // 5. Remove managed servers no longer discovered
    for (const id of this.managedServerIds) {
      if (!discoveredIds.has(id)) {
        this.registry.removeServer(id);
        this.clients.delete(id);
        this.managedServerIds.delete(id);
        removed.push(id);
        console.log(`[Conduit/Discovery] Server "${id}" deregistered (stale)`);
      }
    }

    return { added, removed };
  }

  /** Nombre de serveurs gérés par le discovery. */
  get managedCount(): number {
    return this.managedServerIds.size;
  }

  /** IDs des serveurs gérés. */
  getManagedIds(): string[] {
    return [...this.managedServerIds];
  }
}
