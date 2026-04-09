/**
 * Masquage récursif des champs sensibles dans les objets.
 * Utilisé avant la journalisation pour protéger les données confidentielles.
 *
 * Caractéristiques :
 * - Parcourt récursivement les objets et tableaux
 * - Correspondance partielle sur les noms de champs (insensible à la casse)
 * - Ne modifie pas l'objet original — retourne une copie masquée
 * - Valeur de remplacement : "[REDACTED]"
 */

const REDACTED_VALUE = '[REDACTED]';

/**
 * Masque récursivement les champs sensibles dans une valeur quelconque.
 *
 * @param value - Valeur à masquer (objet, tableau, ou primitive)
 * @param sensitiveFields - Liste des noms de champs à masquer (correspondance partielle)
 * @returns Copie avec les champs sensibles masqués
 */
export function redact(
  value: unknown,
  sensitiveFields: string[],
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, sensitiveFields));
  }

  if (typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;

    for (const [key, val] of Object.entries(obj)) {
      if (isSensitiveField(key, sensitiveFields)) {
        redacted[key] = REDACTED_VALUE;
      } else {
        redacted[key] = redact(val, sensitiveFields);
      }
    }

    return redacted;
  }

  return value;
}

/**
 * Découpe un nom de champ en segments de mots individuels.
 * Gère les séparateurs (_/-) et les transitions camelCase.
 * Ex: "user_password" → ["user", "password"]
 *     "accessToken"   → ["access", "token"]
 *     "apiKey"        → ["api", "key"]
 */
function splitIntoSegments(name: string): string[] {
  return name
    .split(/[_\-]/)
    .flatMap((part) => part.split(/(?<=[a-z])(?=[A-Z])/))
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Vérifie si un nom de champ doit être masqué.
 * Utilise un matching par segments de mots pour éviter les faux positifs
 * (ex: "tokenizer" ne matche PAS "token", mais "access_token" oui).
 *
 * Stratégie en 2 passes :
 * 1. Matching par segments : les segments sensibles doivent apparaître
 *    comme sous-séquence contiguë (ex: "user_password" → ["password"] ✓)
 * 2. Matching par concaténation de segments adjacents : gère le cas où
 *    le camelCase découpe un mot sensible (ex: "passWord" → "pass"+"word" = "password" ✓)
 */
function isSensitiveField(fieldName: string, sensitiveFields: string[]): boolean {
  const fieldSegments = splitIntoSegments(fieldName);

  return sensitiveFields.some((sensitive) => {
    const sensitiveSegments = splitIntoSegments(sensitive);
    if (sensitiveSegments.length === 0) return false;
    if (sensitiveSegments.length > fieldSegments.length) return false;

    // Passe 1 — matching par segments exacts
    for (let i = 0; i <= fieldSegments.length - sensitiveSegments.length; i++) {
      let match = true;
      for (let j = 0; j < sensitiveSegments.length; j++) {
        if (fieldSegments[i + j] !== sensitiveSegments[j]) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }

    // Passe 2 — matching par concaténation de segments adjacents
    // Gère "passWord" (segments ["pass","word"]) vs "password" (segment ["password"])
    const sensitiveJoined = sensitiveSegments.join('');
    for (let i = 0; i < fieldSegments.length; i++) {
      let concat = '';
      for (let j = i; j < fieldSegments.length; j++) {
        concat += fieldSegments[j];
        if (concat === sensitiveJoined) return true;
        // Arrêter tôt si la concaténation dépasse déjà le mot sensible
        if (concat.length > sensitiveJoined.length) break;
      }
    }

    return false;
  });
}

/**
 * Crée une fonction de masquage précompilée pour une liste de champs donnée.
 * Plus efficace quand la même liste est utilisée plusieurs fois.
 */
export function createRedactor(sensitiveFields: string[]): (value: unknown) => unknown {
  return (value: unknown) => redact(value, sensitiveFields);
}
