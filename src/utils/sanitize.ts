/**
 * Utilitaires de sanitisation des arguments d'outils MCP.
 * Utilisé avant la journalisation et le calcul des clés de cache.
 */

/**
 * Tronque les valeurs de chaîne longues pour éviter la saturation des logs.
 * Les objets et tableaux sont parcourus récursivement.
 *
 * @param value - Valeur à sanitiser
 * @param maxLength - Longueur maximale des chaînes (défaut : 500 caractères)
 */
export function sanitizeArgs(
  value: unknown,
  maxLength = 500,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    if (value.length > maxLength) {
      return `${value.slice(0, maxLength)}…[${value.length - maxLength} caractères tronqués]`;
    }
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeArgs(item, maxLength));
  }

  if (typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = sanitizeArgs(val, maxLength);
    }
    return sanitized;
  }

  return value;
}

/**
 * Tronque une chaîne à la longueur maximale indiquée.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength)}…`;
}
