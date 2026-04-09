/**
 * Types pour le système de service discovery de Conduit.
 *
 * Permet aux serveurs MCP de s'auto-enregistrer ou d'être
 * découverts automatiquement via DNS SRV, Consul, ou HTTP.
 */

import type { ServerCacheConfig, TransportType } from '../config/types.js';

/** Serveur découvert par un backend de discovery */
export interface DiscoveredServer {
  /** Identifiant unique du serveur */
  id: string;
  /** URL du serveur MCP (HTTP) ou identifiant (stdio) */
  url: string;
  /** Type de transport */
  transport?: TransportType;
  /** Commande stdio (si transport=stdio) */
  command?: string;
  /** Args stdio */
  args?: string[];
  /** Métadonnées optionnelles du serveur */
  metadata?: Record<string, unknown>;
}

/** Interface qu'un backend de discovery doit implémenter */
export interface DiscoveryBackend {
  /** Nom du backend (pour les logs) */
  readonly name: string;
  /** Interroge le backend et retourne les serveurs découverts */
  poll(): Promise<DiscoveredServer[]>;
  /** Initialisation (optionnel) */
  start?(): Promise<void>;
  /** Arrêt propre (optionnel) */
  stop?(): void;
}

/** Configuration d'un backend de discovery */
export interface DiscoveryBackendConfig {
  /** Type de backend */
  type: 'http' | 'dns' | 'consul';
  /** Domaine DNS SRV (type=dns) */
  domain?: string;
  /** URL du serveur Consul (type=consul) */
  consul_url?: string;
  /** Nom du service dans Consul (type=consul) */
  service_name?: string;
}

/** Configuration globale du discovery */
export interface DiscoveryConfig {
  enabled: boolean;
  /** Intervalle de polling en secondes (défaut: 30) */
  poll_interval_seconds: number;
  /** Délai d'expiration d'un serveur sans heartbeat en secondes (défaut: 90) */
  stale_timeout_seconds: number;
  /** Config cache par défaut pour les serveurs découverts */
  default_cache: ServerCacheConfig;
  /** Backends de discovery actifs */
  backends: DiscoveryBackendConfig[];
}
