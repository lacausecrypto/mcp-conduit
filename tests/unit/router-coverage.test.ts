/**
 * Additional coverage tests for src/router/router.ts
 * Focuses on paths not covered by existing e2e tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { ConduitRouter } from '../../src/router/router.js';
import type { ServerRegistry } from '../../src/router/registry.js';
import type { McpClient } from '../../src/proxy/mcp-client.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import type { ToolMetadata } from '../../src/cache/types.js';

/** Minimal config for router tests */
function makeConfig(strategy: 'prefix' | 'none' = 'none', lb: 'round-robin' | 'least-connections' = 'round-robin'): ConduitGatewayConfig {
  return {
    gateway: { port: 8080, host: '0.0.0.0' },
    router: {
      namespace_strategy: strategy,
      health_check: { enabled: false, interval_seconds: 30, timeout_ms: 5000, unhealthy_threshold: 3, healthy_threshold: 1 },
      load_balancing: lb,
    },
    servers: [{ id: 'server-a', url: 'http://localhost:3001', cache: { default_ttl: 300 } }],
    cache: { enabled: true, l1: { max_entries: 100, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: { log_args: true, log_responses: false, redact_fields: [], retention_days: 30, db_path: ':memory:' },
    metrics: { enabled: false, port: 9090 },
  };
}

/** Mock client with controllable activeConnections */
function makeMockClient(activeConnections = 0): McpClient {
  return { activeConnections } as unknown as McpClient;
}

/** Mock registry builder */
function makeRegistry(opts: {
  namespaceMap?: Map<string, { serverId: string; toolName: string }>;
  healthyReplicas?: Map<string, Array<{ client: McpClient }>>;
  serverInfoMap?: Map<string, { health: { healthy: boolean }; tools: ToolMetadata[] }>;
}): ServerRegistry {
  const {
    namespaceMap = new Map(),
    healthyReplicas = new Map(),
    serverInfoMap = new Map(),
  } = opts;

  return {
    getNamespaceMap: vi.fn().mockReturnValue(namespaceMap),
    getHealthyReplicas: vi.fn().mockImplementation((id: string) => healthyReplicas.get(id) ?? []),
    getServerInfo: vi.fn().mockImplementation((id: string) => serverInfoMap.get(id)),
    getAllServers: vi.fn().mockReturnValue([]),
    getHealthStatus: vi.fn().mockReturnValue([]),
  } as unknown as ServerRegistry;
}

describe('ConduitRouter.resolveToolCall', () => {
  it('returns null for unknown tool (not in namespace map)', () => {
    const registry = makeRegistry({});
    const clients = new Map<string, McpClient>();
    const router = new ConduitRouter(registry, clients, makeConfig('none'));

    const result = router.resolveToolCall('nonexistent_tool');
    expect(result).toBeNull();
  });

  it('returns routed request for known tool with healthy replica', () => {
    const client = makeMockClient();
    const namespaceMap = new Map([['get_contact', { serverId: 'server-a', toolName: 'get_contact' }]]);
    const healthyReplicas = new Map([['server-a', [{ client }]]]);
    const registry = makeRegistry({ namespaceMap, healthyReplicas });

    const router = new ConduitRouter(registry, new Map(), makeConfig('none'));
    const result = router.resolveToolCall('get_contact');

    expect(result).not.toBeNull();
    expect(result?.serverId).toBe('server-a');
    expect(result?.toolName).toBe('get_contact');
    expect(result?.client).toBe(client);
  });

  it('returns null when no healthy replicas for the server', () => {
    const namespaceMap = new Map([['get_contact', { serverId: 'server-a', toolName: 'get_contact' }]]);
    const registry = makeRegistry({ namespaceMap, healthyReplicas: new Map() });

    const router = new ConduitRouter(registry, new Map(), makeConfig('none'));
    const result = router.resolveToolCall('get_contact');
    expect(result).toBeNull();
  });

  it('resolves namespaced tool with prefix strategy', () => {
    const client = makeMockClient();
    // With prefix strategy, 'server-a.get_contact' maps to server-a/get_contact
    const namespaceMap = new Map([['server-a.get_contact', { serverId: 'server-a', toolName: 'get_contact' }]]);
    const healthyReplicas = new Map([['server-a', [{ client }]]]);
    const registry = makeRegistry({ namespaceMap, healthyReplicas });

    const router = new ConduitRouter(registry, new Map(), makeConfig('prefix'));
    const result = router.resolveToolCall('server-a.get_contact');

    expect(result).not.toBeNull();
    expect(result?.serverId).toBe('server-a');
    expect(result?.toolName).toBe('get_contact');
  });
});

describe('ConduitRouter - load balancing', () => {
  it('round-robin distributes across replicas sequentially', () => {
    const clientA = makeMockClient(0);
    const clientB = makeMockClient(0);
    const namespaceMap = new Map([['tool', { serverId: 'server-a', toolName: 'tool' }]]);
    const healthyReplicas = new Map([['server-a', [{ client: clientA }, { client: clientB }]]]);
    const registry = makeRegistry({ namespaceMap, healthyReplicas });

    const router = new ConduitRouter(registry, new Map(), makeConfig('none', 'round-robin'));

    const r1 = router.resolveToolCall('tool');
    const r2 = router.resolveToolCall('tool');
    const r3 = router.resolveToolCall('tool');

    // Round-robin: 0→1→0
    expect(r1?.client).toBe(clientA);
    expect(r2?.client).toBe(clientB);
    expect(r3?.client).toBe(clientA);
  });

  it('least-connections selects replica with fewest connections', () => {
    const clientA = makeMockClient(5);  // busy
    const clientB = makeMockClient(1);  // idle
    const namespaceMap = new Map([['tool', { serverId: 'server-a', toolName: 'tool' }]]);
    const healthyReplicas = new Map([['server-a', [{ client: clientA }, { client: clientB }]]]);
    const registry = makeRegistry({ namespaceMap, healthyReplicas });

    const router = new ConduitRouter(registry, new Map(), makeConfig('none', 'least-connections'));
    const result = router.resolveToolCall('tool');

    expect(result?.client).toBe(clientB);
  });

  it('least-connections with single replica returns that replica', () => {
    const client = makeMockClient(10);
    const namespaceMap = new Map([['tool', { serverId: 'server-a', toolName: 'tool' }]]);
    const healthyReplicas = new Map([['server-a', [{ client }]]]);
    const registry = makeRegistry({ namespaceMap, healthyReplicas });

    const router = new ConduitRouter(registry, new Map(), makeConfig('none', 'least-connections'));
    const result = router.resolveToolCall('tool');
    expect(result?.client).toBe(client);
  });
});

describe('ConduitRouter.buildAggregatedToolsList', () => {
  it('returns empty tools list when namespace map is empty', () => {
    const registry = makeRegistry({});
    const router = new ConduitRouter(registry, new Map(), makeConfig());

    const result = router.buildAggregatedToolsList(1) as { result: { tools: unknown[] } };
    expect(result.result.tools).toHaveLength(0);
  });

  it('includes tools from healthy servers', () => {
    const tool: ToolMetadata = { name: 'get_contact', description: 'Get a contact', inputSchema: { type: 'object' } };
    const namespaceMap = new Map([['get_contact', { serverId: 'server-a', toolName: 'get_contact' }]]);
    const serverInfoMap = new Map([
      ['server-a', { health: { healthy: true }, tools: [tool] }],
    ]);

    const registry = makeRegistry({ namespaceMap, serverInfoMap });
    const router = new ConduitRouter(registry, new Map(), makeConfig());

    const result = router.buildAggregatedToolsList(1) as { result: { tools: ToolMetadata[] } };
    expect(result.result.tools).toHaveLength(1);
    expect(result.result.tools[0]?.name).toBe('get_contact');
  });

  it('excludes tools from unhealthy servers', () => {
    const tool: ToolMetadata = { name: 'bad_tool', description: 'Tool on unhealthy server', inputSchema: { type: 'object' } };
    const namespaceMap = new Map([['bad_tool', { serverId: 'unhealthy-server', toolName: 'bad_tool' }]]);
    const serverInfoMap = new Map([
      ['unhealthy-server', { health: { healthy: false }, tools: [tool] }],
    ]);

    const registry = makeRegistry({ namespaceMap, serverInfoMap });
    const router = new ConduitRouter(registry, new Map(), makeConfig());

    const result = router.buildAggregatedToolsList(null) as { result: { tools: unknown[] } };
    expect(result.result.tools).toHaveLength(0);
  });

  it('uses null id when id is null', () => {
    const registry = makeRegistry({});
    const router = new ConduitRouter(registry, new Map(), makeConfig());
    const result = router.buildAggregatedToolsList(null) as { id: null };
    expect(result.id).toBeNull();
  });
});

describe('ConduitRouter.getAggregatedToolsWithServerIds', () => {
  it('returns tools with serverId and toolName', () => {
    const tool: ToolMetadata = { name: 'search_leads', description: 'Search leads', inputSchema: { type: 'object' } };
    const namespaceMap = new Map([['search_leads', { serverId: 'crm', toolName: 'search_leads' }]]);
    const serverInfoMap = new Map([
      ['crm', { health: { healthy: true }, tools: [tool] }],
    ]);

    const registry = makeRegistry({ namespaceMap, serverInfoMap });
    const router = new ConduitRouter(registry, new Map(), makeConfig());

    const items = router.getAggregatedToolsWithServerIds();
    expect(items).toHaveLength(1);
    expect(items[0]?.serverId).toBe('crm');
    expect(items[0]?.toolName).toBe('search_leads');
    expect(items[0]?.namespacedName).toBe('search_leads');
  });

  it('skips tools that do not exist in server toolDef list', () => {
    // Namespace map has a tool, but server's tools list doesn't include it
    const namespaceMap = new Map([['ghost_tool', { serverId: 'server-a', toolName: 'ghost_tool' }]]);
    const serverInfoMap = new Map([
      ['server-a', { health: { healthy: true }, tools: [] }],
    ]);

    const registry = makeRegistry({ namespaceMap, serverInfoMap });
    const router = new ConduitRouter(registry, new Map(), makeConfig());

    const items = router.getAggregatedToolsWithServerIds();
    expect(items).toHaveLength(0);
  });
});

describe('ConduitRouter.resolveToolName', () => {
  it('returns serverId and toolName for known tool', () => {
    const namespaceMap = new Map([['get_account', { serverId: 'server-a', toolName: 'get_account' }]]);
    const registry = makeRegistry({ namespaceMap });

    const router = new ConduitRouter(registry, new Map(), makeConfig());
    const result = router.resolveToolName('get_account');

    expect(result).toEqual({ serverId: 'server-a', toolName: 'get_account' });
  });

  it('returns null for unknown tool', () => {
    const registry = makeRegistry({});
    const router = new ConduitRouter(registry, new Map(), makeConfig());
    expect(router.resolveToolName('no_such_tool')).toBeNull();
  });
});

describe('ConduitRouter.getClientForServer', () => {
  it('returns null when server is unhealthy', () => {
    const serverInfoMap = new Map([
      ['server-a', { health: { healthy: false }, tools: [] }],
    ]);
    const registry = makeRegistry({ serverInfoMap });

    const router = new ConduitRouter(registry, new Map(), makeConfig());
    expect(router.getClientForServer('server-a')).toBeNull();
  });

  it('returns null when server does not exist', () => {
    const registry = makeRegistry({});
    const router = new ConduitRouter(registry, new Map(), makeConfig());
    expect(router.getClientForServer('nonexistent')).toBeNull();
  });

  it('returns client when server is healthy and has replicas', () => {
    const client = makeMockClient();
    const serverInfoMap = new Map([
      ['server-a', { health: { healthy: true }, tools: [] }],
    ]);
    const healthyReplicas = new Map([['server-a', [{ client }]]]);
    const registry = makeRegistry({ serverInfoMap, healthyReplicas });

    const router = new ConduitRouter(registry, new Map(), makeConfig());
    expect(router.getClientForServer('server-a')).toBe(client);
  });
});

describe('ConduitRouter error builders', () => {
  it('buildToolNotFoundError returns METHOD_NOT_FOUND error', () => {
    const registry = makeRegistry({});
    const router = new ConduitRouter(registry, new Map(), makeConfig());

    const result = router.buildToolNotFoundError(42, 'missing_tool') as {
      id: number; error: { code: number; message: string };
    };

    expect(result.id).toBe(42);
    expect(result.error.code).toBe(-32601); // METHOD_NOT_FOUND
    expect(result.error.message).toContain('missing_tool');
  });

  it('buildServerUnavailableError returns INTERNAL_ERROR', () => {
    const registry = makeRegistry({});
    const router = new ConduitRouter(registry, new Map(), makeConfig());

    const result = router.buildServerUnavailableError('req-1', 'server-a') as {
      id: string; error: { code: number; message: string };
    };

    expect(result.id).toBe('req-1');
    expect(result.error.code).toBe(-32603); // INTERNAL_ERROR
    expect(result.error.message).toContain('server-a');
  });

  it('buildToolNotFoundError works with null id', () => {
    const registry = makeRegistry({});
    const router = new ConduitRouter(registry, new Map(), makeConfig());
    const result = router.buildToolNotFoundError(null, 'tool') as { id: null };
    expect(result.id).toBeNull();
  });
});
