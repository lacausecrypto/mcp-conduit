/**
 * Tests unitaires pour le module d'authentification.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  authenticate,
  _setJwksFetcher,
  _clearJwksCache,
  createLocalJWKSet,
} from '../../src/auth/authenticator.js';
import type { AuthConfig } from '../../src/auth/types.js';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import http from 'node:http';

// ============================================================================
// Helpers JWT
// ============================================================================

async function setupJwtTest() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';

  const jwks = { keys: [publicJwk] };
  const jwksSet = createLocalJWKSet(jwks);

  _setJwksFetcher(() => jwksSet);

  async function signToken(claims: Record<string, unknown>, options?: { expiresIn?: string | number; issuer?: string; audience?: string; noExpiry?: boolean }) {
    let builder = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt();

    if (!options?.noExpiry) {
      builder = builder.setExpirationTime(options?.expiresIn ?? '1h');
    }
    if (options?.issuer) builder = builder.setIssuer(options.issuer);
    if (options?.audience) builder = builder.setAudience(options.audience);

    return builder.sign(privateKey);
  }

  return { signToken, jwks };
}

// ============================================================================
// Tests : méthode "none"
// ============================================================================

describe('authenticate — méthode "none"', () => {
  it('retourne toujours authentifié avec les valeurs par défaut', async () => {
    const config: AuthConfig = { method: 'none' };
    const result = await authenticate({}, config);

    expect(result.authenticated).toBe(true);
    expect(result.client_id).toBe('anonymous');
    expect(result.tenant_id).toBe('default');
  });

  it('ignore les en-têtes — toujours authentifié', async () => {
    const config: AuthConfig = { method: 'none' };
    const result = await authenticate({ authorization: 'Bearer invalid' }, config);

    expect(result.authenticated).toBe(true);
  });
});

// ============================================================================
// Tests : méthode "api-key"
// ============================================================================

describe('authenticate — méthode "api-key"', () => {
  const config: AuthConfig = {
    method: 'api-key',
    api_keys: [
      { key: 'sk-dev-123', client_id: 'agent-support-1', tenant_id: 'tenant-a' },
      { key: 'sk-dev-456', client_id: 'agent-admin', tenant_id: 'tenant-b' },
    ],
  };

  it('clé valide via Authorization: Bearer → authentifié', async () => {
    const result = await authenticate(
      { authorization: 'Bearer sk-dev-123' },
      config,
    );

    expect(result.authenticated).toBe(true);
    expect(result.client_id).toBe('agent-support-1');
    expect(result.tenant_id).toBe('tenant-a');
  });

  it('clé valide via X-API-Key → authentifié', async () => {
    const result = await authenticate(
      { 'x-api-key': 'sk-dev-456' },
      config,
    );

    expect(result.authenticated).toBe(true);
    expect(result.client_id).toBe('agent-admin');
    expect(result.tenant_id).toBe('tenant-b');
  });

  it('extrait correctement client_id et tenant_id', async () => {
    const result = await authenticate({ authorization: 'Bearer sk-dev-456' }, config);

    expect(result.client_id).toBe('agent-admin');
    expect(result.tenant_id).toBe('tenant-b');
  });

  it('clé invalide → refusé', async () => {
    const result = await authenticate({ authorization: 'Bearer invalid-key' }, config);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('en-tête manquant → refusé', async () => {
    const result = await authenticate({}, config);

    expect(result.authenticated).toBe(false);
    expect(result.error).toContain('manquante');
  });

  it('Authorization sans Bearer → refusé', async () => {
    const result = await authenticate({ authorization: 'Basic dXNlcjpwYXNz' }, config);

    expect(result.authenticated).toBe(false);
  });
});

// ============================================================================
// Tests : méthode "jwt"
// ============================================================================

describe('authenticate — méthode "jwt"', () => {
  let signToken: Awaited<ReturnType<typeof setupJwtTest>>['signToken'];

  beforeAll(async () => {
    const setup = await setupJwtTest();
    signToken = setup.signToken;
  });

  afterAll(() => {
    _clearJwksCache();
  });

  it('JWT valide → authentifié avec sub et org_id', async () => {
    const token = await signToken({ sub: 'agent-1', org_id: 'tenant-a' });
    const config: AuthConfig = {
      method: 'jwt',
      jwks_url: 'http://test.local/.well-known/jwks.json',
    };

    const result = await authenticate({ authorization: `Bearer ${token}` }, config);

    expect(result.authenticated).toBe(true);
    expect(result.client_id).toBe('agent-1');
    expect(result.tenant_id).toBe('tenant-a');
  });

  it('JWT expiré → refusé', async () => {
    // Expire 120 seconds ago — well beyond the 60-second clock-skew tolerance
    // added in production to handle minor NTP drift between issuer and gateway.
    const token = await signToken({ sub: 'agent-1' }, { expiresIn: Math.floor(Date.now() / 1000) - 120 });

    const config: AuthConfig = {
      method: 'jwt',
      jwks_url: 'http://test.local/.well-known/jwks.json',
    };

    const result = await authenticate({ authorization: `Bearer ${token}` }, config);

    expect(result.authenticated).toBe(false);
  });

  it('mauvais issuer → refusé', async () => {
    const token = await signToken(
      { sub: 'agent-1' },
      { issuer: 'https://wrong-issuer.com' },
    );

    const config: AuthConfig = {
      method: 'jwt',
      jwks_url: 'http://test.local/.well-known/jwks.json',
      issuer: 'https://expected-issuer.com',
    };

    const result = await authenticate({ authorization: `Bearer ${token}` }, config);

    expect(result.authenticated).toBe(false);
  });

  it('issuer correct → authentifié', async () => {
    const token = await signToken(
      { sub: 'agent-1', org_id: 'tenant-x' },
      { issuer: 'https://auth.test.com' },
    );

    const config: AuthConfig = {
      method: 'jwt',
      jwks_url: 'http://test.local/.well-known/jwks.json',
      issuer: 'https://auth.test.com',
    };

    const result = await authenticate({ authorization: `Bearer ${token}` }, config);

    expect(result.authenticated).toBe(true);
    expect(result.client_id).toBe('agent-1');
  });

  it('claim personnalisé pour client et tenant', async () => {
    const token = await signToken({ user_id: 'my-client', company: 'my-tenant' });

    const config: AuthConfig = {
      method: 'jwt',
      jwks_url: 'http://test.local/.well-known/jwks.json',
      client_claim: 'user_id',
      tenant_claim: 'company',
    };

    const result = await authenticate({ authorization: `Bearer ${token}` }, config);

    expect(result.authenticated).toBe(true);
    expect(result.client_id).toBe('my-client');
    expect(result.tenant_id).toBe('my-tenant');
  });

  it('en-tête Authorization manquant → refusé', async () => {
    const config: AuthConfig = {
      method: 'jwt',
      jwks_url: 'http://test.local/.well-known/jwks.json',
    };

    const result = await authenticate({}, config);

    expect(result.authenticated).toBe(false);
    expect(result.error).toContain('Bearer');
  });

  it('retourne les claims JWT complets', async () => {
    const token = await signToken({ sub: 'agent-2', org_id: 'org-z', role: 'admin' });

    const config: AuthConfig = {
      method: 'jwt',
      jwks_url: 'http://test.local/.well-known/jwks.json',
    };

    const result = await authenticate({ authorization: `Bearer ${token}` }, config);

    expect(result.authenticated).toBe(true);
    expect(result.claims?.['role']).toBe('admin');
    expect(result.claims?.['sub']).toBe('agent-2');
  });
});
