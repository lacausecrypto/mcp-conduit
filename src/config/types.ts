/**
 * Types de configuration pour MCP Conduit.
 * Définit la structure complète du fichier YAML de configuration.
 */

import type { AuthConfig, AclConfig } from '../auth/types.js';
import type { RateLimitConfig, ToolRateLimitConfig } from '../rate-limit/types.js';
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
export type ManagedRuntimeChannel = 'stable' | 'beta' | 'canary' | 'pinned';
export type ManagedRuntimeSourceType = 'npm' | 'pypi' | 'oci' | 'command';
export type ManagedRuntimeReleaseStatus = 'active' | 'healthy' | 'candidate' | 'failed' | 'rolled_back';

/** Mode de forwarding de l'identité du client vers l'upstream */
export type IdentityForwardMode = 'none' | 'bearer' | 'claims-header';

/** Stratégie de résolution d'un compte connecté */
export type ConnectedAccountBinding = 'client' | 'tenant' | 'workspace' | 'client-or-workspace';

/** Forwarding de l'identité du client authentifié vers l'upstream */
export interface UpstreamIdentityForwardConfig {
  /** Bearer passthrough ou header JSON de claims */
  mode?: IdentityForwardMode;
  /** Nom du header pour mode=claims-header (défaut: X-Conduit-Identity) */
  header_name?: string;
}

/** Résolution dynamique d'un compte connecté stocké côté Conduit */
export interface UpstreamConnectedAccountConfig {
  /** Provider logique, ex: github, linear, vercel */
  provider: string;
  /** Comment résoudre le compte pour la requête en cours */
  binding?: ConnectedAccountBinding;
  /** Si true (défaut), l'appel échoue si aucun compte n'est connecté */
  required?: boolean;
  /** Templates de headers injectés après résolution du compte */
  headers?: Record<string, string>;
}

/** Auth upstream dynamique résolue par Conduit au runtime */
export interface UpstreamAuthConfig {
  /** Compte connecté utilisateur ou workspace */
  connected_account?: UpstreamConnectedAccountConfig;
  /** Forwarding de l'identité authentifiée */
  forward_identity?: UpstreamIdentityForwardConfig;
}

/** Politique d’isolation locale du runtime managé */
export interface ManagedRuntimeSandboxConfig {
  /** Active l’isolation du process via cwd/env dédiés */
  enabled?: boolean;
  /** Racine du sandbox pour ce serveur */
  root_dir?: string;
  /** Réduit l’environnement transmis au process */
  sanitize_env?: boolean;
  /** Indice de policy réseau (informative pour stdio, appliquée pour OCI) */
  allow_network?: boolean;
}

/** Garde-fou de déploiement du runtime managé */
export interface ManagedRuntimeHealthGateConfig {
  /** Vérifie la santé après un rollout */
  enabled?: boolean;
  /** Revient automatiquement au dernier release sain en cas d’échec */
  auto_rollback?: boolean;
}

/** Release exécutable d’un serveur stdio/package géré par Conduit */
export interface ManagedRuntimeReleaseConfig {
  id: string;
  version: string;
  channel: ManagedRuntimeChannel;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  created_at: string;
  status?: ManagedRuntimeReleaseStatus;
  notes?: string;
}

