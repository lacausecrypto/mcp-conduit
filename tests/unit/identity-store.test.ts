import { describe, expect, it } from 'vitest';
import { IdentityStore } from '../../src/identity/store.js';

describe('IdentityStore', () => {
  it('creates, lists, resolves, and revokes connected accounts', () => {
    const store = new IdentityStore(':memory:');

    const created = store.createConnectedAccount({
      workspace_id: 'engineering',
      provider: 'github',
      client_id: 'user-123',
      label: 'GitHub user token',
      access_token: 'gho_test_token',
      replace_existing: true,
    });

    expect(created.workspace_id).toBe('engineering');
    expect(created.provider).toBe('github');
    expect(created.client_id).toBe('user-123');
    expect(created.access_token_ref.secret_id).toBeTruthy();

    const listed = store.listConnectedAccounts();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const resolved = store.resolveConnectedAccount({
      workspace_id: 'engineering',
      provider: 'github',
      client_id: 'user-123',
      tenant_id: 'tenant-a',
      binding: 'client',
    });

    expect(resolved?.access_token).toBe('gho_test_token');
    expect(resolved?.token_type).toBe('Bearer');

    const revoked = store.revokeConnectedAccount(created.id);
    expect(revoked?.revoked_at).toBeTruthy();
    expect(store.listConnectedAccounts()).toHaveLength(0);
  });

  it('supports workspace-level shared accounts with client fallback', () => {
    const store = new IdentityStore(':memory:');

    store.createConnectedAccount({
      workspace_id: 'shared',
      provider: 'vercel',
      label: 'Shared Vercel token',
      access_token: 'vercel_shared_token',
    });

    const resolved = store.resolveConnectedAccount({
      workspace_id: 'shared',
      provider: 'vercel',
      client_id: 'user-999',
      tenant_id: 'tenant-shared',
      binding: 'client-or-workspace',
    });

    expect(resolved?.access_token).toBe('vercel_shared_token');
    expect(resolved?.client_id).toBeUndefined();
  });
});

// ─── Audit 3.1#4 — extensions ─────────────────────────────────────────────────

describe('IdentityStore — replace_existing semantics', () => {
  it('revokes the previous account when replace_existing=true and matching key (workspace+provider+client_id+tenant_id)', () => {
    const store = new IdentityStore(':memory:');
    const original = store.createConnectedAccount({
      workspace_id: 'eng',
      provider: 'github',
      client_id: 'user-1',
      access_token: 'old-token',
    });
    const replacement = store.createConnectedAccount({
      workspace_id: 'eng',
      provider: 'github',
      client_id: 'user-1',
      access_token: 'new-token',
      replace_existing: true,
    });

    expect(replacement.id).not.toBe(original.id);
    // Old account should now be revoked → not in active list.
    expect(store.listConnectedAccounts()).toHaveLength(1);
    expect(store.listConnectedAccounts()[0]?.id).toBe(replacement.id);
    // Old account is still retrievable via include_revoked.
    const all = store.listConnectedAccounts({ include_revoked: true });
    expect(all).toHaveLength(2);
    const oldEntry = all.find((a) => a.id === original.id);
    expect(oldEntry?.revoked_at).toBeTruthy();
  });

  it('allows multiple parallel accounts when replace_existing=false', () => {
    const store = new IdentityStore(':memory:');
    store.createConnectedAccount({
      workspace_id: 'eng',
      provider: 'github',
      client_id: 'user-1',
      access_token: 'token-A',
    });
    store.createConnectedAccount({
      workspace_id: 'eng',
      provider: 'github',
      client_id: 'user-1',
      access_token: 'token-B',
      // replace_existing not set
    });
    expect(store.listConnectedAccounts()).toHaveLength(2);
  });

  it('replace_existing only affects matching workspace+provider+client_id+tenant_id', () => {
    const store = new IdentityStore(':memory:');
    store.createConnectedAccount({
      workspace_id: 'eng',
      provider: 'github',
      client_id: 'user-A',
      access_token: 'token-A',
    });
    // Different client_id — should NOT touch the existing one.
    store.createConnectedAccount({
      workspace_id: 'eng',
      provider: 'github',
      client_id: 'user-B',
      access_token: 'token-B',
      replace_existing: true,
    });
    expect(store.listConnectedAccounts()).toHaveLength(2);
  });

  it('replace_existing matches NULL client_id (workspace-shared) correctly via COALESCE', () => {
    const store = new IdentityStore(':memory:');
    const first = store.createConnectedAccount({
      workspace_id: 'eng',
      provider: 'github',
      // no client_id → NULL in DB
      access_token: 'token-shared-1',
    });
    const second = store.createConnectedAccount({
      workspace_id: 'eng',
      provider: 'github',
      access_token: 'token-shared-2',
      replace_existing: true,
    });
    expect(store.listConnectedAccounts()).toHaveLength(1);
    expect(store.listConnectedAccounts()[0]?.id).toBe(second.id);
    expect(first.id).not.toBe(second.id);
  });
});

