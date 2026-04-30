import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { hardenSqliteFilePermissions } from '../utils/db-hardening.js';
import type {
  ConnectedAccountFilters,
  ConnectedAccountSummary,
  CreateConnectedAccountInput,
  ResolveConnectedAccountQuery,
  ResolvedConnectedAccount,
} from './types.js';

const CREATE_IDENTITY_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS identity_secrets (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connected_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  client_id TEXT,
  tenant_id TEXT,
  label TEXT,
  auth_type TEXT NOT NULL,
  token_type TEXT NOT NULL,
  access_token_secret_id TEXT NOT NULL,
  refresh_token_secret_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY(access_token_secret_id) REFERENCES identity_secrets(id),
  FOREIGN KEY(refresh_token_secret_id) REFERENCES identity_secrets(id)
);

CREATE INDEX IF NOT EXISTS idx_connected_accounts_lookup
  ON connected_accounts(workspace_id, provider, client_id, tenant_id, revoked_at);
`;

interface ConnectedAccountRow {
  id: string;
  workspace_id: string;
  provider: string;
  client_id: string | null;
  tenant_id: string | null;
  label: string | null;
  auth_type: string;
  token_type: string;
  access_token_secret_id: string;
  refresh_token_secret_id: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

interface SecretRow {
  value: string;
}

export class IdentityStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(CREATE_IDENTITY_TABLES_SQL);
    hardenSqliteFilePermissions(dbPath);
  }

  ping(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  listConnectedAccounts(filters: ConnectedAccountFilters = {}): ConnectedAccountSummary[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (!filters.include_revoked) {
      conditions.push('revoked_at IS NULL');
    }
    if (filters.workspace_id) {
      conditions.push('workspace_id = @workspace_id');
      params['workspace_id'] = filters.workspace_id;
    }
    if (filters.provider) {
      conditions.push('provider = @provider');
      params['provider'] = filters.provider;
    }
    if (filters.client_id) {
      conditions.push('client_id = @client_id');
      params['client_id'] = filters.client_id;
    }
    if (filters.tenant_id) {
      conditions.push('tenant_id = @tenant_id');
      params['tenant_id'] = filters.tenant_id;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM connected_accounts
      ${where}
      ORDER BY created_at DESC
    `).all(params) as ConnectedAccountRow[];

    return rows.map((row) => toSummary(row));
  }

  getConnectedAccount(id: string): ConnectedAccountSummary | null {
    const row = this.db.prepare(
      'SELECT * FROM connected_accounts WHERE id = ?',
    ).get(id) as ConnectedAccountRow | undefined;
    return row ? toSummary(row) : null;
  }

  createConnectedAccount(input: CreateConnectedAccountInput): ConnectedAccountSummary {
    const now = new Date().toISOString();
    const accountId = randomUUID();
    const accessTokenSecretId = randomUUID();
    const refreshTokenSecretId = input.refresh_token ? randomUUID() : null;

    const workspaceId = input.workspace_id.trim();
    const provider = input.provider.trim();
    const clientId = input.client_id?.trim() || null;
    const tenantId = input.tenant_id?.trim() || null;

    if (!workspaceId) {
      throw new Error('workspace_id is required');
    }
    if (!provider) {
      throw new Error('provider is required');
    }
    if (!input.access_token) {
      throw new Error('access_token is required');
    }

    const tx = this.db.transaction(() => {
      if (input.replace_existing) {
        this.db.prepare(`
          UPDATE connected_accounts
          SET revoked_at = @now, updated_at = @now
          WHERE workspace_id = @workspace_id
            AND provider = @provider
            AND COALESCE(client_id, '') = COALESCE(@client_id, '')
            AND COALESCE(tenant_id, '') = COALESCE(@tenant_id, '')
            AND revoked_at IS NULL
        `).run({
          now,
          workspace_id: workspaceId,
          provider,
          client_id: clientId,
          tenant_id: tenantId,
        });
      }

      this.db.prepare(`
        INSERT INTO identity_secrets (id, value, created_at, updated_at)
        VALUES (@id, @value, @created_at, @updated_at)
      `).run({
        id: accessTokenSecretId,
        value: input.access_token,
        created_at: now,
        updated_at: now,
      });

      if (refreshTokenSecretId && input.refresh_token) {
        this.db.prepare(`
          INSERT INTO identity_secrets (id, value, created_at, updated_at)
          VALUES (@id, @value, @created_at, @updated_at)
        `).run({
          id: refreshTokenSecretId,
          value: input.refresh_token,
          created_at: now,
          updated_at: now,
        });
      }

      this.db.prepare(`
        INSERT INTO connected_accounts (
          id, workspace_id, provider, client_id, tenant_id, label,
          auth_type, token_type, access_token_secret_id, refresh_token_secret_id,
          metadata, created_at, updated_at, revoked_at
        ) VALUES (
          @id, @workspace_id, @provider, @client_id, @tenant_id, @label,
          'bearer', @token_type, @access_token_secret_id, @refresh_token_secret_id,
          @metadata, @created_at, @updated_at, NULL
        )
      `).run({
        id: accountId,
        workspace_id: workspaceId,
        provider,
        client_id: clientId,
        tenant_id: tenantId,
        label: input.label?.trim() || null,
        token_type: input.token_type?.trim() || 'Bearer',
        access_token_secret_id: accessTokenSecretId,
        refresh_token_secret_id: refreshTokenSecretId,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        created_at: now,
        updated_at: now,
      });
    });

    tx();

    const created = this.getConnectedAccount(accountId);
    if (!created) {
      throw new Error(`Failed to create connected account "${accountId}"`);
    }
    return created;
  }

  revokeConnectedAccount(id: string): ConnectedAccountSummary | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE connected_accounts
      SET revoked_at = @now, updated_at = @now
      WHERE id = @id AND revoked_at IS NULL
    `).run({ id, now });

    if (result.changes === 0) {
      return this.getConnectedAccount(id);
    }

    return this.getConnectedAccount(id);
  }

  resolveConnectedAccount(query: ResolveConnectedAccountQuery): ResolvedConnectedAccount | null {
    const row = this.resolveAccountRow(query);
    if (!row) return null;

    const accessToken = this.readSecret(row.access_token_secret_id);
    if (accessToken === null) {
      throw new Error(`Missing access token secret for account "${row.id}"`);
    }

    const refreshToken = row.refresh_token_secret_id
      ? this.readSecret(row.refresh_token_secret_id) ?? undefined
      : undefined;

    return {
      ...toSummary(row),
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  private resolveAccountRow(query: ResolveConnectedAccountQuery): ConnectedAccountRow | null {
    switch (query.binding) {
      case 'client':
        return this.findOne(query.workspace_id, query.provider, query.client_id, null);
      case 'tenant':
        return this.findOne(query.workspace_id, query.provider, null, query.tenant_id);
      case 'workspace':
        return this.findOne(query.workspace_id, query.provider, null, null);
      case 'client-or-workspace':
        return this.findOne(query.workspace_id, query.provider, query.client_id, null)
          ?? this.findOne(query.workspace_id, query.provider, null, null);
    }
  }

  private findOne(
    workspaceId: string,
    provider: string,
    clientId: string | null,
    tenantId: string | null,
  ): ConnectedAccountRow | null {
    // Explicit NULL discrimination — the previous COALESCE(x, '') = COALESCE(@x, '')
    // formulation conflated "stored as NULL" with "stored as empty string".
    // If both rows ever co-existed (workspace + provider, client_id NULL on
    // one and '' on the other), the COALESCE form would return whichever
    // updated_at was newer regardless of which one the caller meant. The
    // SQL below treats NULL and '' as distinct values, matching only on
    // exact identity. (battle-test #4)
    const row = this.db.prepare(`
      SELECT * FROM connected_accounts
      WHERE workspace_id = @workspace_id
        AND provider = @provider
        AND (
          (@client_id IS NULL AND client_id IS NULL)
          OR client_id = @client_id
        )
        AND (
          (@tenant_id IS NULL AND tenant_id IS NULL)
          OR tenant_id = @tenant_id
        )
        AND revoked_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `).get({
      workspace_id: workspaceId,
      provider,
      client_id: clientId,
      tenant_id: tenantId,
    }) as ConnectedAccountRow | undefined;

    return row ?? null;
  }

  private readSecret(secretId: string): string | null {
    const row = this.db.prepare(
      'SELECT value FROM identity_secrets WHERE id = ?',
    ).get(secretId) as SecretRow | undefined;
    return row?.value ?? null;
  }
}

function toSummary(row: ConnectedAccountRow): ConnectedAccountSummary {
  const metadata = parseMetadata(row.metadata);
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    provider: row.provider,
    ...(row.client_id ? { client_id: row.client_id } : {}),
    ...(row.tenant_id ? { tenant_id: row.tenant_id } : {}),
    ...(row.label ? { label: row.label } : {}),
    auth_type: row.auth_type === 'bearer' ? 'bearer' : 'bearer',
    token_type: row.token_type,
    access_token_ref: { backend: 'sqlite', secret_id: row.access_token_secret_id },
    ...(row.refresh_token_secret_id
      ? { refresh_token_ref: { backend: 'sqlite' as const, secret_id: row.refresh_token_secret_id } }
      : {}),
    ...(metadata ? { metadata } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.revoked_at ? { revoked_at: row.revoked_at } : {}),
  };
}

function parseMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed metadata from older rows
  }
  return undefined;
}

