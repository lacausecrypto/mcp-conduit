/**
 * Tests e2e pour l'authentification et le contrôle d'accès (ACL).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import {
  setup,
  teardown,
  sendMcpRequest,
  sendMcpRequestJson,
  makeToolCallMessage,
  makeToolsListMessage,
  type E2eTestContext,
} from './setup.js';
import { _setJwksFetcher, _clearJwksCache } from '../../src/auth/authenticator.js';
import type { AuthConfig, AclConfig } from '../../src/auth/types.js';

// ============================================================================
// Helpers
// ============================================================================

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function makeApiKeyConfig(keys: Array<{ key: string; client_id: string; tenant_id: string }>): AuthConfig {
  return { method: 'api-key', api_keys: keys };
}

const SIMPLE_ACL: AclConfig = {
  enabled: true,
  default_action: 'deny',
  policies: [
    {
      name: 'allowed-client',
      clients: ['allowed-client'],
      allow: [{ server: 'test-server', tools: ['get_contact', 'search_leads'] }],
    },
  ],
};

// ============================================================================
// Tests : Auth méthode "none" (passthrough)
// ============================================================================

describe('Auth méthode "none"', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ auth: { method: 'none' } });
  });

  afterAll(() => teardown(ctx));

  it('passe toutes les requêtes sans authentification', async () => {
    const res = await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '1' }));
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });
});

// ============================================================================
// Tests : Auth API Key
// ============================================================================

describe('Auth méthode "api-key"', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      auth: makeApiKeyConfig([
        { key: 'sk-valid-1', client_id: 'agent-1', tenant_id: 'tenant-a' },
      ]),
    });
  });

  afterAll(() => teardown(ctx));

  it('requête sans clé → erreur JSON-RPC -32000', async () => {
    const res = await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', {}));
    const body = await res.json() as JsonRpcResponse;
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toContain('Authentication failed');
  });

  it('requête avec clé valide → succès', async () => {
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
      { Authorization: 'Bearer sk-valid-1' },
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });

  it('requête avec clé invalide → erreur', async () => {
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', {}),
      { Authorization: 'Bearer sk-wrong' },
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error?.code).toBe(-32000);
  });
});

// ============================================================================
// Tests : ACL
// ============================================================================

describe('ACL avec API Key', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      auth: makeApiKeyConfig([
        { key: 'sk-allowed', client_id: 'allowed-client', tenant_id: 'tenant-a' },
        { key: 'sk-denied', client_id: 'denied-client', tenant_id: 'tenant-b' },
      ]),
      acl: SIMPLE_ACL,
    });
  });

  afterAll(() => teardown(ctx));

  it('client autorisé + outil autorisé → succès', async () => {
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
      { Authorization: 'Bearer sk-allowed' },
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });

  it('client autorisé + outil refusé → erreur "Access denied"', async () => {
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('delete_contact', { id: '1' }),
      { Authorization: 'Bearer sk-allowed' },
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toContain('Access denied');
  });

  it('client non couvert par ACL + default deny → accès refusé', async () => {
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', {}),
      { Authorization: 'Bearer sk-denied' },
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toContain('Access denied');
  });

  it('tools/list retourne uniquement les outils autorisés', async () => {
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolsListMessage(),
      { Authorization: 'Bearer sk-allowed' },
    );
    const body = await res.json() as { result?: { tools: Array<{ name: string }> } };
    const tools = body.result?.tools ?? [];
    const names = tools.map((t) => t.name);

    expect(names).toContain('get_contact');
    expect(names).toContain('search_leads');
    expect(names).not.toContain('delete_contact');
    expect(names).not.toContain('create_contact');
  });

  it('différents clients voient différentes listes d\'outils', async () => {
    // Client autorisé voit 2 outils
    const res1 = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolsListMessage(),
      { Authorization: 'Bearer sk-allowed' },
    );
    const body1 = await res1.json() as { result?: { tools: unknown[] } };
    const tools1 = body1.result?.tools ?? [];

    // Client refusé voit 0 outils
    const res2 = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolsListMessage(),
      { Authorization: 'Bearer sk-denied' },
    );
    const body2 = await res2.json() as { result?: { tools: unknown[] } };
    const tools2 = body2.result?.tools ?? [];

    expect(tools1.length).toBeGreaterThan(0);
    expect(tools2.length).toBe(0);
  });
});

// ============================================================================
// Tests : ACL désactivé
// ============================================================================

describe('ACL désactivé', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      auth: makeApiKeyConfig([{ key: 'sk-any', client_id: 'any-client', tenant_id: 'tenant-x' }]),
      acl: { enabled: false, default_action: 'deny', policies: [] },
    });
  });

  afterAll(() => teardown(ctx));

  it('toutes les requêtes passent avec ACL désactivé', async () => {
    const res = await sendMcpRequest(
      ctx.app,
      'test-server',
      makeToolCallMessage('delete_contact', { id: '1' }),
      { Authorization: 'Bearer sk-any' },
    );
    const body = await res.json() as JsonRpcResponse;
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });
});

// ============================================================================
// Tests : Admin endpoint /conduit/acl/check
// ============================================================================

describe('Admin ACL check endpoint', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ acl: SIMPLE_ACL });
  });

  afterAll(() => teardown(ctx));

  it('GET /conduit/acl/check — client autorisé', async () => {
    const res = await ctx.app.request(
      '/conduit/acl/check?client=allowed-client&server=test-server&tool=get_contact',
    );
    const body = await res.json() as { allowed: boolean };
    expect(body.allowed).toBe(true);
  });

  it('GET /conduit/acl/check — client refusé', async () => {
    const res = await ctx.app.request(
      '/conduit/acl/check?client=random-client&server=test-server&tool=get_contact',
    );
    const body = await res.json() as { allowed: boolean };
    expect(body.allowed).toBe(false);
  });

  it('GET /conduit/acl/check — paramètres manquants → 400', async () => {
    const res = await ctx.app.request('/conduit/acl/check?client=x');
    expect(res.status).toBe(400);
  });
});
