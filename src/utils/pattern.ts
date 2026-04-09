/**
 * Utilitaire partagé de correspondance de patterns avec wildcards.
 *
 * Utilisé par l'ACL et les guardrails pour le matching de noms d'outils,
 * de clients et de serveurs.
 */

/**
 * Vérifie si une valeur correspond à un pattern avec wildcard.
 * Supporte : "*" (tout), "prefix*" (préfixe), et correspondance exacte.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return pattern === value;
}

/**
 * Vérifie si une valeur correspond à au moins un pattern dans la liste.
 */
export function matchesAnyPattern(patterns: string[], value: string): boolean {
  return patterns.some((pattern) => matchesPattern(pattern, value));
}