describe('IdentityStore — listConnectedAccounts filter combinations', () => {
  function seed(store: IdentityStore): void {
    store.createConnectedAccount({ workspace_id: 'a', provider: 'github', client_id: 'u1', tenant_id: 't1', access_token: 'x' });
    store.createConnectedAccount({ workspace_id: 'a', provider: 'gitlab', client_id: 'u1', tenant_id: 't1', access_token: 'x' });
    store.createConnectedAccount({ workspace_id: 'a', provider: 'github', client_id: 'u2', tenant_id: 't1', access_token: 'x' });
    store.createConnectedAccount({ workspace_id: 'b', provider: 'github', client_id: 'u1', tenant_id: 't1', access_token: 'x' });
    store.createConnectedAccount({ workspace_id: 'a', provider: 'github', client_id: 'u1', tenant_id: 't2', access_token: 'x' });
  }

  it('filters by workspace_id', () => {
    const store = new IdentityStore(':memory:');
    seed(store);
    expect(store.listConnectedAccounts({ workspace_id: 'a' })).toHaveLength(4);
    expect(store.listConnectedAccounts({ workspace_id: 'b' })).toHaveLength(1);
  });

  it('filters by provider', () => {
    const store = new IdentityStore(':memory:');
    seed(store);
    expect(store.listConnectedAccounts({ provider: 'github' })).toHaveLength(4);
    expect(store.listConnectedAccounts({ provider: 'gitlab' })).toHaveLength(1);
  });

  it('filters by client_id', () => {
    const store = new IdentityStore(':memory:');
    seed(store);
    expect(store.listConnectedAccounts({ client_id: 'u1' })).toHaveLength(4);
    expect(store.listConnectedAccounts({ client_id: 'u2' })).toHaveLength(1);
  });

  it('filters by tenant_id', () => {
    const store = new IdentityStore(':memory:');
    seed(store);
    expect(store.listConnectedAccounts({ tenant_id: 't1' })).toHaveLength(4);
    expect(store.listConnectedAccounts({ tenant_id: 't2' })).toHaveLength(1);
  });

  it('combines multiple filters (workspace + provider + tenant)', () => {
    const store = new IdentityStore(':memory:');
    seed(store);
    const matches = store.listConnectedAccounts({ workspace_id: 'a', provider: 'github', tenant_id: 't1' });
    expect(matches).toHaveLength(2);
    expect(matches.every((a) => a.workspace_id === 'a' && a.provider === 'github')).toBe(true);
  });

  it('include_revoked=true lists revoked accounts', () => {
    const store = new IdentityStore(':memory:');
    const created = store.createConnectedAccount({
      workspace_id: 'a', provider: 'github', client_id: 'u1', access_token: 'x',
    });
    store.revokeConnectedAccount(created.id);
    expect(store.listConnectedAccounts()).toHaveLength(0);
    expect(store.listConnectedAccounts({ include_revoked: true })).toHaveLength(1);
  });
});

