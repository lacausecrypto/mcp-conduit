/**
 * Tri récursif des clés d'objet pour garantir un ordre déterministe
 * lors de la sérialisation JSON. Essentiel pour la génération de clés
 * de cache cohérentes quel que soit l'ordre des arguments.
 */

export type SortableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SortableValue[]
  | { [key: string]: SortableValue };

/**
 * Trie récursivement toutes les clés d'un objet JSON.
 * - Les objets ont leurs clés triées alphabétiquement
 * - Les tableaux conservent leur ordre (l'ordre est sémantique)
 * - Les valeurs primitives sont retournées telles quelles
 */
export function deepSort(value: SortableValue): SortableValue {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(deepSort);
  }

  if (typeof value === 'object') {
    const sorted: { [key: string]: SortableValue } = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      sorted[key] = deepSort((value as { [key: string]: SortableValue })[key]);
    }
    return sorted;
  }

  return value;
}

/**
 * Sérialise un objet en JSON avec les clés triées de façon déterministe.
 */
export function deterministicStringify(value: SortableValue): string {
  return JSON.stringify(deepSort(value));
}
