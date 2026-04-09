import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the concrete client classes BEFORE importing the factory
vi.mock('../../src/proxy/mcp-client.js', () => {
  class MockMcpClient {
    private readonly server;
    private sessionId: string | undefined;
    private _activeConnections = 0;
    private _circuitBreaker: unknown;

    constructor(server: any) {
      this.server = server;
    }

    async forward() { return { status: 200, headers: {}, isStream: false }; }
    async openSseStream() { return new Response(); }
    getSessionId() { return this.sessionId; }
    setSessionId(id: string) { this.sessionId = id; }
    setCircuitBreaker(cb: unknown) { this._circuitBreaker = cb; }
    getCircuitBreaker() { return this._circuitBreaker; }
    get activeConnections() { return this._activeConnections; }
    get serverId() { return this.server.id; }
    get serverUrl() { return this.server.url; }
  }
  return { McpClient: MockMcpClient };
});

vi.mock('../../src/proxy/stdio-mcp-client.js', () => {
  class MockStdioMcpClient {
    private readonly server;
    private sessionId: string | undefined;
    private _activeConnections = 0;
    private _circuitBreaker: unknown;

    constructor(server: any) {
      this.server = server;
    }

    async forward() { return { status: 200, headers: {}, isStream: false }; }
    async openSseStream() { throw new Error('SSE not supported for stdio'); }
    getSessionId() { return this.sessionId; }
    setSessionId(id: string) { this.sessionId = id; }
    setCircuitBreaker(cb: unknown) { this._circuitBreaker = cb; }
    getCircuitBreaker() { return this._circuitBreaker; }
    get activeConnections() { return this._activeConnections; }
    get serverId() { return this.server.id; }
    get serverUrl() { return this.server.url; }

    // stdio-specific
    get command() { return this.server.command; }
    get args() { return this.server.args; }
  }
  return { StdioMcpClient: MockStdioMcpClient };
});

import { createMcpClient } from '../../src/proxy/client-factory.js';
import { McpClient } from '../../src/proxy/mcp-client.js';
import { StdioMcpClient } from '../../src/proxy/stdio-mcp-client.js';
import type { ServerConfig } from '../../src/config/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHttpConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'http-server',
    url: 'http://localhost:3001/mcp',
    cache: { default_ttl: 60 },
    ...overrides,
  };
}

function makeStdioConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'stdio-server',
    url: 'stdio://my-tool',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@my/mcp-tool'],
    cache: { default_ttl: 120 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createMcpClient', () => {
  // ── Default transport (http) ────────────────────────────────────────────
  describe('default transport (http)', () => {
    it('returns McpClient when transport is undefined', () => {
      const config = makeHttpConfig({ transport: undefined });
      const client = createMcpClient(config);
      expect(client).toBeInstanceOf(McpClient);
    });

    it('returns McpClient when transport field is missing entirely', () => {
      const config = makeHttpConfig();
      delete (config as any).transport;
      const client = createMcpClient(config);
      expect(client).toBeInstanceOf(McpClient);
    });

    it('returns McpClient when transport is explicitly "http"', () => {
      const config = makeHttpConfig({ transport: 'http' });
      const client = createMcpClient(config);
      expect(client).toBeInstanceOf(McpClient);
    });
  });

  // ── stdio transport ─────────────────────────────────────────────────────
  describe('stdio transport', () => {
    it('returns StdioMcpClient when transport is "stdio"', () => {
      const config = makeStdioConfig();
      const client = createMcpClient(config);
      expect(client).toBeInstanceOf(StdioMcpClient);
    });

    it('passes config to StdioMcpClient constructor', () => {
      const config = makeStdioConfig({ id: 'custom-stdio' });
      const client = createMcpClient(config);
      expect(client.serverId).toBe('custom-stdio');
    });
  });

  // ── Unknown transport ───────────────────────────────────────────────────
  describe('unknown transport', () => {
    it('throws for unknown transport type', () => {
      const config = makeHttpConfig({ transport: 'grpc' as any });
      expect(() => createMcpClient(config)).toThrow();
    });

    it('error message contains the unknown transport name', () => {
      const config = makeHttpConfig({ transport: 'websocket' as any });
      expect(() => createMcpClient(config)).toThrow(/websocket/);
    });

    it('error message contains the server id', () => {
      const config = makeHttpConfig({ id: 'my-server', transport: 'foo' as any });
      expect(() => createMcpClient(config)).toThrow(/my-server/);
    });

    it('error message matches expected format', () => {
      const config = makeHttpConfig({ id: 'srv', transport: 'xyz' as any });
      expect(() => createMcpClient(config)).toThrow(
        'Transport inconnu "xyz" pour le serveur "srv"',
      );
    });
  });

  // ── Returned client properties ──────────────────────────────────────────
  describe('returned client properties', () => {
    it('McpClient has correct serverId', () => {
      const client = createMcpClient(makeHttpConfig({ id: 'test-id' }));
      expect(client.serverId).toBe('test-id');
    });

    it('McpClient has correct serverUrl', () => {
      const client = createMcpClient(makeHttpConfig({ url: 'http://example.com/mcp' }));
      expect(client.serverUrl).toBe('http://example.com/mcp');
    });

    it('StdioMcpClient has correct serverId', () => {
      const client = createMcpClient(makeStdioConfig({ id: 'my-stdio' }));
      expect(client.serverId).toBe('my-stdio');
    });

    it('StdioMcpClient has correct serverUrl', () => {
      const client = createMcpClient(makeStdioConfig({ url: 'stdio://custom' }));
      expect(client.serverUrl).toBe('stdio://custom');
    });

    it('activeConnections starts at 0', () => {
      const client = createMcpClient(makeHttpConfig());
      expect(client.activeConnections).toBe(0);
    });

    it('getSessionId returns undefined initially', () => {
      const client = createMcpClient(makeHttpConfig());
      expect(client.getSessionId()).toBeUndefined();
    });

    it('setSessionId / getSessionId round-trip works', () => {
      const client = createMcpClient(makeHttpConfig());
      client.setSessionId('sess-123');
      expect(client.getSessionId()).toBe('sess-123');
    });

    it('getCircuitBreaker returns undefined initially', () => {
      const client = createMcpClient(makeHttpConfig());
      expect(client.getCircuitBreaker()).toBeUndefined();
    });

    it('setCircuitBreaker / getCircuitBreaker round-trip works', () => {
      const client = createMcpClient(makeHttpConfig());
      const fakeCb = { canExecute: () => true } as any;
      client.setCircuitBreaker(fakeCb);
      expect(client.getCircuitBreaker()).toBe(fakeCb);
    });
  });

  // ── IMcpClient interface compliance ─────────────────────────────────────
  describe('IMcpClient interface compliance', () => {
    it('McpClient has forward method', () => {
      const client = createMcpClient(makeHttpConfig());
      expect(typeof client.forward).toBe('function');
    });

    it('McpClient has openSseStream method', () => {
      const client = createMcpClient(makeHttpConfig());
      expect(typeof client.openSseStream).toBe('function');
    });

    it('McpClient has getSessionId method', () => {
      const client = createMcpClient(makeHttpConfig());
      expect(typeof client.getSessionId).toBe('function');
    });

    it('McpClient has setSessionId method', () => {
      const client = createMcpClient(makeHttpConfig());
      expect(typeof client.setSessionId).toBe('function');
    });

    it('McpClient has setCircuitBreaker method', () => {
      const client = createMcpClient(makeHttpConfig());
      expect(typeof client.setCircuitBreaker).toBe('function');
    });

    it('McpClient has getCircuitBreaker method', () => {
      const client = createMcpClient(makeHttpConfig());
      expect(typeof client.getCircuitBreaker).toBe('function');
    });

    it('StdioMcpClient has forward method', () => {
      const client = createMcpClient(makeStdioConfig());
      expect(typeof client.forward).toBe('function');
    });

    it('StdioMcpClient has openSseStream method', () => {
      const client = createMcpClient(makeStdioConfig());
      expect(typeof client.openSseStream).toBe('function');
    });

    it('StdioMcpClient has setCircuitBreaker method', () => {
      const client = createMcpClient(makeStdioConfig());
      expect(typeof client.setCircuitBreaker).toBe('function');
    });
  });

  // ── Multiple calls return independent instances ─────────────────────────
  describe('independent instances', () => {
    it('returns a new McpClient on each call', () => {
      const config = makeHttpConfig();
      const a = createMcpClient(config);
      const b = createMcpClient(config);
      expect(a).not.toBe(b);
    });

    it('returns a new StdioMcpClient on each call', () => {
      const config = makeStdioConfig();
      const a = createMcpClient(config);
      const b = createMcpClient(config);
      expect(a).not.toBe(b);
    });

    it('session state is not shared between instances', () => {
      const config = makeHttpConfig();
      const a = createMcpClient(config);
      const b = createMcpClient(config);
      a.setSessionId('session-A');
      expect(a.getSessionId()).toBe('session-A');
      expect(b.getSessionId()).toBeUndefined();
    });

    it('circuit breaker is not shared between instances', () => {
      const config = makeHttpConfig();
      const a = createMcpClient(config);
      const b = createMcpClient(config);
      const cb = { canExecute: () => true } as any;
      a.setCircuitBreaker(cb);
      expect(a.getCircuitBreaker()).toBe(cb);
      expect(b.getCircuitBreaker()).toBeUndefined();
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('handles config with all optional fields populated', () => {
      const config = makeHttpConfig({
        transport: 'http',
        replicas: ['http://replica1:3001/mcp', 'http://replica2:3001/mcp'],
        timeout_ms: 5000,
        cache: { default_ttl: 30, overrides: { search: { ttl: 10 } } },
      });
      const client = createMcpClient(config);
      expect(client).toBeInstanceOf(McpClient);
      expect(client.serverId).toBe('http-server');
    });

    it('handles stdio config with env variables', () => {
      const config = makeStdioConfig({
        env: { NODE_ENV: 'production', API_KEY: 'secret' },
      });
      const client = createMcpClient(config);
      expect(client).toBeInstanceOf(StdioMcpClient);
    });

    it('handles config with empty string id', () => {
      const config = makeHttpConfig({ id: '' });
      const client = createMcpClient(config);
      expect(client.serverId).toBe('');
    });

    it('handles config with very long url', () => {
      const longUrl = 'http://localhost:3001/' + 'a'.repeat(5000);
      const config = makeHttpConfig({ url: longUrl });
      const client = createMcpClient(config);
      expect(client.serverUrl).toBe(longUrl);
    });
  });
});
