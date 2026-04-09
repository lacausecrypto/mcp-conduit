/**
 * Types de configuration pour MCP Conduit.
 * Définit la structure complète du fichier YAML de configuration.
 */

import type { AuthConfig, AclConfig } from '../auth/types.js';
import type { RateLimitConfig } from '../rate-limit/types.js';
import type { GuardrailsConfig } from '../guardrails/types.js';

export type { AuthConfig, AclConfig, RateLimitConfig, GuardrailsConfig };

/** Erreur de validation de configuration */
export interface ConfigError {
  /** Chemin JSON de la propriété invalide (ex: "gateway.port") */
  path: string;
  /** Message décrivant l'erreur */
  message: string;
  /** Valeur invalide fournie */
  value?: unknown;
}

/** Configuration d'un outil spécifique côté serveur */
export interface ToolOverrideConfig {
  /** Durée de vie en secondes (0 = ne pas mettre en cache) */
  ttl?: number;
  /** Arguments à exclure de la clé de cache (champs non-déterministes) */
  ignore_args?: string[];
  /** Outils dont le cache doit être invalidé lors d'un appel à cet outil */
  invalidates?: string[];
}

/** Configuration du cache pour un serveur donné */
export interface ServerCacheConfig {
  /** TTL par défaut en secondes pour ce serveur */
  default_ttl: number;
  /** Surcharges par nom d'outil */
  overrides?: Record<string, ToolOverrideConfig>;
}

/** Type de transport pour la communication avec le serveur MCP */
export type TransportType = 'http' | 'stdio';

/** Configuration d'un serveur MCP en amont */
export interface ServerConfig {
  /** Identifiant unique du serveur */
  id: string;
  /** URL de l'endpoint MCP (HTTP) ou identifiant (stdio: "stdio://<command>") */
  url: string;
  /** Type de transport : 'http' (défaut) ou 'stdio' (processus enfant) */
  transport?: TransportType;
  /** Commande à exécuter (requis si transport: stdio) */
  command?: string;
  /** Arguments de la commande (transport: stdio) */
  args?: string[];
  /** Variables d'environnement supplémentaires (transport: stdio) */
  env?: Record<string, string>;
  /** URLs des réplicas supplémentaires pour le load balancing (HTTP uniquement) */
  replicas?: string[];
  /** Configuration du cache pour ce serveur */
  cache: ServerCacheConfig;
  /** Délai d'expiration en ms pour les appels vers ce serveur (défaut : 30 000) */
  timeout_ms?: number;
}

/** Configuration du cache L1 en mémoire */
export interface L1CacheConfig {
  /** Nombre maximum d'entrées */
  max_entries: number;
  /** Taille maximale par entrée en Ko */
  max_entry_size_kb: number;
}

/** Configuration du cache L2 Redis distribué */
export interface L2CacheConfig {
  enabled: boolean;
  /** URL de connexion Redis */
  redis_url: string;
  /** Multiplicateur TTL L2 par rapport au L1 (défaut: 3) */
  default_ttl_multiplier: number;
  /** Préfixe des clés Redis (défaut: "conduit:cache:") */
  key_prefix?: string;
  /** Taille maximale par entrée en Ko (défaut: 512) */
  max_entry_size_kb?: number;
}

/** Configuration globale du cache */
export interface CacheConfig {
  enabled: boolean;
  l1: L1CacheConfig;
  /** Cache L2 distribué Redis (optionnel) */
  l2?: L2CacheConfig;
}

/** Configuration TLS native de la passerelle */
export interface TlsConfig {
  enabled: boolean;
  /** Chemin vers le certificat PEM */
  cert_path: string;
  /** Chemin vers la clé privée PEM */
  key_path: string;
  /** Bundle CA optionnel pour mTLS */
  ca_path?: string;
  /** Version TLS minimale : "TLSv1.2" (défaut) ou "TLSv1.3" */
  min_version?: string;
}

/** Configuration de la passerelle HTTP principale */
export interface GatewayConfig {
  /** Port d'écoute de la passerelle */
  port: number;
  /** Adresse d'écoute */
  host: string;
  /** Configuration TLS optionnelle */
  tls?: TlsConfig;
}

