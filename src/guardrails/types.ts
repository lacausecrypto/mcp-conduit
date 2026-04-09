/**
 * Types pour le système de guardrails de Conduit.
 *
 * Les guardrails inspectent les appels d'outils (nom + arguments)
 * et peuvent bloquer, alerter, exiger une approbation ou transformer les arguments.
 */

/** Opérateurs de condition pour inspecter les arguments d'outils */
export type ConditionOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'matches'
  | 'exists'
  | 'not_exists';

/** Actions possibles d'une règle guardrail */
export type GuardrailAction = 'block' | 'alert' | 'require_approval' | 'transform';

/** Niveaux de sévérité pour le logging et les alertes */
export type GuardrailSeverity = 'low' | 'medium' | 'high' | 'critical';

/** Condition sur un champ des arguments d'un outil */
export interface GuardrailCondition {
  /** Chemin dot-path dans les arguments : "batch_size" ou "options.limit" */
  field: string;
  /** Opérateur de comparaison */
  operator: ConditionOperator;
  /** Valeur de référence (non requise pour exists/not_exists) */
  value?: unknown;
}

/** Règle guardrail statique */
export interface GuardrailRule {
  /** Nom unique de la règle */
  name: string;
  /** Patterns de noms d'outils (wildcards : "delete_*", "*") */
  tools?: string[];
  /** Patterns de clients pour le scoping (optionnel = tous) */
  clients?: string[];
  /** Patterns de serveurs pour le scoping (optionnel = tous) */
  servers?: string[];
  /** Si true, skip tous les guardrails pour ces clients */
  bypass?: boolean;
  /** Conditions sur les arguments (toutes doivent matcher = AND) */
  conditions?: GuardrailCondition[];
  /** Action à prendre quand la règle matche */
  action: GuardrailAction;
  /** Message retourné au client en cas de block */
  message?: string;
  /** Sévérité pour le logging et les alertes */
  severity?: GuardrailSeverity;
  /** URL webhook pour les alertes (fire-and-forget) */
  webhook?: string;
}

/** Configuration globale des guardrails */
export interface GuardrailsConfig {
  /** Activer/désactiver les guardrails */
  enabled: boolean;
  /** Action par défaut si aucune règle ne matche : "allow" ou "block" */
  default_action: 'allow' | 'block';
  /** Liste des règles évaluées dans l'ordre (premier match gagne) */
  rules: GuardrailRule[];
}

/** Résultat de l'évaluation des guardrails */
export interface GuardrailDecision {
  /** Action finale : 'allow', 'block', 'alert', 'require_approval', 'transform' */
  action: 'allow' | GuardrailAction;
  /** Nom de la règle qui a déclenché (vide si action par défaut) */
  rule_name: string;
  /** Raison humainement lisible */
  reason: string;
  /** Sévérité (pour logging/alerting) */
  severity?: GuardrailSeverity;
  /** URL webhook à notifier */
  webhook?: string;
}
