/**
 * Génération et propagation des identifiants de trace.
 *
 * Supporte deux formats :
 * - Custom : X-Conduit-Trace-Id (UUID v4) — rétrocompatible
 * - W3C   : traceparent header (version-traceId-parentId-flags)
 *
 * Priorité de résolution : traceparent > X-Conduit-Trace-Id > génération
 */

import { randomUUID, randomBytes } from 'node:crypto';

/** Nom de l'en-tête de trace Conduit (custom) */
export const TRACE_HEADER = 'X-Conduit-Trace-Id';

/** Nom de l'en-tête W3C Trace Context */
export const W3C_TRACEPARENT_HEADER = 'traceparent';
export const W3C_TRACESTATE_HEADER = 'tracestate';

/** Regex pour valider le format traceparent */
const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Résultat du parsing d'un traceparent */
export interface TraceparentInfo {
  version: string;
  traceId: string;
  parentId: string;
  flags: string;
}

/**
 * Génère un nouvel identifiant de trace UUID v4.
 */
export function generateTraceId(): string {
  return randomUUID();
}

/**
 * Génère un span ID aléatoire de 16 caractères hex.
 */
export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Parse un header traceparent W3C.
 * Format : {version}-{trace-id}-{parent-id}-{trace-flags}
 * Retourne null si invalide.
 */
export function parseTraceparent(header: string): TraceparentInfo | null {
  const match = TRACEPARENT_REGEX.exec(header.trim());
  if (!match) return null;
  return {
    version: match[1]!,
    traceId: match[2]!,
    parentId: match[3]!,
    flags: match[4]!,
  };
}

/**
 * Formate un header traceparent W3C.
 */
export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  // Convertir UUID (avec tirets) en hex 32 chars si nécessaire
  const hexTraceId = traceId.replace(/-/g, '').padStart(32, '0').slice(0, 32);
  const flags = sampled ? '01' : '00';
  return `00-${hexTraceId}-${spanId}-${flags}`;
}

/**
 * Extrait ou génère un identifiant de trace depuis les en-têtes HTTP.
 * Priorité : traceparent W3C > X-Conduit-Trace-Id > génération
 */
export function resolveTraceId(headers: Record<string, string | string[] | undefined>): string {
  // 1. Check W3C traceparent
  const traceparent = headers[W3C_TRACEPARENT_HEADER];
  if (typeof traceparent === 'string') {
    const parsed = parseTraceparent(traceparent);
    if (parsed) {
      // Retourner le trace ID W3C (32 hex chars) formaté en UUID-like
      const t = parsed.traceId;
      return `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20)}`;
    }
  }

  // 2. Check custom Conduit header
  const headerValue = headers[TRACE_HEADER.toLowerCase()];

  if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
    return headerValue.trim();
  }

  if (Array.isArray(headerValue) && headerValue.length > 0 && headerValue[0] !== undefined) {
    const first = headerValue[0];
    if (first.trim().length > 0) {
      return first.trim();
    }
  }

  return generateTraceId();
}

/**
 * Construit les en-têtes de trace à injecter dans les requêtes en amont
 * et dans les réponses au client. Émet les deux formats.
 */
export function buildTraceHeaders(traceId: string): Record<string, string> {
  const spanId = generateSpanId();
  return {
    [TRACE_HEADER]: traceId,
    [W3C_TRACEPARENT_HEADER]: formatTraceparent(traceId, spanId),
  };
}
