/**
 * Évaluateur ACL (Access Control List) pour MCP Conduit.
 *
 * Règles d'évaluation :
 * 1. Les politiques sont évaluées dans l'ordre (premier match gagne)
 * 2. Une politique correspond si client_id match un pattern dans `clients`
 * 3. Dans la politique matchée : deny d'abord, puis allow
 * 4. Si aucune politique ne correspond → utilise default_action
 * 5. Patterns supportés : "*" (tout), "get_*" (préfixe), "agent-*" (préfixe)
 */

import type { AclPolicy, AclDecision } from './types.js';
import type { ToolMetadata } from '../cache/types.js';
import { matchesPattern } from '../utils/pattern.js';

function clientMatchesPolicy(clientId: string, clients: string[]): boolean {
  return clients.some((pattern) => matchesPattern(pattern, clientId));
}

function toolMatchesRule(toolName: string, toolPatterns: string[]): boolean {
  return toolPatterns.some((pattern) => matchesPattern(pattern, toolName));
}

function serverMatchesRule(serverId: string, serverPattern: string): boolean {
  return matchesPattern(serverPattern, serverId);
}

/**
 * Évalue si un client peut appeler un outil sur un serveur donné.
 *
 * @param clientId - Identifiant du client authentifié
 * @param serverId - Identifiant du serveur backend
 * @param toolName - Nom de l'outil (sans namespace)
 * @param policies - Liste des politiques ACL à évaluer
 * @param defaultAction - Action par défaut si aucune politique ne correspond
 */
export function evaluateAcl(
  clientId: string,
  serverId: string,
  toolName: string,
  policies: AclPolicy[],
  defaultAction: 'allow' | 'deny' = 'deny',
): AclDecision {
  for (const policy of policies) {
    if (!clientMatchesPolicy(clientId, policy.clients)) {
      continue;
    }

    // La politique correspond au client — vérifier les règles deny en premier
    if (policy.deny) {
      for (const rule of policy.deny) {
        if (serverMatchesRule(serverId, rule.server) && toolMatchesRule(toolName, rule.tools)) {
          return {
            allowed: false,
            policy_name: policy.name,
            reason: `Refusé par la politique "${policy.name}" : outil "${toolName}" sur "${serverId}"`,
          };
        }
      }
    }

    // Vérifier les règles allow
    if (policy.allow) {
      for (const rule of policy.allow) {
        if (serverMatchesRule(serverId, rule.server) && toolMatchesRule(toolName, rule.tools)) {
          return {
            allowed: true,
            policy_name: policy.name,
            reason: `Autorisé par la politique "${policy.name}" : outil "${toolName}" sur "${serverId}"`,
          };
        }
      }
    }

    // La politique correspond au client mais aucune règle ne correspond à l'outil → refuser
    return {
      allowed: false,
      policy_name: policy.name,
      reason: `Aucune règle dans "${policy.name}" pour l'outil "${toolName}" sur "${serverId}"`,
    };
  }

  // Aucune politique ne correspond → action par défaut
  const allowed = defaultAction === 'allow';
  return {
    allowed,
    policy_name: '',
    reason: allowed
      ? `Aucune politique trouvée, action par défaut : autoriser`
      : `Aucune politique trouvée, action par défaut : refuser`,
  };
}

/**
 * Filtre une liste d'outils pour ne garder que ceux accessibles au client.
 */
export function filterToolsList(
  clientId: string,
  serverId: string,
  tools: ToolMetadata[],
  policies: AclPolicy[],
  defaultAction: 'allow' | 'deny' = 'deny',
): ToolMetadata[] {
  return tools.filter((tool) => {
    const decision = evaluateAcl(clientId, serverId, tool.name, policies, defaultAction);
    return decision.allowed;
  });
}