/** Métadonnées de runtime managé pour un serveur stdio/package */
export interface ManagedRuntimeServerConfig {
  enabled: boolean;
  source_type: ManagedRuntimeSourceType;
  source_ref: string;
  channel: ManagedRuntimeChannel;
  active_release_id: string;
  last_healthy_release_id?: string;
  last_rollout_at?: string;
  sandbox?: ManagedRuntimeSandboxConfig;
  health_gate?: ManagedRuntimeHealthGateConfig;
  releases: ManagedRuntimeReleaseConfig[];
}

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
  /** En-têtes HTTP statiques ajoutés à chaque requête upstream */
  headers?: Record<string, string>;
  /** URLs des réplicas supplémentaires pour le load balancing (HTTP uniquement) */
  replicas?: string[];
  /** Configuration du cache pour ce serveur */
  cache: ServerCacheConfig;
  /** Délai d'expiration en ms pour les appels vers ce serveur (défaut : 30 000) */
  timeout_ms?: number;
  /** Auth upstream résolue dynamiquement par le plan identité */
  upstream_auth?: UpstreamAuthConfig;
  /**
   * Si true, le header Authorization de la requête entrante est propagé
   * vers ce serveur upstream lorsque aucun upstream_auth n'est configuré.
   * Désactivé par défaut : éviter de fuiter le bearer token du client
   * (typiquement la clé Conduit elle-même) vers un upstream non vérifié.
   */
  forward_authorization?: boolean;
  /** Runtime managé pour package/stdio avec pinning et rollback */
  managed_runtime?: ManagedRuntimeServerConfig;
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
  /**
   * Si true, l'endpoint /metrics exige le même token Bearer que l'API admin
   * (admin.key ou CONDUIT_ADMIN_KEY). Fortement recommandé si le port de
   * métriques est accessible hors du cluster. Par défaut : false, le port
   * Prometheus étant classiquement exposé uniquement à la stack de scrape.
   */
  require_auth?: boolean;
}

/** Configuration de l'API d'administration */
export interface AdminConfig {
  /**
   * Clé d'accès à l'API admin (Bearer token).
   * Si définie, toutes les requêtes /conduit/* doivent présenter
   * le header "Authorization: Bearer <admin_key>".
   * Requise dès que la passerelle bind une interface non-loopback,
   * sauf si admin.allow_unauthenticated est explicitement à true.
   */
  key?: string;
  /**
   * Autorise explicitement les URL d'upstream sur des réseaux privés
   * pour les imports/ajouts dynamiques via l'API admin.
   * Désactivé par défaut pour éviter les SSRF sur les endpoints admin.
   */
  allow_private_networks?: boolean;
  /**
   * Opt-in explicite pour autoriser un démarrage sans admin.key alors
   * que gateway.host n'est pas loopback. Sans ce flag, la passerelle
   * refuse de démarrer pour éviter qu'un déploiement accidentellement
   * exposé soit administrable sans authentification.
   */
  allow_unauthenticated?: boolean;
}

/** Profil connect exportable vers les clients MCP */
export interface ConnectProfileConfig {
  /** Identifiant stable du profil */
  id: string;
  /** Libellé affiché dans le dashboard */
  label?: string;
  /** Description courte du profil */
  description?: string;
  /** Serveurs Conduit inclus dans ce profil */
  server_ids: string[];
}

/** Configuration de l’ingestion du registry MCP officiel */
export interface ConnectRegistryConfig {
  /** Base URL du registry MCP source */
  base_url?: string;
  /** Durée de cache locale en secondes */
  cache_ttl_seconds?: number;
  /** Taille de page amont lors du scraping */
  page_size?: number;
  /** Nombre maximum de pages ingérées par refresh (0 = suivre toute la pagination) */
  max_pages?: number;
  /** Ne conserver que les versions latest dans la bibliothèque */
  latest_only?: boolean;
}

/** Configuration de la couche connect/distribution */
export interface ConnectManagedRuntimeConfig {
  /** Active le runtime managé pour les imports package/stdio */
  enabled?: boolean;
  /** Répertoire racine des sandboxes locales */
  root_dir?: string;
  /** Channel par défaut des imports package */
  default_channel?: ManagedRuntimeChannel;
  /** Réduit l’environnement des processus lancés */
  sanitize_env?: boolean;
  /** Auto-rollback global après un rollout non sain */
  auto_rollback?: boolean;
}

