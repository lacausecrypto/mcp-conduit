import { describe, expect, it } from 'vitest';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { ConnectRemoteSessionStore } from '../../src/connect/remote.js';

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

describe('connect remote sessions', () => {
  it('creates a remote bundle for supported remote connector targets', () => {
    const store = new ConnectRemoteSessionStore();
    const session = store.createSession(makeConfig(), {
      target: 'claude',
      profile: 'default',
      scope: 'user',
      baseUrl: 'https://conduit.example.com',
      bundleBaseUrl: 'https://conduit.example.com',
    });

    expect(session.delivery).toBe('remote-connector');
    expect(session.bundle_url).toContain('/conduit/connect/remote/bundles/');
    expect(session.profile_url).toBe('https://conduit.example.com/mcp/profile/default');
    expect(session.remote_ready).toBe(true);

    const token = session.bundle_url.split('/').pop() ?? '';
    const bundle = store.getBundle(token);
    expect(bundle?.delivery).toBe('remote-connector');
    expect(bundle?.settings_url).toBe('https://claude.ai/settings/connectors');
  });

  it('flags blockers when the Conduit URL is not remotely usable', () => {
    const store = new ConnectRemoteSessionStore();
    const session = store.createSession(makeConfig({
      auth: {
        method: 'api-key',
        api_keys: [{ key: 'secret', client_id: 'test', tenant_id: 'default' }],
      },
    }), {
      target: 'chatgpt',
      profile: 'default',
      scope: 'user',
      baseUrl: 'http://127.0.0.1:8080',
      bundleBaseUrl: 'http://127.0.0.1:8080',
    });

    expect(session.remote_ready).toBe(false);
    expect(session.blockers).toContain('Conduit remote distribution currently requires an authless gateway or a future OAuth bridge.');
    expect(session.blockers).toContain('Remote connectors require an HTTPS Conduit URL.');
    expect(session.blockers).toContain('Remote connectors require a public Conduit host reachable from the internet.');
  });
});
