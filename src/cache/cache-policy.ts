/**
 * Politique de décision de mise en cache basée sur les annotations d'outils MCP
 * et les surcharges de configuration.
 */

import type { ToolAnnotations } from './types.js';
import type { ServerCacheConfig, ToolOverrideConfig } from '../config/types.js';

/** TTL par défaut selon le type d'annotation (en secondes) */
const DEFAULT_TTL_BY_ANNOTATION = {
  readOnly: 5 * 60,    // 5 minutes pour les outils en lecture seule
  idempotent: 2 * 60,  // 2 minutes pour les outils idempotents
  openWorld: 30,        // 30 secondes pour les outils à monde ouvert
} as const;

/** Résultat de la décision de politique de cache */
export interface CachePolicyDecision {
  /** Faut-il mettre en cache le résultat ? */
  shouldCache: boolean;
  /** Durée de vie en secondes (undefined si shouldCache est false) */
  ttl?: number;
  /** L'outil est-il destructeur (invalider le cache associé) ? */
  isDestructive: boolean;
  /** Liste des outils dont le cache doit être invalidé */
  invalidates: string[];
  /** Arguments à exclure de la clé de cache */
  ignoreArgs: string[];
}

/**
 * Détermine la politique de cache pour un appel d'outil donné.
 *
 * Cascade de décision (ordre de priorité) :
 * 1. Surcharge explicite dans la configuration → respecter la config
 * 2. Annotation destructiveHint: true → NE PAS mettre en cache + invalider
 * 3. Annotation readOnlyHint: true → mettre en cache avec TTL par défaut (5min)
 * 4. Annotation idempotentHint: true → mettre en cache avec TTL court (2min)
 * 5. Annotation openWorldHint: true → mettre en cache très court (30sec)
 * 6. Aucune annotation → NE PAS mettre en cache (comportement conservateur)
 */
export function decideCachePolicy(
  toolName: string,
  annotations: ToolAnnotations,
  serverCacheConfig: ServerCacheConfig,
): CachePolicyDecision {
  const override = serverCacheConfig.overrides?.[toolName];

  if (override !== undefined) {
    return applyConfigOverride(override, serverCacheConfig.default_ttl);
  }

  if (annotations.destructiveHint === true) {
    return {
      shouldCache: false,
      isDestructive: true,
      invalidates: [],
      ignoreArgs: [],
    };
  }

  if (annotations.readOnlyHint === true) {
    return {
      shouldCache: true,
      ttl: serverCacheConfig.default_ttl > 0
        ? serverCacheConfig.default_ttl
        : DEFAULT_TTL_BY_ANNOTATION.readOnly,
      isDestructive: false,
      invalidates: [],
      ignoreArgs: [],
    };
  }

  if (annotations.idempotentHint === true) {
    return {
      shouldCache: true,
      ttl: Math.min(
        serverCacheConfig.default_ttl > 0
          ? serverCacheConfig.default_ttl
          : DEFAULT_TTL_BY_ANNOTATION.idempotent,
        DEFAULT_TTL_BY_ANNOTATION.idempotent,
      ),
      isDestructive: false,
      invalidates: [],
      ignoreArgs: [],
    };
  }

  if (annotations.openWorldHint === true) {
    return {
      shouldCache: true,
      ttl: DEFAULT_TTL_BY_ANNOTATION.openWorld,
      isDestructive: false,
      invalidates: [],
      ignoreArgs: [],
    };
  }

  return {
    shouldCache: false,
    isDestructive: false,
    invalidates: [],
    ignoreArgs: [],
  };
}

/**
 * Applique une surcharge de configuration explicite.
 * TTL = 0 signifie "ne pas mettre en cache".
 */
function applyConfigOverride(
  override: ToolOverrideConfig,
  serverDefaultTtl: number,
): CachePolicyDecision {
  const ttl = override.ttl ?? serverDefaultTtl;
  const shouldCache = ttl > 0;
  const invalidates = override.invalidates ?? [];
  const ignoreArgs = override.ignore_args ?? [];

  if (shouldCache) {
    return {
      shouldCache: true,
      ttl,
      isDestructive: false,
      invalidates,
      ignoreArgs,
    };
  }
  return {
    shouldCache: false,
    isDestructive: invalidates.length > 0,
    invalidates,
    ignoreArgs,
  };
}

/** Retourne les TTL par défaut pour inspection/test. */
export function getDefaultTtls(): typeof DEFAULT_TTL_BY_ANNOTATION {
  return DEFAULT_TTL_BY_ANNOTATION;
}
