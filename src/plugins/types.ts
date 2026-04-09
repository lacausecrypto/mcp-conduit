/**
 * Types pour le système de plugins/middleware de Conduit.
 *
 * Les plugins s'enregistrent sur des hooks à différents points
 * du pipeline de traitement des requêtes.
 */

import type { JsonRpcMessage } from '../proxy/json-rpc.js';
import type { CoreResult } from '../proxy/transport.js';

/** Points d'accroche disponibles dans le pipeline */
export type HookName =
  | 'before:request'    // Avant l'authentification
  | 'after:auth'        // Après l'authentification réussie
  | 'before:cache'      // Avant la recherche en cache
  | 'after:upstream'    // Après la réponse du backend
  | 'before:response';  // Avant l'envoi de la réponse au client

/** Contexte partagé entre les hooks d'une même requête */
export interface PluginContext {
  /** Identifiant du serveur cible */
  serverId: string;
  /** Méthode JSON-RPC (tools/call, tools/list, etc.) */
  method: string;
  /** Nom de l'outil (pour tools/call) */
  toolName?: string;
  /** Identifiant du client authentifié */
  clientId: string;
  /** Trace ID de la requête */
  traceId: string;
  /** Message JSON-RPC original */
  message: JsonRpcMessage;
  /** En-têtes supplémentaires à propager (mutable) */
  extraHeaders: Record<string, string>;
  /** Métadonnées partagées entre hooks (mutable) */
  metadata: Record<string, unknown>;
}

/** Résultat d'un hook de plugin */
export interface PluginResult {
  /** Si défini, court-circuite le pipeline et retourne cette réponse */
  response?: CoreResult;
}

/** Callback de hook */
export type HookCallback = (ctx: PluginContext) => Promise<PluginResult | void>;

/** Interface qu'un plugin doit exporter */
export interface ConduitPlugin {
  /** Nom unique du plugin */
  name: string;
  /** Hooks enregistrés par le plugin */
  hooks: Partial<Record<HookName, HookCallback>>;
  /** Initialisation asynchrone (optionnel) */
  initialize?(): Promise<void>;
  /** Arrêt propre (optionnel) */
  shutdown?(): Promise<void>;
}

/** Configuration d'un plugin dans le fichier YAML */
export interface PluginConfig {
  /** Nom affiché du plugin */
  name: string;
  /** Chemin vers le fichier JS/TS du plugin */
  path: string;
  /** Hooks à activer pour ce plugin */
  hooks: HookName[];
  /** Configuration spécifique au plugin (optionnel) */
  config?: Record<string, unknown>;
}
