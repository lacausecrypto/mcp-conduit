/**
 * Registre des serveurs MCP en amont.
 *
 * Responsabilités :
 * - Récupérer et mettre en cache la liste des outils (tools/list) de chaque serveur
 * - Maintenir la correspondance outil → serveur
 * - Suivre l'état de santé de chaque backend et de ses réplicas
 * - Rafraîchir périodiquement les outils et l'état de santé
 * - Gérer les circuit breakers par réplica
 */

import type { ConduitGatewayConfig, ServerConfig, HealthCheckConfig, CircuitBreakerConfig } from '../config/types.js';
import type { ToolMetadata, ToolAnnotations } from '../cache/types.js';
import type { ConduitMetrics } from '../observability/metrics.js';
import type { IMcpClient } from '../proxy/mcp-client-interface.js';
import { createMcpClient } from '../proxy/client-factory.js';
import { buildNamespaceMap, type NamespaceStrategy } from './namespace.js';
import { CircuitBreaker } from './circuit-breaker.js';

/** État de santé d'un backend (serveur ou réplica) */
export interface BackendHealth {
  serverId: string;
  healthy: boolean;
  /** Latence du dernier health check en millisecondes */
  latencyMs: number;
  /** Horodatage du dernier check */
  lastChecked: number;
  /** Nombre d'échecs consécutifs */
  consecutiveFailures: number;
  /** Nombre de succès consécutifs */
  consecutiveSuccesses: number;
}

/** Informations sur un réplica individuel */
export interface ReplicaInfo {
  url: string;
  client: IMcpClient;
  health: BackendHealth;
  /** Circuit breaker for this replica (if enabled) */
  circuitBreaker?: CircuitBreaker;
}

/** Informations complètes sur un serveur enregistré */
export interface ServerInfo {
  config: ServerConfig;
  tools: ToolMetadata[];
  health: BackendHealth;
  annotations: Map<string, ToolAnnotations>;
  /** Réplicas supplémentaires (include la config primaire comme réplica 0) */
  replicas: ReplicaInfo[];
}

/** State summary for a circuit breaker, for admin API exposure */
export interface CircuitBreakerState {
  server_id: string;
  replica_index: number;
  replica_url: string;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  successes: number;
  last_failure: number;
  trip_count: number;
}

export class ServerRegistry {
  /** Map serverId → informations du serveur */
  private readonly servers: Map<string, ServerInfo>;
  /** Map nom_final → { serverId, toolName } — maintenue à jour */
  private namespaceMap: Map<string, { serverId: string; toolName: string }>;
  private readonly clients: Map<string, IMcpClient>;
  private readonly strategy: NamespaceStrategy;
  private readonly healthConfig: HealthCheckConfig;
  private readonly circuitBreakerConfig: CircuitBreakerConfig | undefined;
  private readonly metrics: ConduitMetrics;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(
    config: ConduitGatewayConfig,
    clients: Map<string, IMcpClient>,
    metrics: ConduitMetrics,
  ) {
    this.servers = new Map();
    this.namespaceMap = new Map();
    this.clients = clients;
    this.strategy = config.router.namespace_strategy;
    this.healthConfig = config.router.health_check;
    this.circuitBreakerConfig = config.router.circuit_breaker;
    this.metrics = metrics;

    // Initialisation des entrées de serveur
    for (const serverConfig of config.servers) {
      // Construire les réplicas : réplica 0 = URL primaire, puis les URLs supplémentaires
      const allUrls = [serverConfig.url, ...(serverConfig.replicas ?? [])];
      const replicas: ReplicaInfo[] = allUrls.map((url, idx) => {
        // Réutiliser le client existant pour l'URL primaire, créer de nouveaux pour les réplicas
        const replicaClient = idx === 0
          ? (clients.get(serverConfig.id) ?? createMcpClient({ ...serverConfig, url }))
          : createMcpClient({ ...serverConfig, url });

        // Create a circuit breaker for each replica if enabled
        const cb = this.circuitBreakerConfig?.enabled
          ? new CircuitBreaker(this.circuitBreakerConfig)
          : undefined;

        if (cb) {
          replicaClient.setCircuitBreaker(cb);
        }

        const replicaInfo: ReplicaInfo = {
          url,
          client: replicaClient,
          health: {
            serverId: `${serverConfig.id}:${idx}`,
            healthy: true,
            latencyMs: 0,
            lastChecked: 0,
            consecutiveFailures: 0,
            consecutiveSuccesses: 0,
          },
        };
        if (cb) {
          replicaInfo.circuitBreaker = cb;
        }
        return replicaInfo;
      });

      this.servers.set(serverConfig.id, {
        config: serverConfig,
        tools: [],
        health: {
          serverId: serverConfig.id,
          healthy: false,
          latencyMs: 0,
          lastChecked: 0,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
        },
        annotations: new Map(),
        replicas,
      });

      // Initialisation de la jauge de santé
      this.metrics.backendHealth.set({ server: serverConfig.id }, 0);
    }
  }

