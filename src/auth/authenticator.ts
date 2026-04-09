/**
 * Module d'authentification pour MCP Conduit.
 *
 * Méthodes supportées :
 * - "none"    : pas d'authentification (mode développement)
 * - "api-key" : validation par clé API (Bearer ou X-API-Key)
 * - "jwt"     : validation JWT via JWKS avec la librairie jose
 */

import { timingSafeEqual } from 'node:crypto';
import { jwtVerify, createRemoteJWKSet, createLocalJWKSet, type JWTPayload } from 'jose';
import type { AuthConfig, AuthResult } from './types.js';

/** Type du getter JWKS (compatible createRemoteJWKSet et createLocalJWKSet) */
type JwksGetter = Parameters<typeof jwtVerify>[1];

/** Cache des getters JWKS par URL */
const jwksCache = new Map<string, JwksGetter>();

/** Fabrique de getter JWKS (remplaçable pour les tests) */
let jwksFetcher: (url: string) => JwksGetter = (url) =>
  createRemoteJWKSet(new URL(url));

/**
 * Remplace la fabrique de getter JWKS — usage test uniquement.
 * Permet d'injecter un createLocalJWKSet sans HTTP.
 */
export function _setJwksFetcher(fetcher: (url: string) => JwksGetter): void {
  jwksFetcher = fetcher;
  jwksCache.clear();
}

/** Vide le cache JWKS — usage test uniquement */
export function _clearJwksCache(): void {
  jwksCache.clear();
}

function getJwks(jwksUrl: string): JwksGetter {
  const cached = jwksCache.get(jwksUrl);
  if (cached !== undefined) return cached;
  const jwks = jwksFetcher(jwksUrl);
  jwksCache.set(jwksUrl, jwks);
  return jwks;
}

/**
 * Authentifie une requête à partir de ses en-têtes HTTP.
 */
export async function authenticate(
  headers: Record<string, string>,
  config: AuthConfig,
): Promise<AuthResult> {
  switch (config.method) {
    case 'none':
      return { authenticated: true, client_id: 'anonymous', tenant_id: 'default' };

    case 'api-key':
      return authenticateApiKey(headers, config);

    case 'jwt':
      return authenticateJwt(headers, config);

    default: {
      const _exhaustive: never = config.method;
      return {
        authenticated: false,
        client_id: '',
        tenant_id: '',
        error: `Méthode d'authentification inconnue : ${String(_exhaustive)}`,
      };
    }
  }
}

function authenticateApiKey(
  headers: Record<string, string>,
  config: AuthConfig,
): AuthResult {
  // Essai Authorization: Bearer <key>
  const authHeader = headers['authorization'] ?? headers['Authorization'];
  let key: string | undefined;

  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    key = authHeader.slice(7);
  }

  // Essai X-API-Key
  if (key === undefined) {
    key = headers['x-api-key'] ?? headers['X-API-Key'];
  }

  if (key === undefined || key === '') {
    return { authenticated: false, client_id: '', tenant_id: '', error: 'Clé API manquante' };
  }

  // Constant-time comparison: iterate ALL keys to prevent timing side-channel
  // (early-exit find() would reveal which position in the list matched)
  let matchedEntry: { key: string; client_id: string; tenant_id: string } | undefined = undefined;
  const keyBuf = Buffer.from(key);
  for (const k of config.api_keys ?? []) {
    try {
      const candidateBuf = Buffer.from(k.key);
      if (candidateBuf.length === keyBuf.length && timingSafeEqual(candidateBuf, keyBuf)) {
        matchedEntry = k;
      }
    } catch {
      // continue checking all keys
    }
  }
  if (!matchedEntry) {
    return { authenticated: false, client_id: '', tenant_id: '', error: 'Clé API invalide' };
  }
  const entry = matchedEntry;

  return {
    authenticated: true,
    client_id: entry.client_id,
    tenant_id: entry.tenant_id,
  };
}

async function authenticateJwt(
  headers: Record<string, string>,
  config: AuthConfig,
): Promise<AuthResult> {
  const authHeader = headers['authorization'] ?? headers['Authorization'];

  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return { authenticated: false, client_id: '', tenant_id: '', error: 'Token Bearer manquant' };
  }

  const token = authHeader.slice(7);

  if (!config.jwks_url) {
    return { authenticated: false, client_id: '', tenant_id: '', error: 'JWKS URL non configurée' };
  }

  try {
    const jwks = getJwks(config.jwks_url);

    const verifyOptions: {
      issuer?: string;
      audience?: string | string[];
      clockTolerance?: number;
    } = {
      // Allow 60 seconds of clock skew between issuer and gateway
      clockTolerance: 60,
    };
    if (config.issuer !== undefined) verifyOptions.issuer = config.issuer;
    if (config.audience !== undefined) verifyOptions.audience = config.audience;

    const { payload } = await jwtVerify(token, jwks, verifyOptions);
    const jwtPayload = payload as JWTPayload & Record<string, unknown>;

    const clientClaim = config.client_claim ?? 'sub';
    const tenantClaim = config.tenant_claim ?? 'org_id';

    const clientIdRaw = jwtPayload[clientClaim];
    const tenantIdRaw = jwtPayload[tenantClaim];

    const client_id = clientIdRaw !== undefined ? String(clientIdRaw) : '';
    const tenant_id = tenantIdRaw !== undefined ? String(tenantIdRaw) : 'default';

    if (!client_id) {
      return {
        authenticated: false,
        client_id: '',
        tenant_id: '',
        error: `Claim manquant : ${clientClaim}`,
      };
    }

    return {
      authenticated: true,
      client_id,
      tenant_id,
      claims: jwtPayload as Record<string, unknown>,
    };
  } catch (error) {
    return {
      authenticated: false,
      client_id: '',
      tenant_id: '',
      error: error instanceof Error ? error.message : 'Validation JWT échouée',
    };
  }
}

/** Réexport pour usage dans les tests */
export { createLocalJWKSet };
