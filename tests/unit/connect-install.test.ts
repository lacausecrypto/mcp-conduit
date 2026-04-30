import { describe, expect, it } from 'vitest';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import {
  ConnectInstallSessionStore,
  parseConnectDeeplink,
} from '../../src/connect/install.js';

function makeConfig(overrides: Partial<ConduitGatewayConfig> = {}): ConduitGatewayConfig {
  return {
    gateway: { port: 8080, host: '127.0.0.1' },
    router: {
      namespace_strategy: 'prefix',
      health_check: {
        enabled: false,
        interval_seconds: 30,
        timeout_ms: 5000,
        unhealthy_threshold: 3,
        healthy_threshold: 1,
      },
    },
    servers: [
      { id: 'salesforce', url: 'http://localhost:3001/mcp', cache: { default_ttl: 300 } },
      { id: 'github', url: 'http://localhost:3002/mcp', cache: { default_ttl: 300 } },
    ],
    cache: { enabled: true, l1: { max_entries: 1000, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: {
      log_args: true,
      log_responses: false,
      redact_fields: [],
      retention_days: 30,
      db_path: ':memory:',
    },
    metrics: { enabled: false, port: 9090 },
    ...overrides,
  };
}

describe('connect install sessions', () => {
  it('creates a bundle and deeplink for user-scoped installs', () => {
    const store = new ConnectInstallSessionStore();
    const session = store.createSession(makeConfig(), {
      target: 'cursor',
      profile: 'default',
      scope: 'user',
      bundleBaseUrl: 'http://127.0.0.1:8080',
    });

    expect(session.bundle_url).toContain('/conduit/connect/install/bundles/');
    expect(session.deeplink).toContain('conduit://install?bundle_url=');

    const token = session.bundle_url.split('/').pop();
    const bundle = store.getBundle(token ?? '');
    expect(bundle?.transport).toBe('stdio-relay');
    expect(bundle?.servers).toHaveLength(2);
  });

  it('omits deeplink for project-scoped installs that need a working directory', () => {
    const store = new ConnectInstallSessionStore();
    const session = store.createSession(makeConfig(), {
      target: 'cursor',
      profile: 'default',
      scope: 'project',
      bundleBaseUrl: 'http://127.0.0.1:8080',
    });

    expect(session.deeplink).toBeUndefined();
    expect(session.install_command).toContain('--project-dir "$PWD"');
  });

  it('keeps a deeplink for Claude Desktop because the target collapses to a machine-wide config', () => {
    const store = new ConnectInstallSessionStore();
    const session = store.createSession(makeConfig(), {
      target: 'claude-desktop',
      profile: 'default',
      scope: 'project',
      bundleBaseUrl: 'http://127.0.0.1:8080',
    });

    expect(session.scope_effective).toBe('global');
    expect(session.deeplink).toContain('conduit://install?bundle_url=');
    expect(session.install_command).not.toContain('--project-dir');
  });

  it('requires a gateway token when Conduit auth is enabled', () => {
    const store = new ConnectInstallSessionStore();
    expect(() => store.createSession(makeConfig({
      auth: {
        method: 'api-key',
        api_keys: [{ key: 'secret', client_id: 'cursor', tenant_id: 'default' }],
      },
    }), {
      target: 'cursor',
      profile: 'default',
      scope: 'user',
      bundleBaseUrl: 'http://127.0.0.1:8080',
    })).toThrow('A gateway token is required');
  });

  it('persists identity preflight details into the install session and bundle', () => {
    const store = new ConnectInstallSessionStore();
    const session = store.createSession(makeConfig(), {
      target: 'cursor',
      profile: 'default',
      scope: 'user',
      bundleBaseUrl: 'http://127.0.0.1:8080',
      identityPreflight: {
        profile_id: 'default',
        profile_label: 'Default',
        ready: false,
        blocking_count: 1,
        server_requirements: [{
          server_id: 'salesforce',
          transport: 'http',
          status: 'missing-connected-account',
          ready: false,
          blocking: true,
          forward_identity_mode: 'none',
          connected_account: {
            provider: 'salesforce',
            binding: 'client',
            required: true,
            resolved: false,
            status: 'missing-connected-account',
            message: 'No connected account for provider "salesforce"',
          },
        }],
      },
    });

    expect(session.identity_preflight?.blocking_count).toBe(1);

    const token = session.bundle_url.split('/').pop();
    const bundle = store.getBundle(token ?? '');
    expect(bundle?.identity_preflight?.server_requirements[0]?.status).toBe('missing-connected-account');
  });

  it('parses conduit install deeplinks', () => {
    expect(parseConnectDeeplink('conduit://install?bundle_url=https%3A%2F%2Fexample.com%2Fconduit%2Fconnect%2Finstall%2Fbundles%2Fabc'))
      .toBe('https://example.com/conduit/connect/install/bundles/abc');
  });
});

// ─── Audit 3.1#10 — bundle expiry ─────────────────────────────────────────────

describe('connect install sessions — expiry', () => {
  it('returns null when retrieving an expired bundle', async () => {
    const store = new ConnectInstallSessionStore();
    const session = store.createSession(makeConfig(), {
      target: 'cursor',
      profile: 'default',
      scope: 'user',
      bundleBaseUrl: 'http://127.0.0.1:8080',
      ttlMs: 30,
    });
    const token = session.bundle_url.split('/').pop() ?? '';
    expect(store.getBundle(token)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(store.getBundle(token)).toBeNull();
  });

  it('expires_at on the bundle matches the ttl set on creation', () => {
    const store = new ConnectInstallSessionStore();
    const before = Date.now();
    const session = store.createSession(makeConfig(), {
      target: 'cursor',
      profile: 'default',
      scope: 'user',
      bundleBaseUrl: 'http://127.0.0.1:8080',
      ttlMs: 5_000,
    });
    const expiresAtMs = new Date(session.expires_at).getTime();
    // Should be ~5s in the future, within a reasonable window.
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 4_000);
    expect(expiresAtMs).toBeLessThanOrEqual(before + 6_000);
  });

  it('default TTL is 10 minutes when ttlMs is not provided', () => {
    const store = new ConnectInstallSessionStore();
    const before = Date.now();
    const session = store.createSession(makeConfig(), {
      target: 'cursor',
      profile: 'default',
      scope: 'user',
      bundleBaseUrl: 'http://127.0.0.1:8080',
    });
    const expiresAtMs = new Date(session.expires_at).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 9 * 60 * 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(before + 11 * 60 * 1000);
  });

  it('an unrelated session creation prunes other expired sessions', async () => {
    const store = new ConnectInstallSessionStore();
    const sessionA = store.createSession(makeConfig(), {
      target: 'cursor', profile: 'default', scope: 'user',
      bundleBaseUrl: 'http://127.0.0.1:8080', ttlMs: 30,
    });
    const tokenA = sessionA.bundle_url.split('/').pop() ?? '';
    expect(store.getBundle(tokenA)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Creating a fresh session triggers pruneExpired (private), which deletes A.
    store.createSession(makeConfig(), {
      target: 'cursor', profile: 'default', scope: 'user',
      bundleBaseUrl: 'http://127.0.0.1:8080', ttlMs: 5_000,
    });
    expect(store.getBundle(tokenA)).toBeNull();
  });

  it('returns null for an unknown bundle token (single-fetch safety)', () => {
    const store = new ConnectInstallSessionStore();
    expect(store.getBundle('does-not-exist')).toBeNull();
    expect(store.getBundle('')).toBeNull();
  });

  it('bundle token is a 32-char base64url string (192-bit randomness)', () => {
    const store = new ConnectInstallSessionStore();
    const session = store.createSession(makeConfig(), {
      target: 'cursor', profile: 'default', scope: 'user',
      bundleBaseUrl: 'http://127.0.0.1:8080',
    });
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('two consecutive sessions yield distinct bundle tokens', () => {
    const store = new ConnectInstallSessionStore();
    const a = store.createSession(makeConfig(), {
      target: 'cursor', profile: 'default', scope: 'user',
      bundleBaseUrl: 'http://127.0.0.1:8080',
    });
    const b = store.createSession(makeConfig(), {
      target: 'cursor', profile: 'default', scope: 'user',
      bundleBaseUrl: 'http://127.0.0.1:8080',
    });
    expect(a.token).not.toBe(b.token);
  });
});