describe('IdentityStore — resolve binding modes', () => {
  it('binding=client matches only the exact client_id', () => {
    const store = new IdentityStore(':memory:');
    store.createConnectedAccount({ workspace_id: 'a', provider: 'github', client_id: 'u1', access_token: 'token-u1' });
    store.createConnectedAccount({ workspace_id: 'a', provider: 'github', access_token: 'token-shared' });

    const resolved = store.resolveConnectedAccount({
      workspace_id: 'a', provider: 'github', client_id: 'u1', tenant_id: '', binding: 'client',
    });
    expect(resolved?.access_token).toBe('token-u1');

    const noMatch = store.resolveConnectedAccount({
      workspace_id: 'a', provider: 'github', client_id: 'unknown', tenant_id: '', binding: 'client',
    });
    expect(noMatch).toBeNull();
  });

  it('binding=tenant matches only by tenant_id', () => {
    const store = new IdentityStore(':memory:');
    store.createConnectedAccount({ workspace_id: 'a', provider: 'github', tenant_id: 't1', access_token: 'token-t1' });
    const r = store.resolveConnectedAccount({
      workspace_id: 'a', provider: 'github', client_id: 'any', tenant_id: 't1', binding: 'tenant',
    });
    expect(r?.access_token).toBe('token-t1');
  });

  it('binding=workspace matches workspace-shared (client_id and tenant_id null)', () => {
    const store = new IdentityStore(':memory:');
    store.createConnectedAccount({ workspace_id: 'a', provider: 'github', access_token: 'token-shared' });
    const r = store.resolveConnectedAccount({
      workspace_id: 'a', provider: 'github', client_id: 'u1', tenant_id: 't1', binding: 'workspace',
    });
    expect(r?.access_token).toBe('token-shared');
  });

  it('binding=client-or-workspace falls back to workspace shared when client-specific is missing', () => {
    const store = new IdentityStore(':memory:');
    store.createConnectedAccount({ workspace_id: 'a', provider: 'github', access_token: 'token-shared' });
    // No per-user account — fallback wins.
    const r = store.resolveConnectedAccount({
      workspace_id: 'a', provider: 'github', client_id: 'u-new', tenant_id: '', binding: 'client-or-workspace',
    });
    expect(r?.access_token).toBe('token-shared');
  });

  it('binding=client-or-workspace prefers per-client when both exist', () => {
    const store = new IdentityStore(':memory:');
    store.createConnectedAccount({ workspace_id: 'a', provider: 'github', access_token: 'token-shared' });
    store.createConnectedAccount({ workspace_id: 'a', provider: 'github', client_id: 'u-special', access_token: 'token-personal' });
    const r = store.resolveConnectedAccount({
      workspace_id: 'a', provider: 'github', client_id: 'u-special', tenant_id: '', binding: 'client-or-workspace',
    });
    expect(r?.access_token).toBe('token-personal');
  });

  it('does not resolve revoked accounts', () => {
    const store = new IdentityStore(':memory:');
    const created = store.createConnectedAccount({ workspace_id: 'a', provider: 'github', client_id: 'u1', access_token: 'x' });
    store.revokeConnectedAccount(created.id);
    const r = store.resolveConnectedAccount({
      workspace_id: 'a', provider: 'github', client_id: 'u1', tenant_id: '', binding: 'client',
    });
    expect(r).toBeNull();
  });

  it('returns the most-recently-updated account when several active rows exist (defensive: should not happen with replace_existing)', async () => {
    const store = new IdentityStore(':memory:');
    const first = store.createConnectedAccount({ workspace_id: 'a', provider: 'github', client_id: 'u1', access_token: 'token-old' });
    // Ensure updated_at differs by ≥1 ms — timestamps tie at ms resolution.
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Without replace_existing, both stay active.
    const second = store.createConnectedAccount({ workspace_id: 'a', provider: 'github', client_id: 'u1', access_token: 'token-new' });
    const r = store.resolveConnectedAccount({
      workspace_id: 'a', provider: 'github', client_id: 'u1', tenant_id: '', binding: 'client',
    });
    // ORDER BY updated_at DESC LIMIT 1 → second
    expect(r?.id).toBe(second.id);
    expect(r?.access_token).toBe('token-new');
    expect(first.id).not.toBe(second.id);
  });
});

