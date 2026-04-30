/**
 * Types pour l'authentification et le contrôle d'accès (ACL).
 */

/** Méthode d'authentification supportée */
export type AuthMethod = 'jwt' | 'api-key' | 'none';

/** Entrée de clé API */
export interface ApiKeyEntry {
  key: string;
  client_id: string;
  tenant_id: string;
}

/** Configuration de l'authentification */
export interface AuthConfig {
  method: AuthMethod;
  /** JWT — URL du JWKS */
  jwks_url?: string;
  /** JWT — Émetteur attendu */
  issuer?: string;
  /** JWT — Audience attendue */
  audience?: string;
  /** JWT — Claim contenant l'identifiant tenant (défaut: "org_id") */
  tenant_claim?: string;
  /** JWT — Claim contenant l'identifiant client (défaut: "sub") */
  client_claim?: string;
  /** API key — Liste des clés configurées */
  api_keys?: ApiKeyEntry[];
  /**
   * JWT — Liste blanche d'algorithmes acceptés.
   * Par défaut : algorithmes asymétriques uniquement (RS*, PS*, ES*, EdDSA).
   * Les algorithmes symétriques (HS*) et "none" sont toujours interdits dans
   * un contexte JWKS.
   */
  algorithms?: string[];
}

/** Résultat d'une authentification */
export interface AuthResult {
  authenticated: boolean;
  client_id: string;
  tenant_id: string;
  /** Claims JWT complets (uniquement en mode JWT) */
  claims?: Record<string, unknown>;
  /** Message d'erreur si non authentifié */
  error?: string;
}

/** Règle ACL (allow ou deny) */
export interface AclRule {
  /** Identifiant du serveur ou "*" */
  server: string;
  /** Noms d'outils ou patterns : "get_*", "*", "delete_*" */
  tools: string[];
}

/** Politique ACL */
export interface AclPolicy {
  name: string;
  /** Patterns de client_id : "agent-support-*", "*" */
  clients: string[];
  allow?: AclRule[];
  deny?: AclRule[];
}

/** Configuration ACL globale */
export interface AclConfig {
  enabled: boolean;
  /** Action par défaut si aucune politique ne correspond */
  default_action: 'allow' | 'deny';
  policies: AclPolicy[];
}

/** Décision ACL */
export interface AclDecision {
  allowed: boolean;
  /** Nom de la politique qui a déclenché la décision */
  policy_name: string;
  /** Raison lisible */
  reason: string;
}
