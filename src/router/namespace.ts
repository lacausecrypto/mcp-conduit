/**
 * Gestion des espaces de noms d'outils pour la résolution multi-serveur.
 *
 * Stratégies disponibles :
 * - "prefix" : les outils sont préfixés par l'ID du serveur (ex. salesforce.get_contact)
 * - "none" : pas de préfixe — une erreur est levée en cas de conflit
 *
 * Utilisé lors de l'agrégation tools/list et du routage tools/call.
 */

/** Séparateur entre le préfixe serveur et le nom d'outil */
const NAMESPACE_SEPARATOR = '.';

/** Stratégie d'espace de noms */
export type NamespaceStrategy = 'prefix' | 'none';

/**
 * Applique le préfixe du serveur à un nom d'outil.
 * Ex. : serverId="salesforce", toolName="get_contact" → "salesforce.get_contact"
 */
export function applyNamespace(serverId: string, toolName: string): string {
  return `${serverId}${NAMESPACE_SEPARATOR}${toolName}`;
}

/**
 * Résout un nom d'outil préfixé vers (serverId, toolName).
 * Ex. : "salesforce.get_contact" → { serverId: "salesforce", toolName: "get_contact" }
 *
 * @returns null si le nom ne correspond pas au format préfixé attendu
 */
export function resolveNamespacedTool(
  namespacedName: string,
): { serverId: string; toolName: string } | null {
  const separatorIndex = namespacedName.indexOf(NAMESPACE_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }

  const serverId = namespacedName.slice(0, separatorIndex);
  const toolName = namespacedName.slice(separatorIndex + 1);

  if (!serverId || !toolName) {
    return null;
  }

  return { serverId, toolName };
}

/**
 * Détecte les conflits de noms d'outils entre plusieurs serveurs.
 * Retourne la liste des noms en conflit.
 */
export function detectConflicts(
  toolsByServer: Map<string, string[]>,
): string[] {
  const nameCount = new Map<string, number>();

  for (const tools of toolsByServer.values()) {
    for (const toolName of tools) {
      nameCount.set(toolName, (nameCount.get(toolName) ?? 0) + 1);
    }
  }

  return Array.from(nameCount.entries())
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
}

/**
 * Applique la stratégie d'espace de noms à une liste d'outils agrégée.
 *
 * En mode "prefix" : chaque outil reçoit le préfixe de son serveur d'origine.
 * En mode "none" : les conflits provoquent une erreur.
 *
 * @param toolsByServer - Map serverId → liste de noms d'outils
 * @param strategy - Stratégie d'espace de noms
 * @returns Map nom_final → { serverId, toolName }
 */
export function buildNamespaceMap(
  toolsByServer: Map<string, string[]>,
  strategy: NamespaceStrategy,
): Map<string, { serverId: string; toolName: string }> {
  const result = new Map<string, { serverId: string; toolName: string }>();

  if (strategy === 'none') {
    const conflicts = detectConflicts(toolsByServer);
    if (conflicts.length > 0) {
      throw new Error(
        `Conflits de noms d'outils détectés (stratégie "none") : ${conflicts.join(', ')}. ` +
        `Utilisez la stratégie "prefix" pour résoudre les conflits.`,
      );
    }

    for (const [serverId, tools] of toolsByServer) {
      for (const toolName of tools) {
        result.set(toolName, { serverId, toolName });
      }
    }
  } else {
    // Stratégie "prefix" : tous les outils sont préfixés
    for (const [serverId, tools] of toolsByServer) {
      for (const toolName of tools) {
        const namespacedName = applyNamespace(serverId, toolName);
        result.set(namespacedName, { serverId, toolName });
      }
    }
  }

  return result;
}

/**
 * Résout un nom d'outil (préfixé ou non) vers (serverId, toolName).
 * Essaie d'abord la résolution directe depuis la map, puis la décomposition.
 */
export function resolveTool(
  toolName: string,
  namespaceMap: Map<string, { serverId: string; toolName: string }>,
  strategy: NamespaceStrategy,
): { serverId: string; toolName: string } | null {
  // Recherche directe dans la map (fonctionne pour les deux stratégies)
  const direct = namespaceMap.get(toolName);
  if (direct) {
    return direct;
  }

  // En mode prefix, tenter la décomposition si la recherche directe échoue
  if (strategy === 'prefix') {
    return resolveNamespacedTool(toolName);
  }

  return null;
}
