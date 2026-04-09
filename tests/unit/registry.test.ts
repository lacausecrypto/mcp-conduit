import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServerRegistry } from '../../src/router/registry.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { getMetrics, resetMetrics } from '../../src/observability/metrics.js';

/** Configuration minimale pour les tests */
function makeConfig(servers: Array<{ id: string; url: string }>): ConduitGatewayConfig {
  return {
    gateway: { port: 8080, host: '0.0.0.0' },
    router: {
      namespace_strategy: 'prefix',
      health_check: {
        enabled: false,
        interval_seconds: 30,
        timeout_ms: 5000,
        unhealthy_threshold: 3,
      },
    },
    servers: servers.map((s) => ({
      id: s.id,
      url: s.url,
      cache: { default_ttl: 300 },
    })),
    cache: { enabled: true, l1: { max_entries: 100, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: {
      log_args: true,
      log_responses: false,
      redact_fields: [],
      retention_days: 30,
      db_path: ':memory:',
    },
    metrics: { enabled: false, port: 9090 },
  };
}

/** Client MCP simulé */
function makeMockClient(serverId: string, tools: string[]) {
  return {
    serverId,
    serverUrl: `http://localhost:9999`,
    forward: vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      isStream: false,
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: tools.map((name) => ({
            name,
            description: `Tool ${name}`,
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true },
          })),
        },
      },
    }),
    getSessionId: vi.fn().mockReturnValue(undefined),
    setSessionId: vi.fn(),
    openSseStream: vi.fn(),
  };
}

describe('ServerRegistry', () => {
  beforeEach(() => {
    resetMetrics();
  });

  describe('initialisation', () => {
    it('crée des entrées pour chaque serveur configuré', () => {
      const config = makeConfig([
        { id: 'server-a', url: 'http://localhost:3001/mcp' },
        { id: 'server-b', url: 'http://localhost:3002/mcp' },
      ]);

      const clients = new Map([
        ['server-a', makeMockClient('server-a', []) as unknown as import('../../src/proxy/mcp-client.js').McpClient],
        ['server-b', makeMockClient('server-b', []) as unknown as import('../../src/proxy/mcp-client.js').McpClient],
      ]);

      const registry = new ServerRegistry(config, clients, getMetrics());
      const servers = registry.getAllServers();

      expect(servers).toHaveLength(2);
      expect(servers.map((s) => s.config.id)).toContain('server-a');
      expect(servers.map((s) => s.config.id)).toContain('server-b');
    });

    it('initialise les serveurs comme sains par défaut', () => {
      const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001/mcp' }]);
      const clients = new Map([
        ['server-a', makeMockClient('server-a', []) as unknown as import('../../src/proxy/mcp-client.js').McpClient],
      ]);

      const registry = new ServerRegistry(config, clients, getMetrics());
      const health = registry.getHealthStatus();

      expect(health[0]?.healthy).toBe(true);
    });
  });

  describe('refresh', () => {
    it('récupère les outils d\'un serveur', async () => {
      const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001/mcp' }]);
      const mockClient = makeMockClient('server-a', ['get_contact', 'search_leads']);
      const clients = new Map([
        ['server-a', mockClient as unknown as import('../../src/proxy/mcp-client.js').McpClient],
      ]);

      const registry = new ServerRegistry(config, clients, getMetrics());
      await registry.refreshServer('server-a');

      const serverInfo = registry.getServerInfo('server-a');
      expect(serverInfo?.tools).toHaveLength(2);
      expect(serverInfo?.tools.map((t) => t.name)).toContain('get_contact');
    });

    it('ne crash pas pour un serveur inconnu', async () => {
      const config = makeConfig([]);
      const clients = new Map<string, import('../../src/proxy/mcp-client.js').McpClient>();

      const registry = new ServerRegistry(config, clients, getMetrics());
      await expect(registry.refreshServer('unknown')).resolves.toBeUndefined();
    });

    it('met à jour les annotations lors du refresh', async () => {
      const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001/mcp' }]);
      const mockClient = makeMockClient('server-a', ['get_contact']);
      const clients = new Map([
        ['server-a', mockClient as unknown as import('../../src/proxy/mcp-client.js').McpClient],
      ]);

      const registry = new ServerRegistry(config, clients, getMetrics());
      await registry.refreshServer('server-a');

      const annotations = registry.getAnnotations('server-a', 'get_contact');
      expect(annotations.readOnlyHint).toBe(true);
    });
  });

  describe('updateAnnotations', () => {
    it('met à jour les annotations d\'un serveur', () => {
      const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001/mcp' }]);
      const clients = new Map([
        ['server-a', makeMockClient('server-a', []) as unknown as import('../../src/proxy/mcp-client.js').McpClient],
      ]);

      const registry = new ServerRegistry(config, clients, getMetrics());
      registry.updateAnnotations('server-a', [
        {
          name: 'get_contact',
          annotations: { readOnlyHint: true },
        },
      ]);

      expect(registry.getAnnotations('server-a', 'get_contact')).toEqual({ readOnlyHint: true });
    });

    it('retourne un objet vide pour un outil inconnu', () => {
      const config = makeConfig([{ id: 'server-a', url: 'http://localhost:3001/mcp' }]);
      const clients = new Map([
        ['server-a', makeMockClient('server-a', []) as unknown as import('../../src/proxy/mcp-client.js').McpClient],
      ]);

      const registry = new ServerRegistry(config, clients, getMetrics());
      expect(registry.getAnnotations('server-a', 'unknown_tool')).toEqual({});
    });
  });

  describe('map d\'espace de noms', () => {
    it('construit la map après initialize', async () => {
      const config = makeConfig([
        { id: 'salesforce', url: 'http://localhost:3001/mcp' },
      ]);
      const mockClient = makeMockClient('salesforce', ['get_contact']);
      const clients = new Map([
        ['salesforce', mockClient as unknown as import('../../src/proxy/mcp-client.js').McpClient],
      ]);

      const registry = new ServerRegistry(config, clients, getMetrics());
      await registry.initialize();

      const map = registry.getNamespaceMap();
      expect(map.size).toBeGreaterThan(0);
      expect(map.get('salesforce.get_contact')).toEqual({
        serverId: 'salesforce',
        toolName: 'get_contact',
      });
    });
  });
});
