import { describe, expect, it } from 'vitest';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import {
  buildConnectProfileUrl,
  deriveBaseUrl,
  exportConnectProfile,
  listConnectProfiles,
  listConnectTargets,
} from '../../src/connect/export.js';

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

describe('connect export', () => {
  it('lists the MVP default profile', () => {
    const profiles = listConnectProfiles(makeConfig());
    expect(profiles).toEqual([{
      id: 'default',
      label: 'Default',
      description: 'All configured upstream MCP servers exposed through this Conduit gateway.',
      server_ids: ['salesforce', 'github'],
    }]);
  });

  it('lists configured custom profiles after the built-in default profile', () => {
    const profiles = listConnectProfiles(makeConfig({
      connect: {
        profiles: [{
          id: 'sales',
          label: 'Sales',
          description: 'Only sales-facing servers',
          server_ids: ['salesforce'],
        }],
      },
    }));

    expect(profiles.map((profile) => profile.id)).toEqual(['default', 'sales']);
    expect(profiles[1]?.server_ids).toEqual(['salesforce']);
  });

  it('lists supported targets', () => {
    expect(listConnectTargets().map((target) => target.id)).toEqual([
      'cursor',
      'claude-code',
      'claude-desktop',
      'codex',
      'windsurf',
      'vscode',
      'generic-json',
      'claude',
      'chatgpt',
      'v0',
    ]);
  });

  it('derives a localhost base url from wildcard listen hosts', () => {
    expect(deriveBaseUrl(makeConfig({ gateway: { port: 8080, host: '0.0.0.0' } }))).toBe('http://localhost:8080');
  });

  it('exports Cursor config with env-backed Authorization headers when api-key auth is enabled', () => {
    const result = exportConnectProfile(makeConfig({
      auth: {
        method: 'api-key',
        api_keys: [{ key: 'secret', client_id: 'cursor', tenant_id: 'default' }],
      },
    }), {
      target: 'cursor',
      profile: 'default',
      scope: 'project',
    });

    expect(result.placement).toBe('.cursor/mcp.json');
    expect(result.snippet).toContain('"mcpServers"');
    expect(result.snippet).toContain('"conduit-salesforce"');
    expect(result.snippet).toContain('http://127.0.0.1:8080/mcp/salesforce');
    expect(result.snippet).toContain('Bearer ${env:CONDUIT_API_KEY}');
    expect(result.env[0]?.name).toBe('CONDUIT_API_KEY');
  });

  it('exports Claude Code install commands for all routed servers', () => {
    const result = exportConnectProfile(makeConfig({
      auth: {
        method: 'jwt',
        jwks_url: 'https://idp.example.com/jwks',
        issuer: 'https://idp.example.com/',
      },
    }), {
      target: 'claude-code',
      profile: 'default',
      scope: 'user',
      baseUrl: 'https://conduit.example.com',
    });

    expect(result.snippet).toContain('claude mcp add --transport http --scope user --header "Authorization: Bearer $CONDUIT_BEARER_TOKEN" conduit-salesforce https://conduit.example.com/mcp/salesforce');
    expect(result.snippet).toContain('conduit-github https://conduit.example.com/mcp/github');
  });

  it('exports Claude Desktop config via mcp-remote and collapses project installs to a global config', () => {
    const result = exportConnectProfile(makeConfig({
      auth: {
        method: 'api-key',
        api_keys: [{ key: 'secret', client_id: 'claude-desktop', tenant_id: 'default' }],
      },
    }), {
      target: 'claude-desktop',
      profile: 'default',
      scope: 'project',
      baseUrl: 'https://conduit.example.com',
    });

    expect(result.scope_effective).toBe('global');
    expect(result.placement).toBe('Claude Desktop config.json / claude_desktop_config.json');
    expect(result.snippet).toContain('"command": "npx"');
    expect(result.snippet).toContain('"mcp-remote"');
    expect(result.snippet).toContain('https://conduit.example.com/mcp/salesforce');
    expect(result.snippet).toContain('Authorization: Bearer ${CONDUIT_API_KEY}');
  });

  it('exports Codex config in TOML with bearer_token_env_var', () => {
    const result = exportConnectProfile(makeConfig({
      auth: {
        method: 'jwt',
        jwks_url: 'https://idp.example.com/jwks',
        issuer: 'https://idp.example.com/',
      },
    }), {
      target: 'codex',
      profile: 'default',
      scope: 'project',
      baseUrl: 'https://conduit.example.com',
    });

    expect(result.format).toBe('toml');
    expect(result.placement).toBe('.codex/config.toml');
    expect(result.snippet).toContain('[mcp_servers.conduit-salesforce]');
    expect(result.snippet).toContain('url = "https://conduit.example.com/mcp/salesforce"');
    expect(result.snippet).toContain('bearer_token_env_var = "CONDUIT_BEARER_TOKEN"');
  });

  it('exports VS Code config with secure input variables', () => {
    const result = exportConnectProfile(makeConfig({
      auth: {
        method: 'api-key',
        api_keys: [{ key: 'secret', client_id: 'vscode', tenant_id: 'default' }],
      },
    }), {
      target: 'vscode',
      profile: 'default',
      scope: 'project',
    });

    expect(result.placement).toBe('.vscode/mcp.json');
    expect(result.snippet).toContain('"inputs"');
    expect(result.snippet).toContain('"type": "http"');
    expect(result.snippet).toContain('"Authorization": "Bearer ${input:conduitAuthToken}"');
    expect(result.snippet).toContain('"conduitSalesforce"');
  });

  it('exports Windsurf config using serverUrl', () => {
    const result = exportConnectProfile(makeConfig(), {
      target: 'windsurf',
      profile: 'default',
      scope: 'project',
    });

    expect(result.scope_effective).toBe('global');
    expect(result.placement).toBe('~/.codeium/mcp_config.json');
    expect(result.snippet).toContain('"serverUrl"');
  });

  it('exports a Claude remote connector manifest against the Conduit profile endpoint', () => {
    const result = exportConnectProfile(makeConfig({
      gateway: {
        port: 443,
        host: 'conduit.example.com',
        tls: {
          enabled: true,
          cert_path: '/tmp/cert.pem',
          key_path: '/tmp/key.pem',
        },
      },
    }), {
      target: 'claude',
      profile: 'default',
      scope: 'user',
      baseUrl: 'https://conduit.example.com',
    });

    expect(result.scope_effective).toBe('global');
    expect(result.placement).toContain('Claude Settings');
    expect(result.snippet).toContain(buildConnectProfileUrl('https://conduit.example.com', 'default'));
    expect(result.snippet).toContain('"transport": "streamable-http"');
  });

  it('exports a ChatGPT remote connector manifest against the Conduit profile endpoint', () => {
    const result = exportConnectProfile(makeConfig(), {
      target: 'chatgpt',
      profile: 'default',
      scope: 'user',
      baseUrl: 'https://conduit.example.com',
    });

    expect(result.scope_effective).toBe('global');
    expect(result.placement).toContain('ChatGPT');
    expect(result.snippet).toContain('"server_url": "https://conduit.example.com/mcp/profile/default"');
  });

  it('exports a v0 remote connector manifest against the Conduit profile endpoint', () => {
    const result = exportConnectProfile(makeConfig(), {
      target: 'v0',
      profile: 'default',
      scope: 'user',
      baseUrl: 'https://conduit.example.com',
    });

    expect(result.scope_effective).toBe('global');
    expect(result.placement).toContain('v0');
    expect(result.snippet).toContain('"url": "https://conduit.example.com/mcp/profile/default"');
  });

  it('throws for an unknown profile', () => {
    expect(() => exportConnectProfile(makeConfig(), {
      target: 'cursor',
      profile: 'team-a',
    })).toThrow('Unknown connect profile "team-a"');
  });

  it('exports a configured custom profile with only its mapped servers', () => {
    const result = exportConnectProfile(makeConfig({
      connect: {
        profiles: [{
          id: 'sales',
          server_ids: ['salesforce'],
        }],
      },
    }), {
      target: 'generic-json',
      profile: 'sales',
      scope: 'user',
    });

    expect(result.profile).toBe('sales');
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.id).toBe('salesforce');
    expect(result.snippet).toContain('conduit-salesforce');
    expect(result.snippet).not.toContain('conduit-github');
  });
});
