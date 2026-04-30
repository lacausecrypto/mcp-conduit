/**
 * Routeur de requêtes MCP avec load balancing.
 *
 * Responsabilités :
 * - tools/list : agrège les outils de tous les backends, applique l'espace de noms
 * - tools/call : route vers le bon backend selon le nom de l'outil
 * - Load balancing : round-robin ou least-connections entre les réplicas sains
 * - Autres méthodes : route selon le serverId de l'URL
 */

import type { ServerRegistry } from './registry.js';
import type { IMcpClient } from '../proxy/mcp-client-interface.js';
import type { ConduitGatewayConfig, LoadBalancingStrategy } from '../config/types.js';
import type { ToolMetadata } from '../cache/types.js';
import {
  buildJsonRpcResult,
  buildJsonRpcError,
  JSON_RPC_ERRORS,
  type JsonRpcMessage,
} from '../proxy/json-rpc.js';
import { resolveTool } from './namespace.js';

export interface RoutedRequest {
  serverId: string;
  toolName: string;
  client: IMcpClient;
}

export class ConduitRouter {
  private readonly registry: ServerRegistry;
  private readonly clients: Map<string, IMcpClient>;
  private readonly config: ConduitGatewayConfig;
  /** Compteurs round-robin par serveur */
  private readonly roundRobinCounters = new Map<string, number>();

  constructor(
    registry: ServerRegistry,
    clients: Map<string, IMcpClient>,
    config: ConduitGatewayConfig,
  ) {
    this.registry = registry;
    this.clients = clients;
    this.config = config;
  }

  /**
   * Résout la cible d'un appel d'outil.
   * Retourne null si l'outil est introuvable.
   */
  resolveToolCall(toolName: string): RoutedRequest | null {
    const namespaceMap = this.registry.getNamespaceMap();
    const resolved = resolveTool(toolName, namespaceMap, this.config.router.namespace_strategy);

    if (!resolved) {
      return null;
    }

    const client = this.selectReplica(resolved.serverId);
    if (!client) {
      return null;
    }

    return {
      serverId: resolved.serverId,
      toolName: resolved.toolName,
      client,
    };
  }

  /**
   * Sélectionne un réplica sain selon la stratégie de load balancing.
   */
  private selectReplica(serverId: string): IMcpClient | null {
    const healthyReplicas = this.registry.getHealthyReplicas(serverId);
    if (healthyReplicas.length === 0) return null;

    const strategy: LoadBalancingStrategy = this.config.router.load_balancing ?? 'round-robin';

    if (strategy === 'least-connections') {
      // Choisir le réplica avec le moins de connexions actives
      let selected = healthyReplicas[0];
      for (const replica of healthyReplicas) {
        if (selected === undefined || replica.client.activeConnections < selected.client.activeConnections) {
          selected = replica;
        }
      }
      return selected?.client ?? null;
    }

    // round-robin (défaut)
    const counter = this.roundRobinCounters.get(serverId) ?? 0;
    const idx = counter % healthyReplicas.length;
    this.roundRobinCounters.set(serverId, counter + 1);
    return healthyReplicas[idx]?.client ?? null;
  }

  /**
   * Construit la réponse tools/list agrégée depuis tous les backends sains.
   * Applique l'espace de noms selon la stratégie configurée.
   */
  buildAggregatedToolsList(id: string | number | null | undefined): JsonRpcMessage {
    const tools = this.getAggregatedToolsWithServerIds().map(({ namespacedName, toolDef }) => ({
      ...toolDef,
      name: namespacedName,
    }));

    return buildJsonRpcResult(id, { tools });
  }

  /**
   * Retourne les outils agrégés avec leurs informations de serveur.
   * Utilisé pour le filtrage ACL par serveur.
   */
  getAggregatedToolsWithServerIds(): Array<{
    namespacedName: string;
    serverId: string;
    toolName: string;
    toolDef: ToolMetadata;
  }> {
    const result: Array<{
      namespacedName: string;
      serverId: string;
      toolName: string;
      toolDef: ToolMetadata;
    }> = [];

    const namespaceMap = this.registry.getNamespaceMap();

    for (const [namespacedName, { serverId, toolName }] of namespaceMap) {
      const serverInfo = this.registry.getServerInfo(serverId);
      if (!serverInfo?.health.healthy) continue;

      const toolDef = serverInfo.tools.find((t) => t.name === toolName);
      if (toolDef) {
        result.push({ namespacedName, serverId, toolName, toolDef });
      }
    }

    return result;
  }

  /**
   * Résout le nom de l'outil (suppression du namespace) sans sélectionner de réplica.
   */
  resolveToolName(toolName: string): { serverId: string; toolName: string } | null {
    const namespaceMap = this.registry.getNamespaceMap();
    return resolveTool(toolName, namespaceMap, this.config.router.namespace_strategy);
  }

  /**
   * Valide que tools/list pour un serveur spécifique peut être routé.
   */
  getClientForServer(serverId: string): IMcpClient | null {
    const serverInfo = this.registry.getServerInfo(serverId);
    if (!serverInfo) return null;

    // Pour un accès direct au serveur, utiliser le load balancing
    return this.selectReplica(serverId);
  }

  /**
   * Construit une erreur "outil introuvable" pour tools/call.
   */
  buildToolNotFoundError(
    id: string | number | null | undefined,
    toolName: string,
  ): JsonRpcMessage {
    return buildJsonRpcError(
      id,
      JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Outil introuvable : ${toolName}`,
    );
  }

  /**
   * Construit une erreur "serveur indisponible".
   */
  buildServerUnavailableError(
    id: string | number | null | undefined,
    serverId: string,
  ): JsonRpcMessage {
    return buildJsonRpcError(
      id,
      JSON_RPC_ERRORS.INTERNAL_ERROR,
      `Serveur indisponible : ${serverId}`,
    );
  }
}