  /**
   * Initialise le registre en récupérant les outils de tous les serveurs.
   * Appelé au démarrage de la passerelle.
   */
  async initialize(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.servers.keys()).map((serverId) =>
        this.refreshServer(serverId),
      ),
    );

    this.rebuildNamespaceMap();

    if (this.healthConfig.enabled) {
      this.startHealthChecks();
    }
  }

  // =========================================================================
  // Gestion dynamique des serveurs (hot-reload)
  // =========================================================================

  /**
   * Ajoute un serveur dynamiquement au registre.
   * Crée les replicas, attache les circuit breakers, récupère les outils,
   * et met à jour la namespace map.
   */
  async addServer(serverConfig: ServerConfig, primaryClient: IMcpClient): Promise<void> {
    if (this.servers.has(serverConfig.id)) {
      throw new Error(`Server "${serverConfig.id}" already registered`);
    }

    // Register client
    this.clients.set(serverConfig.id, primaryClient);

    // Build replicas
    const allUrls = [serverConfig.url, ...(serverConfig.replicas ?? [])];
    const replicas: ReplicaInfo[] = allUrls.map((url, idx) => {
      const replicaClient = idx === 0
        ? primaryClient
        : createMcpClient({ ...serverConfig, url });

      const cb = this.circuitBreakerConfig?.enabled
        ? new CircuitBreaker(this.circuitBreakerConfig)
        : undefined;

      if (cb) replicaClient.setCircuitBreaker(cb);

      const replicaInfo: ReplicaInfo = {
        url,
        client: replicaClient,
        health: {
          serverId: `${serverConfig.id}:${idx}`,
          healthy: true,
          latencyMs: 0,
          lastChecked: 0,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
        },
      };
      if (cb) replicaInfo.circuitBreaker = cb;
      return replicaInfo;
    });

    this.servers.set(serverConfig.id, {
      config: serverConfig,
      tools: [],
      health: {
        serverId: serverConfig.id,
        healthy: false,
        latencyMs: 0,
        lastChecked: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      },
      annotations: new Map(),
      replicas,
    });

    this.metrics.backendHealth.set({ server: serverConfig.id }, 0);

    // Fetch tools
    await this.refreshServer(serverConfig.id);
    this.rebuildNamespaceMap();
  }

  /**
   * Supprime un serveur du registre.
   * Nettoie les métriques et met à jour la namespace map.
   */
  removeServer(serverId: string): boolean {
    const serverInfo = this.servers.get(serverId);
    if (!serverInfo) return false;

    const client = this.clients.get(serverId) as IMcpClient & { shutdown?: () => Promise<void> } | undefined;
    if (client?.shutdown) {
      void client.shutdown().catch((error) => {
        console.warn(`[Conduit] Failed to stop stdio client for "${serverId}":`, error);
      });
    }

    this.servers.delete(serverId);
    this.clients.delete(serverId);

    // Cleanup metrics
    this.metrics.backendHealth.remove({ server: serverId });
    for (let i = 0; i < serverInfo.replicas.length; i++) {
      this.metrics.backendActiveConnections.remove({ server: serverId, replica: String(i) });
    }

    this.rebuildNamespaceMap();
    return true;
  }

  /**
   * Récupère et met à jour la liste des outils d'un serveur.
   */
  async refreshServer(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    const serverInfo = this.servers.get(serverId);

    if (!client || !serverInfo) {
      return;
    }

    try {
      const response = await client.forward({
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      });

      if (response.isStream || !response.body) {
        serverInfo.health = {
          ...serverInfo.health,
          healthy: false,
          lastChecked: Date.now(),
        };
        this.metrics.backendHealth.set({ server: serverId }, 0);
        return;
      }

      const body = response.body as {
        result?: { tools?: ToolMetadata[] };
        error?: unknown;
      };

      if (body.error) {
        console.warn(`[Conduit] Erreur tools/list pour ${serverId} :`, body.error);
        serverInfo.health = {
          ...serverInfo.health,
          healthy: false,
          lastChecked: Date.now(),
        };
        this.metrics.backendHealth.set({ server: serverId }, 0);
        return;
      }

      const tools = body.result?.tools ?? [];
      serverInfo.tools = tools;
      serverInfo.health = {
        ...serverInfo.health,
        healthy: true,
        lastChecked: Date.now(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
      };
      this.metrics.backendHealth.set({ server: serverId }, 1);

      // Mise à jour des annotations
      serverInfo.annotations.clear();
      for (const tool of tools) {
        if (tool.name) {
          serverInfo.annotations.set(tool.name, tool.annotations ?? {});
        }
      }

      const primaryReplica = serverInfo.replicas[0];
      if (primaryReplica) {
        primaryReplica.health = {
          ...primaryReplica.health,
          healthy: true,
          lastChecked: Date.now(),
          consecutiveFailures: 0,
          consecutiveSuccesses: 1,
        };
      }

      console.log(`[Conduit] Registre mis à jour : ${tools.length} outil(s) pour "${serverId}"`);
    } catch (error) {
      console.warn(`[Conduit] Impossible de récupérer tools/list pour ${serverId} :`, error);
      serverInfo.health = {
        ...serverInfo.health,
        healthy: false,
        lastChecked: Date.now(),
      };
      this.metrics.backendHealth.set({ server: serverId }, 0);
    }
  }

  /**
   * Reconstruit la map d'espace de noms depuis l'état actuel des serveurs.
   */
  private rebuildNamespaceMap(): void {
    const toolsByServer = new Map<string, string[]>();

    for (const [serverId, serverInfo] of this.servers) {
      if (serverInfo.health.healthy) {
        toolsByServer.set(serverId, serverInfo.tools.map((t) => t.name));
      }
    }

    try {
      this.namespaceMap = buildNamespaceMap(toolsByServer, this.strategy);
    } catch (error) {
      console.error('[Conduit] Erreur lors de la reconstruction de la map de nommage :', error);
    }
  }

  /**
   * Démarre les vérifications périodiques de santé.
   */
  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(
      () => void this.runHealthChecks(),
      this.healthConfig.interval_seconds * 1000,
    );
  }

  /**
   * Effectue le health check de tous les serveurs.
   */
  async runHealthChecks(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.servers.keys()).map((serverId) =>
        this.checkServerHealth(serverId),
      ),
    );
    this.rebuildNamespaceMap();
  }

  /**
   * Vérifie la santé d'un serveur : si plusieurs réplicas, vérifie chacun.
   * Le serveur est considéré sain si au moins un réplica est sain.
   */
  private async checkServerHealth(serverId: string): Promise<void> {
    const serverInfo = this.servers.get(serverId);
    if (!serverInfo) return;

    // Health check de chaque réplica
    await Promise.allSettled(
      serverInfo.replicas.map((replica, idx) =>
        this.checkReplicaHealth(serverId, replica, idx),
      ),
    );

    // Le serveur est sain si au moins un réplica est sain (et circuit non ouvert)
    const anyHealthy = serverInfo.replicas.some((r) => {
      if (!r.health.healthy) return false;
      if (r.circuitBreaker && r.circuitBreaker.getState().state === 'open') return false;
      return true;
    });

    if (serverInfo.health.healthy !== anyHealthy) {
      serverInfo.health = {
        ...serverInfo.health,
        healthy: anyHealthy,
        lastChecked: Date.now(),
      };
    } else {
      serverInfo.health = { ...serverInfo.health, lastChecked: Date.now() };
    }

    this.metrics.backendHealth.set({ server: serverId }, anyHealthy ? 1 : 0);

    if (!anyHealthy) {
      console.warn(`[Conduit] Serveur "${serverId}" entièrement dégradé (tous les réplicas en échec)`);
    }
  }

  /**
   * Vérifie la santé d'un réplica individuel.
   */
  private async checkReplicaHealth(
    serverId: string,
    replica: ReplicaInfo,
    replicaIdx: number,
  ): Promise<void> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.healthConfig.timeout_ms,
    );

    try {
      const serverConfig = this.servers.get(serverId)?.config;
      const isStdio = serverConfig?.transport === 'stdio';

      if (isStdio) {
        // Pour les serveurs stdio, envoyer la requête via le client
        await replica.client.forward({
          body: { jsonrpc: '2.0', id: 0, method: 'initialize', params: {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 'conduit-health-check', version: '1.0.0' },
          }},
          timeoutMs: this.healthConfig.timeout_ms,
        });
      } else {
        // Pour HTTP, utiliser fetch directement
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (serverConfig?.headers) {
          Object.assign(headers, serverConfig.headers);
        }

        await fetch(replica.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 'conduit-health-check', version: '1.0.0' },
          }}),
          signal: controller.signal,
        });
      }

      clearTimeout(timeoutId);

      const latencyMs = Date.now() - startTime;
      const successes = replica.health.consecutiveSuccesses + 1;
      const healthyThreshold = this.healthConfig.healthy_threshold;
      const wasUnhealthy = !replica.health.healthy;
      const nowHealthy = wasUnhealthy ? successes >= healthyThreshold : true;

      replica.health = {
        ...replica.health,
        healthy: nowHealthy,
        latencyMs,
        lastChecked: Date.now(),
        consecutiveFailures: 0,
        consecutiveSuccesses: successes,
      };

      // Update circuit breaker metrics
      if (replica.circuitBreaker) {
        const cbState = replica.circuitBreaker.getState();
        this.metrics.circuitState?.set(
          { server: serverId, replica: String(replicaIdx) },
          cbState.state === 'closed' ? 0 : cbState.state === 'open' ? 1 : 2,
        );
      }

      this.metrics.backendActiveConnections.set(
        { server: serverId, replica: String(replicaIdx) },
        replica.client.activeConnections,
      );
    } catch {
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;
      const failures = replica.health.consecutiveFailures + 1;
      const isUnhealthy = failures >= this.healthConfig.unhealthy_threshold;

      replica.health = {
        ...replica.health,
        healthy: !isUnhealthy,
        latencyMs,
        lastChecked: Date.now(),
        consecutiveFailures: failures,
        consecutiveSuccesses: 0,
      };

      if (isUnhealthy) {
        console.warn(`[Conduit] Réplica ${replicaIdx} de "${serverId}" dégradé après ${failures} échec(s)`);
      }
    }
  }

  /**
   * Retourne la correspondance outil → serveur depuis la map d'espace de noms.
   */
  getNamespaceMap(): Map<string, { serverId: string; toolName: string }> {
    return this.namespaceMap;
  }

  /** Retourne les informations d'un serveur. */
  getServerInfo(serverId: string): ServerInfo | undefined {
    return this.servers.get(serverId);
  }

  /** Retourne tous les serveurs enregistrés. */
  getAllServers(): ServerInfo[] {
    return Array.from(this.servers.values());
  }

  /** Retourne les annotations d'un outil sur un serveur donné. */
  getAnnotations(serverId: string, toolName: string): ToolAnnotations {
    return this.servers.get(serverId)?.annotations.get(toolName) ?? {};
  }

  /** Enregistre les annotations suite à un tools/list passthrough. */
  updateAnnotations(serverId: string, tools: ToolMetadata[]): void {
    const serverInfo = this.servers.get(serverId);
    if (!serverInfo) return;

    serverInfo.tools = tools;
    serverInfo.annotations.clear();
    for (const tool of tools) {
      if (tool.name) {
        serverInfo.annotations.set(tool.name, tool.annotations ?? {});
      }
    }

    this.rebuildNamespaceMap();
  }

  /** Retourne l'état de santé de tous les serveurs. */
  getHealthStatus(): BackendHealth[] {
    return Array.from(this.servers.values()).map((s) => s.health);
  }

  /**
   * Retourne les réplicas sains d'un serveur (pour le load balancing).
   * Exclut les réplicas dont le circuit breaker est en état "open".
   */
  getHealthyReplicas(serverId: string): ReplicaInfo[] {
    const serverInfo = this.servers.get(serverId);
    if (!serverInfo) return [];
    return serverInfo.replicas.filter((r) => {
      if (!r.health.healthy) return false;
      // Exclude replicas with open circuit breakers
      if (r.circuitBreaker && r.circuitBreaker.getState().state === 'open') return false;
      return true;
    });
  }

  /** Returns all circuit breaker states for the admin API. */
  getCircuitBreakerStates(): CircuitBreakerState[] {
    const states: CircuitBreakerState[] = [];
    for (const [serverId, serverInfo] of this.servers) {
      for (let i = 0; i < serverInfo.replicas.length; i++) {
        const replica = serverInfo.replicas[i];
        if (!replica) continue;
        if (replica.circuitBreaker) {
          const cbState = replica.circuitBreaker.getState();
          states.push({
            server_id: serverId,
            replica_index: i,
            replica_url: replica.url,
            state: cbState.state,
            failures: cbState.failures,
            successes: cbState.successes,
            last_failure: cbState.last_failure,
            trip_count: cbState.trip_count,
          });
        }
      }
    }
    return states;
  }

  /** Resets the circuit breaker for a specific server (all replicas). */
  resetCircuitBreaker(serverId: string): boolean {
    const serverInfo = this.servers.get(serverId);
    if (!serverInfo) return false;
    let reset = false;
    for (const replica of serverInfo.replicas) {
      if (replica.circuitBreaker) {
        replica.circuitBreaker.reset();
        reset = true;
      }
    }
    return reset;
  }

  /** Resets the circuit breaker for a specific replica. */
  resetReplicaCircuitBreaker(serverId: string, replicaIdx: number): boolean {
    const serverInfo = this.servers.get(serverId);
    const replica = serverInfo?.replicas[replicaIdx];
    if (replica?.circuitBreaker) {
      replica.circuitBreaker.reset();
      return true;
    }
    return false;
  }

  /** Arrête les vérifications de santé périodiques. */
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}
