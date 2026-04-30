import { describe, expect, it, vi } from 'vitest';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { ConnectOfficialRegistryStore } from '../../src/connect/registry.js';

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
    servers: [],
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

describe('connect official registry library', () => {
  it('indexes latest entries, scores them, and filters importable servers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      servers: [
        {
          server: {
            name: 'io.github.example/simple-remote',
            title: 'Simple Remote',
            description: 'Remote server with no extra config',
            version: '1.2.0',
            remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
          },
          _meta: {
            'io.modelcontextprotocol.registry/official': {
              status: 'active',
              isLatest: true,
              publishedAt: '2026-04-01T00:00:00.000Z',
              updatedAt: '2026-04-10T00:00:00.000Z',
            },
          },
        },
        {
          server: {
            name: 'io.github.example/env-heavy',
            title: 'Needs Secrets',
            description: 'Package with required env',
            version: '0.4.0',
            packages: [{
              registryType: 'npm',
              identifier: '@example/env-heavy',
              version: '0.4.0',
              transport: { type: 'stdio' },
              environmentVariables: [{ name: 'API_KEY', isRequired: true }],
            }],
          },
          _meta: {
            'io.modelcontextprotocol.registry/official': {
              status: 'active',
              isLatest: true,
              publishedAt: '2026-04-02T00:00:00.000Z',
              updatedAt: '2026-04-09T00:00:00.000Z',
            },
          },
        },
        {
          server: {
            name: 'io.github.example/old-version',
            title: 'Old Version',
            description: 'Non latest entry should be filtered out',
            version: '0.1.0',
            packages: [{ registryType: 'npm', identifier: 'old-version', version: '0.1.0', transport: { type: 'stdio' } }],
          },
          _meta: {
            'io.modelcontextprotocol.registry/official': {
              status: 'active',
              isLatest: false,
            },
          },
        },
      ],
      metadata: { count: 3 },
    }), { status: 200 }));

    const store = new ConnectOfficialRegistryStore(makeConfig({
      connect: {
        registry: {
          base_url: 'https://registry.example.test',
          cache_ttl_seconds: 3600,
          page_size: 100,
          max_pages: 1,
          latest_only: true,
        },
      },
    }), { fetchImpl: fetchMock as typeof fetch });

    const library = await store.listLibrary({ auto_importable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(library.stats.total).toBe(2);
    expect(library.stats.filtered).toBe(1);
    expect(library.items[0]?.name).toBe('io.github.example/simple-remote');
    expect(library.items[0]?.auto_importable).toBe(true);
    expect(library.items[0]?.readiness).toBe('ready');
    expect(library.items[0]?.strategy).toBe('proxy-remote');

    const fullLibrary = await store.listLibrary();
    const envHeavy = fullLibrary.items.find((item) => item.name === 'io.github.example/env-heavy');
    expect(envHeavy?.auto_importable).toBe(false);
    expect(envHeavy?.configurable_import).toBe(true);
    expect(envHeavy?.readiness).toBe('needs-config');
    expect(envHeavy?.import_requirements.env).toEqual([
      expect.objectContaining({ key: 'API_KEY', required: true, source: 'package-env' }),
    ]);
  });

  it('follows the full registry cursor chain when max_pages is 0 and finds later entries by publisher and slug', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const cursor = new URL(url).searchParams.get('cursor');
      const body = !cursor
        ? {
          servers: [{
            server: {
              name: 'io.github.example/first-entry',
              title: 'First Entry',
              description: 'First page only',
              version: '1.0.0',
              remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
            },
            _meta: {
              'io.modelcontextprotocol.registry/official': {
                status: 'active',
                isLatest: true,
              },
            },
          }],
          metadata: { nextCursor: 'page-2' },
        }
        : {
          servers: [{
            server: {
              name: 'io.github.lacausecrypto/mcp-belgium',
              title: 'mcp-belgium',
              description: 'Belgian public data MCP',
              version: '1.0.4',
              repository: {
                url: 'https://github.com/lacausecrypto/mcp-belgium',
                source: 'github',
              },
              packages: [{
                registryType: 'npm',
                identifier: 'mcp-belgium',
                version: '1.0.4',
                transport: { type: 'stdio' },
              }],
            },
            _meta: {
              'io.modelcontextprotocol.registry/official': {
                status: 'active',
                isLatest: true,
              },
            },
          }],
          metadata: {},
        };

      return new Response(JSON.stringify(body), { status: 200 });
    });

    const store = new ConnectOfficialRegistryStore(makeConfig({
      connect: {
        registry: {
          base_url: 'https://registry.example.test',
          cache_ttl_seconds: 3600,
          page_size: 100,
          max_pages: 0,
          latest_only: true,
        },
      },
    }), { fetchImpl: fetchMock as typeof fetch });

    const library = await store.listLibrary({ search: 'lacausecrypto mcp-belgium' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(library.stats.total).toBe(2);
    expect(library.stats.filtered).toBe(1);
    expect(library.items[0]?.name).toBe('io.github.lacausecrypto/mcp-belgium');
  });

  it('builds an HTTP Conduit import plan from a remote registry server', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      servers: [{
        server: {
          name: 'io.github.example/simple-remote',
          title: 'Simple Remote',
          description: 'Remote server',
          version: '1.2.0',
          remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
        },
        _meta: {
          'io.modelcontextprotocol.registry/official': {
            status: 'active',
            isLatest: true,
          },
        },
      }],
      metadata: { count: 1 },
    }), { status: 200 }));

    const store = new ConnectOfficialRegistryStore(makeConfig(), { fetchImpl: fetchMock as typeof fetch });
    const plan = await store.createImportPlan('io.github.example/simple-remote');
    expect(plan.server.id).toBe('io-github-example-simple-remote');
    expect(plan.server.url).toBe('https://example.com/mcp');
    expect(plan.source.strategy).toBe('proxy-remote');
  });

  it('builds a stdio Conduit import plan from an npm registry server', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      servers: [{
        server: {
          name: 'io.github.example/npm-tool',
          title: 'NPM Tool',
          description: 'Package server',
          version: '2.3.4',
          packages: [{
            registryType: 'npm',
            identifier: '@example/npm-tool',
            version: '2.3.4',
            transport: { type: 'stdio' },
          }],
        },
        _meta: {
          'io.modelcontextprotocol.registry/official': {
            status: 'active',
            isLatest: true,
          },
        },
      }],
      metadata: { count: 1 },
    }), { status: 200 }));

    const store = new ConnectOfficialRegistryStore(makeConfig(), { fetchImpl: fetchMock as typeof fetch });
    const plan = await store.createImportPlan('io.github.example/npm-tool');
    expect(plan.server.transport).toBe('stdio');
    expect(plan.server.command).toBe('npx');
    expect(plan.server.args).toEqual(['-y', '@example/npm-tool@2.3.4']);
    expect(plan.server.managed_runtime).toEqual(expect.objectContaining({
      enabled: true,
      source_type: 'npm',
      source_ref: '@example/npm-tool',
      channel: 'stable',
      releases: [
        expect.objectContaining({
          version: '2.3.4',
          command: 'npx',
          args: ['-y', '@example/npm-tool@2.3.4'],
        }),
      ],
    }));
    expect(plan.source.strategy).toBe('conduit-host-package');
  });

  it('propagates package runtime arguments from the registry manifest into the managed stdio command', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      servers: [{
        server: {
          name: 'io.github.lacausecrypto/sophon',
          title: 'Sophon',
          description: 'Needs an explicit subcommand',
          version: '0.5.1',
          packages: [{
            registryType: 'npm',
            identifier: 'mcp-sophon',
            version: '0.5.1',
            transport: { type: 'stdio' },
            runtimeArguments: [{ type: 'positional', value: 'serve' }],
          }],
        },
        _meta: {
          'io.modelcontextprotocol.registry/official': {
            status: 'active',
            isLatest: true,
          },
        },
      }],
      metadata: { count: 1 },
    }), { status: 200 }));

    const store = new ConnectOfficialRegistryStore(makeConfig(), { fetchImpl: fetchMock as typeof fetch });
    const plan = await store.createImportPlan('io.github.lacausecrypto/sophon');

    expect(plan.server.command).toBe('npx');
    expect(plan.server.args).toEqual(['-y', 'mcp-sophon@0.5.1', 'serve']);
    expect(plan.server.managed_runtime?.releases[0]?.args).toEqual(['-y', 'mcp-sophon@0.5.1', 'serve']);
  });

  it('builds a configured remote import plan when headers and URL variables are required', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      servers: [{
        server: {
          name: 'io.github.example/tenant-remote',
          title: 'Tenant Remote',
          description: 'Remote server with required headers and variables',
          version: '1.0.0',
          remotes: [{
            type: 'streamable-http',
            url: 'https://{tenant}.example.com/mcp',
            variables: {
              tenant: {
                description: 'Tenant slug',
                isRequired: true,
                default: 'eu-1',
              },
            },
            headers: [{ name: 'X-API-Key', isRequired: true, isSecret: true }],
          }],
        },
        _meta: {
          'io.modelcontextprotocol.registry/official': {
            status: 'active',
            isLatest: true,
          },
        },
      }],
      metadata: { count: 1 },
    }), { status: 200 }));

    const store = new ConnectOfficialRegistryStore(makeConfig(), { fetchImpl: fetchMock as typeof fetch });
    const library = await store.listLibrary();
    const item = library.items[0];
    expect(item?.readiness).toBe('needs-config');
    expect(item?.strategy).toBe('proxy-remote');
    expect(item?.import_requirements.variables).toEqual([
      expect.objectContaining({ key: 'tenant', default_value: 'eu-1', required: true }),
    ]);
    expect(item?.import_requirements.headers).toEqual([
      expect.objectContaining({ key: 'X-API-Key', required: true, secret: true }),
    ]);

    const plan = await store.createImportPlan('io.github.example/tenant-remote', 'latest', {
      headers: { 'X-API-Key': 'secret-123' },
      variables: { tenant: 'acme' },
    });
    expect(plan.server.url).toBe('https://acme.example.com/mcp');
    expect(plan.server.headers).toEqual({ 'X-API-Key': 'secret-123' });
  });

  it('builds a configured package import plan when required env values are provided', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      servers: [{
        server: {
          name: 'io.github.example/stdio-secret',
          title: 'Stdio Secret',
          description: 'Package server with required env',
          version: '3.0.0',
          packages: [{
            registryType: 'npm',
            identifier: '@example/stdio-secret',
            version: '3.0.0',
            transport: { type: 'stdio' },
            environmentVariables: [{ name: 'API_TOKEN', isRequired: true, isSecret: true }],
          }],
        },
        _meta: {
          'io.modelcontextprotocol.registry/official': {
            status: 'active',
            isLatest: true,
          },
        },
      }],
      metadata: { count: 1 },
    }), { status: 200 }));

    const store = new ConnectOfficialRegistryStore(makeConfig(), { fetchImpl: fetchMock as typeof fetch });
    const plan = await store.createImportPlan('io.github.example/stdio-secret', 'latest', {
      env: { API_TOKEN: 'token-abc' },
    });
    expect(plan.server.transport).toBe('stdio');
    expect(plan.server.env).toEqual({ API_TOKEN: 'token-abc' });
  });

  it('rejects imports when required config values are missing', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      servers: [{
        server: {
          name: 'io.github.example/strict-remote',
          title: 'Strict Remote',
          description: 'Remote server with required variable',
          version: '1.0.0',
          remotes: [{
            type: 'streamable-http',
            url: 'https://{tenant}.example.com/mcp',
            variables: {
              tenant: { isRequired: true },
            },
          }],
        },
        _meta: {
          'io.modelcontextprotocol.registry/official': {
            status: 'active',
            isLatest: true,
          },
        },
      }],
      metadata: { count: 1 },
    }), { status: 200 }));

    const store = new ConnectOfficialRegistryStore(makeConfig(), { fetchImpl: fetchMock as typeof fetch });
    await expect(store.createImportPlan('io.github.example/strict-remote')).rejects.toThrow('Missing required remote-variable value "tenant"');
  });
});