/** Configuration du health check des serveurs en amont */
export interface HealthCheckConfig {
  enabled: boolean;
  interval_seconds: number;
  timeout_ms: number;
  unhealthy_threshold: number;
  /** Nombre de succès consécutifs pour marquer un serveur sain (défaut: 1) */
  healthy_threshold: number;
}

/** Stratégie de load balancing */
export type LoadBalancingStrategy = 'round-robin' | 'least-connections';

/** Configuration du circuit breaker */
export interface CircuitBreakerConfig {
  enabled: boolean;
  /** Nombre d'échecs avant ouverture du circuit (défaut: 5) */
  failure_threshold: number;
  /** Durée en état ouvert avant passage à half-open en ms (défaut: 30000) */
  reset_timeout_ms: number;
  /** Requêtes max en état half-open (défaut: 1) */
  half_open_max_requests: number;
  /** Succès nécessaires en half-open pour fermer le circuit (défaut: 2) */
  success_threshold: number;
}

/** Configuration du routeur et de l'espace de noms */
export interface RouterConfig {
  /** Stratégie d'espace de noms : "prefix" (salesforce.get_contact) ou "none" */
  namespace_strategy: 'prefix' | 'none';
  health_check: HealthCheckConfig;
  /** Stratégie de load balancing entre les réplicas */
  load_balancing?: LoadBalancingStrategy;
  /** Configuration du circuit breaker */
  circuit_breaker?: CircuitBreakerConfig;
}

/** Configuration de l'isolation par tenant */
export interface TenantIsolationConfig {
  enabled: boolean;
  /** En-tête HTTP source de l'identifiant tenant */
  header: string;
}

/** Configuration OpenTelemetry */
export interface OpenTelemetryConfig {
  enabled: boolean;
  /** Endpoint OTLP HTTP pour l'export des traces */
  endpoint: string;
  /** Nom du service dans les traces */
  service_name: string;
  /** Taux d'échantillonnage (0.0 - 1.0, défaut: 1.0) */
  sample_rate?: number;
}

/** Configuration de l'observabilité */
export interface ObservabilityConfig {
  /** Journaliser les arguments des appels d'outils */
  log_args: boolean;
  /** Journaliser les réponses */
  log_responses: boolean;
  /** Champs à masquer dans les logs */
  redact_fields: string[];
  /** Durée de rétention des logs en jours */
  retention_days: number;
  /** Chemin vers la base de données SQLite des logs */
  db_path: string;
  /** Configuration OpenTelemetry (optionnel) */
  opentelemetry?: OpenTelemetryConfig;
}

/** Configuration des métriques Prometheus */
export interface MetricsConfig {
  enabled: boolean;
  port: number;
}

/** Configuration de l'API d'administration */
export interface AdminConfig {
  /**
   * Clé d'accès à l'API admin (Bearer token).
   * Si définie, toutes les requêtes /conduit/* doivent présenter
   * le header "Authorization: Bearer <admin_key>".
   * Fortement recommandé en production.
   */
  key?: string;
}

/** Configuration racine de la passerelle Conduit */
export interface ConduitGatewayConfig {
  gateway: GatewayConfig;
  router: RouterConfig;
  servers: ServerConfig[];
  cache: CacheConfig;
  tenant_isolation: TenantIsolationConfig;
  observability: ObservabilityConfig;
  metrics: MetricsConfig;
  /** Configuration d'authentification (optionnel, défaut: none) */
  auth?: AuthConfig;
  /** Configuration ACL (optionnel, défaut: désactivé) */
  acl?: AclConfig;
  /** Configuration du rate limiting (optionnel, défaut: désactivé) */
  rate_limits?: RateLimitConfig;
  /** Configuration de l'API d'administration (optionnel) */
  admin?: AdminConfig;
  /** Configuration des guardrails IA (optionnel, défaut: désactivé) */
  guardrails?: GuardrailsConfig;
  /** Configuration des plugins (optionnel) */
  plugins?: import('../plugins/types.js').PluginConfig[];
  /** Configuration du service discovery (optionnel) */
  discovery?: import('../discovery/types.js').DiscoveryConfig;
}
