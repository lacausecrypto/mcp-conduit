/**
 * Génération de clés de cache déterministes par hachage SHA-256.
 * La clé incorpore : serveur, outil, arguments (triés), et tenant.
 */

import { createHash } from 'node:crypto';
import { deterministicStringify, type SortableValue } from '../utils/deep-sort.js';

/** Composants d'une clé de cache avant hachage */
interface CacheKeyComponents {
  server_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  tenant_id?: string;
  group_id?: string;
}

/** Options pour la génération de clé de cache */
export interface CacheKeyOptions {
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Identifiant logique du tenant utilisé pour segmenter le cache */
  tenantId?: string;
  /** Identifiant du groupe de session (X-Conduit-Group) */
  groupId?: string;
  /** Liste des noms d'arguments à exclure de la clé (champs non-déterministes) */
  ignoreArgs?: string[];
}

/**
 * Génère une clé de cache SHA-256 déterministe.
 *
 * Algorithme :
 * 1. Filtre les arguments ignorés (ex. request_id, timestamp)
 * 2. Trie récursivement les clés de l'objet d'arguments
 * 3. Construit un objet canonique {server_id, tool_name, args, tenant_id?, group_id?}
 * 4. Hache cet objet en SHA-256 hexadécimal
 */
export function generateCacheKey(options: CacheKeyOptions): string {
  const { serverId, toolName, args, tenantId, groupId, ignoreArgs = [] } = options;

  const filteredArgs = filterArgs(args, ignoreArgs);

  const components: CacheKeyComponents = {
    server_id: serverId,
    tool_name: toolName,
    args: filteredArgs,
  };

  if (tenantId !== undefined) {
    components.tenant_id = tenantId;
  }

  if (groupId !== undefined) {
    components.group_id = groupId;
  }

  const canonical = deterministicStringify(components as unknown as Record<string, SortableValue>);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Filtre les arguments à exclure de la clé de cache.
 *
 * Normalisation supplémentaire (battle-test #2) : tout argument à valeur
 * `undefined` est explicitement supprimé. Sans ce filtre, deux requêtes
 * distinctes sémantiquement — `{a:1, b:undefined}` et `{a:1}` — produisent
 * la même clé SHA-256 parce que JSON.stringify omet undefined. En les
 * éliminant ici, le comportement « cache traite undefined comme absent »
 * est rendu explicite et impossible à confondre avec une non-normalisation.
 *
 * Les valeurs `null` sont préservées telles quelles : elles sont
 * sémantiquement distinctes de "absent" et donnent une clé différente.
 */
function filterArgs(
  args: Record<string, unknown>,
  ignoreArgs: string[],
): Record<string, unknown> {
  const ignoreSet = ignoreArgs.length > 0 ? new Set(ignoreArgs) : null;
  const filtered: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (ignoreSet !== null && ignoreSet.has(key)) continue;
    if (value === undefined) continue;
    filtered[key] = value;
  }

  return filtered;
}

/**
 * Extrait l'identifiant tenant depuis un en-tête HTTP.
 * Supporte les JWT Bearer et les valeurs directes.
 *
 * Important: un Bearer non-JWT ne doit pas être utilisé tel quel comme
 * identifiant de tenant, sinon la clé API elle-même finit dans la clé de cache.
 */
export function extractTenantId(headerValue: string | undefined): string | undefined {
  if (!headerValue) {
    return undefined;
  }

  const bearerMatch = /^Bearer\s+(.+)$/i.exec(headerValue);
  if (bearerMatch) {
    const token = bearerMatch[1];
    if (token) {
      return extractJwtClaim(token) ?? hashOpaqueBearerToken(token);
    }
  }

  return headerValue;
}

/**
 * Décode le payload d'un JWT pour en extraire le claim tenant.
 */
function extractJwtClaim(token: string): string | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return undefined;
    }

    const payloadPart = parts[1];
    if (!payloadPart) {
      return undefined;
    }

    const padded = payloadPart.padEnd(
      payloadPart.length + ((4 - (payloadPart.length % 4)) % 4),
      '=',
    );
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<string, unknown>;

    if (typeof payload['tenant_id'] === 'string') {
      return payload['tenant_id'];
    }
    if (typeof payload['sub'] === 'string') {
      return payload['sub'];
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function hashOpaqueBearerToken(token: string): string {
  return `bearer:${createHash('sha256').update(token).digest('hex')}`;
}
