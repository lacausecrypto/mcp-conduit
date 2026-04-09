/**
 * Évaluateur de guardrails pour MCP Conduit.
 *
 * Fonction pure qui évalue les règles guardrails contre un appel d'outil.
 * Même pattern que evaluateAcl() : first-match-wins, pas d'effets de bord.
 *
 * Règles d'évaluation :
 * 1. Les règles sont évaluées dans l'ordre (premier match gagne)
 * 2. Si une règle bypass matche le client → allow immédiat
 * 3. Une règle matche si : clients + servers + tools + conditions sont tous satisfaits
 * 4. Si aucune règle ne matche → utilise default_action
 */

import { matchesPattern, matchesAnyPattern } from '../utils/pattern.js';
import type {
  GuardrailsConfig,
  GuardrailRule,
  GuardrailCondition,
  GuardrailDecision,
  ConditionOperator,
} from './types.js';

/** Contexte d'un appel d'outil à évaluer */
export interface GuardrailContext {
  clientId: string;
  serverId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

/**
 * Évalue toutes les règles guardrails contre un appel d'outil.
 */
export function evaluateGuardrails(
  context: GuardrailContext,
  config: GuardrailsConfig,
): GuardrailDecision {
  for (const rule of config.rules) {
    // Vérifier le scope client (si spécifié)
    if (rule.clients && rule.clients.length > 0) {
      if (!matchesAnyPattern(rule.clients, context.clientId)) {
        continue;
      }
    }

    // Vérifier le scope serveur (si spécifié)
    if (rule.servers && rule.servers.length > 0) {
      if (!matchesAnyPattern(rule.servers, context.serverId)) {
        continue;
      }
    }

    // Bypass : skip tous les guardrails pour ce client
    if (rule.bypass) {
      return {
        action: 'allow',
        rule_name: rule.name,
        reason: `Bypass par la règle "${rule.name}" pour le client "${context.clientId}"`,
      };
    }

    // Vérifier le scope outil (si spécifié)
    if (rule.tools && rule.tools.length > 0) {
      if (!matchesAnyPattern(rule.tools, context.toolName)) {
        continue;
      }
    }

    // Évaluer les conditions (AND : toutes doivent être satisfaites)
    if (rule.conditions && rule.conditions.length > 0) {
      const allMatch = rule.conditions.every((condition) =>
        evaluateCondition(condition, context.toolArgs),
      );
      if (!allMatch) {
        continue;
      }
    }

    // La règle matche → retourner son action
    const message = rule.message ?? `Règle "${rule.name}" déclenchée sur l'outil "${context.toolName}"`;
    const decision: GuardrailDecision = {
      action: rule.action,
      rule_name: rule.name,
      reason: message,
    };
    if (rule.severity !== undefined) decision.severity = rule.severity;
    if (rule.webhook !== undefined) decision.webhook = rule.webhook;
    return decision;
  }

  // Aucune règle ne matche → action par défaut
  const allowed = config.default_action === 'allow';
  return {
    action: allowed ? 'allow' : 'block',
    rule_name: '',
    reason: allowed
      ? 'Aucune règle guardrail déclenchée, action par défaut : autoriser'
      : 'Aucune règle guardrail déclenchée, action par défaut : bloquer',
  };
}

/**
 * Évalue une condition sur les arguments d'un outil.
 */
function evaluateCondition(
  condition: GuardrailCondition,
  args: Record<string, unknown>,
): boolean {
  const actual = resolveField(args, condition.field);

  // exists / not_exists ne nécessitent pas de valeur de référence
  if (condition.operator === 'exists') {
    return actual !== undefined;
  }
  if (condition.operator === 'not_exists') {
    return actual === undefined;
  }

  // Si le champ n'existe pas, la condition ne matche pas
  if (actual === undefined) {
    return false;
  }

  return compareValue(actual, condition.operator, condition.value);
}

/**
 * Résout un chemin dot-path dans un objet imbriqué.
 * Ex: resolveField({ options: { limit: 500 } }, "options.limit") → 500
 */
function resolveField(
  obj: Record<string, unknown>,
  fieldPath: string,
): unknown {
  const parts = fieldPath.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Compare une valeur avec un opérateur et une valeur attendue.
 */
function compareValue(
  actual: unknown,
  operator: ConditionOperator,
  expected: unknown,
): boolean {
  switch (operator) {
    case 'eq':
      return actual === expected;

    case 'neq':
      return actual !== expected;

    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;

    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;

    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;

    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;

    case 'contains': {
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return false;
    }

    case 'not_contains': {
      if (typeof actual === 'string' && typeof expected === 'string') {
        return !actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return !actual.includes(expected);
      }
      return true;
    }

    case 'matches': {
      if (typeof actual !== 'string' || typeof expected !== 'string') {
        return false;
      }
      try {
        return new RegExp(expected).test(actual);
      } catch {
        return false;
      }
    }

    // exists / not_exists handled in evaluateCondition
    default:
      return false;
  }
}
