/**
 * Types fondamentaux pour la couche de cache MCP Conduit.
 */

/** Résultat brut d'un appel d'outil MCP (contenu JSON-RPC) */
export type ToolCallResult = Record<string, unknown>;

/** Entrée stockée dans le cache */
export interface CacheEntry {
  /** Données de la réponse de l'outil */
  result: ToolCallResult;
  /** Horodatage de création de l'entrée (ms depuis epoch) */
  createdAt: number;
  /** TTL en secondes au moment de la mise en cache */
  ttl: number;
  /** Nom de l'outil pour l'invalidation ciblée */
  toolName: string;
  /** Identifiant du serveur source */
  serverId: string;
}

/** Statut d'une entrée dans le cache */
export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS' | 'SKIP';

/** Statistiques du cache pour un serveur ou globalement */
export interface CacheStats {
  hits: number;
  misses: number;
  skips: number;
  entries: number;
  hitRate: number;
}

/** Annotations d'un outil MCP issues de tools/list */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

/** Métadonnées d'un outil MCP enrichies avec ses annotations */
export interface ToolMetadata {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
}