describe('IdentityStore — input validation', () => {
  it('rejects empty workspace_id', () => {
    const store = new IdentityStore(':memory:');
    expect(() =>
      store.createConnectedAccount({ workspace_id: '', provider: 'github', access_token: 'x' }),
    ).toThrow(/workspace_id/);
  });

  it('rejects whitespace-only workspace_id', () => {
    const store = new IdentityStore(':memory:');
    expect(() =>
      store.createConnectedAccount({ workspace_id: '   ', provider: 'github', access_token: 'x' }),
    ).toThrow(/workspace_id/);
  });

  it('rejects empty provider', () => {
    const store = new IdentityStore(':memory:');
    expect(() =>
      store.createConnectedAccount({ workspace_id: 'a', provider: '', access_token: 'x' }),
    ).toThrow(/provider/);
  });

  it('rejects empty access_token', () => {
    const store = new IdentityStore(':memory:');
    expect(() =>
      store.createConnectedAccount({ workspace_id: 'a', provider: 'github', access_token: '' }),
    ).toThrow(/access_token/);
  });
});

describe('IdentityStore — refresh token + metadata', () => {
  it('persists refresh_token in identity_secrets and re-reads on resolve', () => {
    const store = new IdentityStore(':memory:');
    const created = store.createConnectedAccount({
      workspace_id: 'a',
      provider: 'github',
      client_id: 'u1',
      access_token: 'access-X',
      refresh_token: 'refresh-Y',
    });
    expect(created.refresh_token_ref).toBeDefined();
    expect(created.refresh_token_ref?.secret_id).toBeTruthy();
    const r = store.resolveConnectedAccount({
      workspace_id: 'a', provider: 'github', client_id: 'u1', tenant_id: '', binding: 'client',
    });
    expect(r?.refresh_token).toBe('refresh-Y');
  });

  it('persists metadata as JSON and reads it back', () => {
    const store = new IdentityStore(':memory:');
    const created = store.createConnectedAccount({
      workspace_id: 'a',
      provider: 'github',
      client_id: 'u1',
      access_token: 'x',
      metadata: { scope: 'repo,user', issued_via: 'oauth' },
    });
    expect(created.metadata).toEqual({ scope: 'repo,user', issued_via: 'oauth' });
  });

  it('uses Bearer as default token_type', () => {
    const store = new IdentityStore(':memory:');
    const created = store.createConnectedAccount({
      workspace_id: 'a', provider: 'github', client_id: 'u1', access_token: 'x',
    });
    expect(created.token_type).toBe('Bearer');
  });
});

describe('IdentityStore — db lifecycle', () => {
  it('ping returns true on live db', () => {
    const store = new IdentityStore(':memory:');
    expect(store.ping()).toBe(true);
  });

  it('getConnectedAccount returns null on unknown id', () => {
    const store = new IdentityStore(':memory:');
    expect(store.getConnectedAccount('does-not-exist')).toBeNull();
  });

  it('revoking an unknown id returns null and is idempotent', () => {
    const store = new IdentityStore(':memory:');
    expect(store.revokeConnectedAccount('does-not-exist')).toBeNull();
  });

  it('revoking an already-revoked account returns the (now-revoked) summary', () => {
    const store = new IdentityStore(':memory:');
    const created = store.createConnectedAccount({
      workspace_id: 'a', provider: 'github', client_id: 'u1', access_token: 'x',
    });
    store.revokeConnectedAccount(created.id);
    const second = store.revokeConnectedAccount(created.id);
    expect(second?.revoked_at).toBeTruthy();
  });
});