/** Configuration de la couche connect/distribution */
export interface ConnectConfig {
  /** Profils exportables/synchronisables */
  profiles?: ConnectProfileConfig[];
  /** Paramètres de la bibliothèque registry */
  registry?: ConnectRegistryConfig;
  /** Runtime managé pour les imports package/stdio */
  managed_runtime?: ConnectManagedRuntimeConfig;
}

/** Workspace logique pour regrouper des tenants sous une même identité */
export interface IdentityWorkspaceConfig {
  /** Identifiant stable du workspace */
  id: string;
  /** Libellé humain affiché dans l'admin */
  label?: string;
  /** Tenants associés à ce workspace */
  tenant_ids?: string[];
}

/** Configuration du plan d'identité et credentials */
export interface IdentityConfig {
  /** Active le broker d'identité et les connected accounts */
  enabled: boolean;
  /** SQLite local dédié aux comptes connectés et refs de secrets */
  db_path?: string;
  /** Workspace par défaut si aucun mapping tenant -> workspace n'existe */
  default_workspace_id?: string;
  /** Mapping explicite tenant -> workspace */
  workspaces?: IdentityWorkspaceConfig[];
}

/** Rôles RBAC de workspace */
export type WorkspaceRole = 'owner' | 'admin' | 'approver' | 'operator' | 'developer' | 'viewer';

/** Binding statique client -> rôle dans un workspace */
export interface GovernanceRoleBindingConfig {
  workspace_id: string;
  role: WorkspaceRole;
  clients: string[];
}

/** Politique runtime d’accès/scoping par workspace */
export interface GovernanceToolPolicyConfig {
  name: string;
  workspace_ids?: string[];
  roles?: WorkspaceRole[];
  clients?: string[];
  servers?: string[];
  tools?: string[];
  effect: 'allow' | 'deny' | 'require_approval';
  reason?: string;
}

/** Politique allow/block sur les MCP du registry officiel */
export interface GovernanceRegistryPolicyConfig {
  name: string;
  workspace_ids?: string[];
  roles?: WorkspaceRole[];
  clients?: string[];
  server_names?: string[];
  package_types?: string[];
  install_modes?: string[];
  effect: 'allow' | 'deny';
  reason?: string;
}

/** Quota runtime appliqué à un workspace */
export interface GovernanceWorkspaceQuotaConfig extends ToolRateLimitConfig {
  workspace_id: string;
}

/** Configuration des quotas de workspace */
export interface GovernanceQuotasConfig {
  default?: ToolRateLimitConfig;
  workspaces?: GovernanceWorkspaceQuotaConfig[];
}

/** Configuration de la file d’approbation */
export interface GovernanceApprovalsConfig {
  enabled?: boolean;
  ttl_seconds?: number;
  required_roles?: WorkspaceRole[];
  allow_self_approval?: boolean;
}

/** Plan de gouvernance entreprise */
export interface GovernanceConfig {
  enabled: boolean;
  db_path?: string;
  registry_default_action?: 'allow' | 'deny';
  role_bindings?: GovernanceRoleBindingConfig[];
  tool_policies?: GovernanceToolPolicyConfig[];
  registry_policies?: GovernanceRegistryPolicyConfig[];
  quotas?: GovernanceQuotasConfig;
  approvals?: GovernanceApprovalsConfig;
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
  /** Configuration des profils connect (optionnel) */
  connect?: ConnectConfig;
  /** Plan d'identité et credentials (optionnel, défaut: désactivé) */
  identity?: IdentityConfig;
  /** Plan de gouvernance entreprise (optionnel, défaut: désactivé) */
  governance?: GovernanceConfig;
  /** Configuration des guardrails IA (optionnel, défaut: désactivé) */
  guardrails?: GuardrailsConfig;
  /** Configuration des plugins (optionnel) */
  plugins?: import('../plugins/types.js').PluginConfig[];
  /** Configuration du service discovery (optionnel) */
  discovery?: import('../discovery/types.js').DiscoveryConfig;
}
