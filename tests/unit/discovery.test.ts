/**
 * Tests unitaires pour le système de service discovery.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpRegistryBackend } from '../../src/discovery/http-registry.js';
import { DiscoveryManager } from '../../src/discovery/manager.js';
import type { DiscoveryBackend, DiscoveredServer, DiscoveryConfig } from '../../src/discovery/types.js';
import type { ServerRegistry } from '../../src/router/registry.js';
import type { IMcpClient } from '../../src/proxy/mcp-client-interface.js';

// ─── HttpRegistryBackend ──────────────────────────────────────────────

describe('HttpRegistryBackend', () => {
  it('registers and polls a server', async () => {
    const backend = new HttpRegistryBackend(60);
    backend.register({ id: 'srv-1', url: 'http://localhost:3000/mcp' });

    const servers = await backend.poll();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe('srv-1');
  });

  it('deregisters a server', async () => {
    const backend = new HttpRegistryBackend(60);
    backend.register({ id: 'srv-1', url: 'http://localhost:3000/mcp' });
    backend.deregister('srv-1');

    const servers = await backend.poll();
    expect(servers).toHaveLength(0);
  });

  it('removes stale servers on poll', async () => {
    // Use a very short stale timeout
    const backend = new HttpRegistryBackend(0.001); // 1ms
    backend.register({ id: 'srv-1', url: 'http://localhost:3000/mcp' });

    // Wait for it to go stale
    await new Promise((r) => setTimeout(r, 10));

    const servers = await backend.poll();
    expect(servers).toHaveLength(0);
  });

  it('refreshes heartbeat on re-register', async () => {
    const backend = new HttpRegistryBackend(60);
    backend.register({ id: 'srv-1', url: 'http://localhost:3000/mcp' });
    backend.register({ id: 'srv-1', url: 'http://localhost:3000/mcp' }); // heartbeat

    const servers = await backend.poll();
    expect(servers).toHaveLength(1);
  });

  it('reports size correctly', () => {
    const backend = new HttpRegistryBackend(60);
    expect(backend.size).toBe(0);
    backend.register({ id: 'a', url: 'http://a' });
    backend.register({ id: 'b', url: 'http://b' });
    expect(backend.size).toBe(2);
  });
});

// ─── DiscoveryManager ─────────────────────────────────────────────────

describe('DiscoveryManager', () => {
  let mockBackend: DiscoveryBackend;
  let mockRegistry: ServerRegistry;
  let clients: Map<string, IMcpClient>;
  let discoveredServers: DiscoveredServer[];

  beforeEach(() => {
    discoveredServers = [];
    mockBackend = {
      name: 'mock',
      poll: vi.fn(async () => discoveredServers),
    };

    mockRegistry = {
      addServer: vi.fn(async () => {}),
      removeServer: vi.fn(() => true),
      getServerInfo: vi.fn(() => null),
    } as unknown as ServerRegistry;

    clients = new Map();
  });

  function makeManager(config?: Partial<DiscoveryConfig>): DiscoveryManager {
    return new DiscoveryManager(
      {
        enabled: true,
        poll_interval_seconds: 999, // We'll call reconcile() manually
        stale_timeout_seconds: 90,
        default_cache: { default_ttl: 60 },
        backends: [],
        ...config,
      },
      [mockBackend],
      mockRegistry,
      clients,
      [], // no static servers
    );
  }

  it('adds discovered servers on reconcile', async () => {
    const manager = makeManager();
    discoveredServers = [{ id: 'new-srv', url: 'http://new:3000/mcp' }];

    const result = await manager.reconcile();
    expect(result.added).toEqual(['new-srv']);
    expect(result.removed).toEqual([]);
    expect(mockRegistry.addServer).toHaveBeenCalledOnce();
    expect(manager.managedCount).toBe(1);
  });

  it('removes servers that disappear from discovery', async () => {
    const manager = makeManager();

    // First: discover a server
    discoveredServers = [{ id: 'temp-srv', url: 'http://temp:3000/mcp' }];
    await manager.reconcile();
    expect(manager.managedCount).toBe(1);

    // Second: server disappears
    discoveredServers = [];
    const result = await manager.reconcile();
    expect(result.removed).toEqual(['temp-srv']);
    expect(manager.managedCount).toBe(0);
    expect(mockRegistry.removeServer).toHaveBeenCalledWith('temp-srv');
  });

  it('does not re-add an already managed server', async () => {
    const manager = makeManager();
    discoveredServers = [{ id: 'srv-1', url: 'http://srv:3000/mcp' }];

    await manager.reconcile();
    await manager.reconcile(); // second poll, same server

    expect(mockRegistry.addServer).toHaveBeenCalledTimes(1);
  });

  it('ignores statically configured servers', async () => {
    const manager = new DiscoveryManager(
      {
        enabled: true,
        poll_interval_seconds: 999,
        stale_timeout_seconds: 90,
        default_cache: { default_ttl: 60 },
        backends: [],
      },
      [mockBackend],
      mockRegistry,
      clients,
      [{ id: 'static-srv', url: 'http://static:3000/mcp', cache: { default_ttl: 60 } }],
    );

    discoveredServers = [{ id: 'static-srv', url: 'http://static:3000/mcp' }];
    const result = await manager.reconcile();
    expect(result.added).toEqual([]);
    expect(mockRegistry.addServer).not.toHaveBeenCalled();
  });

  it('handles backend poll failure gracefully', async () => {
    const failingBackend: DiscoveryBackend = {
      name: 'failing',
      poll: vi.fn(async () => { throw new Error('poll failed'); }),
    };

    const manager = new DiscoveryManager(
      {
        enabled: true,
        poll_interval_seconds: 999,
        stale_timeout_seconds: 90,
        default_cache: { default_ttl: 60 },
        backends: [],
      },
      [failingBackend],
      mockRegistry,
      clients,
      [],
    );

    // Should not throw
    const result = await manager.reconcile();
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('reports managed IDs', async () => {
    const manager = makeManager();
    discoveredServers = [
      { id: 'a', url: 'http://a/mcp' },
      { id: 'b', url: 'http://b/mcp' },
    ];

    await manager.reconcile();
    expect(manager.getManagedIds().sort()).toEqual(['a', 'b']);
  });
});