// ── Battle-test #5 — NULL/empty discrimination in findOne ────────────────────
//
// The public API normalizes empty-string client_id/tenant_id to NULL at write
// time, so the COALESCE conflation cannot be reached through the standard
// flow. To verify the SQL fix is sound (defense in depth: if a future migration
// or operator-level write inserts a row with client_id=''), we exercise both
// halves of the predicate directly:
//   1. The NULL path correctly distinguishes one NULL row from a non-NULL row
//   2. Two distinct client_ids resolve to distinct accounts
//
describe('IdentityStore — NULL discrimination in findOne (battle-test #5)', () => {
  it('a workspace-scope (NULL client_id) account is not conflated with a client-scoped one', () => {
    const store = new IdentityStore(':memory:');

    const wsAcct = store.createConnectedAccount({
      workspace_id: 'ws1', provider: 'github', access_token: 'token-ws',
    });
    expect(wsAcct.client_id ?? null).toBeNull();

    const userAcct = store.createConnectedAccount({
      workspace_id: 'ws1', provider: 'github', client_id: 'user-1', access_token: 'token-user',
    });

    // Workspace binding (no client_id) → must hit the NULL row, NOT the user row.
    const ws = store.resolveConnectedAccount({
      workspace_id: 'ws1', provider: 'github', binding: 'workspace',
    });
    expect(ws?.id).toBe(wsAcct.id);

    // Client binding → must hit the user row.
    const user = store.resolveConnectedAccount({
      workspace_id: 'ws1', provider: 'github', client_id: 'user-1', binding: 'client',
    });
    expect(user?.id).toBe(userAcct.id);
  });

  it('two accounts with NULL tenant_id but different client_ids stay distinct', () => {
    const store = new IdentityStore(':memory:');
    const a = store.createConnectedAccount({
      workspace_id: 'ws1', provider: 'github', client_id: 'alice', access_token: 'token-a',
    });
    const b = store.createConnectedAccount({
      workspace_id: 'ws1', provider: 'github', client_id: 'bob', access_token: 'token-b',
    });

    const resolvedA = store.resolveConnectedAccount({
      workspace_id: 'ws1', provider: 'github', client_id: 'alice', binding: 'client',
    });
    const resolvedB = store.resolveConnectedAccount({
      workspace_id: 'ws1', provider: 'github', client_id: 'bob', binding: 'client',
    });

    expect(resolvedA?.id).toBe(a.id);
    expect(resolvedB?.id).toBe(b.id);
    expect(resolvedA?.id).not.toBe(resolvedB?.id);
  });

  it('SQL fix: a stray empty-string row injected via direct DB write is no longer conflated with NULL', () => {
    // Reach into the underlying better-sqlite3 instance to simulate a row
    // that bypassed the createConnectedAccount normalization (a future
    // migration, an external admin tool, or a partial restore could do this).
    const store = new IdentityStore(':memory:');
    const wsAcct = store.createConnectedAccount({
      workspace_id: 'ws1', provider: 'github', access_token: 'token-ws',
    });

    const db = (store as unknown as { db: { prepare(sql: string): { run(p: Record<string, unknown>): unknown } } }).db;
    // Insert a placeholder secret first to satisfy the FK constraint, then
    // the rogue connected_accounts row with empty-string client_id/tenant_id.
    db.prepare(`
      INSERT INTO identity_secrets (id, value, created_at, updated_at)
      VALUES (@id, 'opaque', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run({ id: 'sec-fake' });
    db.prepare(`
      INSERT INTO connected_accounts (
        id, workspace_id, provider, client_id, tenant_id, label,
        auth_type, token_type, access_token_secret_id, refresh_token_secret_id, metadata,
        created_at, updated_at, revoked_at
      ) VALUES (
        @id, 'ws1', 'github', '', '', NULL,
        'bearer', 'bearer', 'sec-fake', NULL, NULL,
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL
      )
    `).run({ id: 'rogue-empty-row' });

    // Workspace binding → NULL client_id query — must STILL match wsAcct, NOT
    // the empty-string row. Pre-fix, COALESCE('', '') = COALESCE(NULL, '')
    // would conflate them and the order-by-updated_at could surface the wrong one.
    const ws = store.resolveConnectedAccount({
      workspace_id: 'ws1', provider: 'github', binding: 'workspace',
    });
    expect(ws?.id).toBe(wsAcct.id);
  });
});

