/**
 * Tests unitaires pour StdioMcpClient.
 * Utilise le mock-stdio-server.ts comme processus enfant réel.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { StdioMcpClient } from '../../src/proxy/stdio-mcp-client.js';
import type { ServerConfig } from '../../src/config/types.js';

const MOCK_SERVER_PATH = resolve(import.meta.dirname, '../e2e/mock-stdio-server.ts');

function makeConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    id: 'test-stdio',
    url: 'stdio://tsx',
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', MOCK_SERVER_PATH],
    cache: { default_ttl: 0 },
    ...overrides,
  };
}

describe('StdioMcpClient', () => {
  let client: StdioMcpClient;

  afterEach(async () => {
    if (client) {
      await client.shutdown();
    }
  });

  it('can forward an initialize request', async () => {
    client = new StdioMcpClient(makeConfig());
    const response = await client.forward({
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.isStream).toBe(false);
    const body = response.body as Record<string, unknown>;
    const result = body['result'] as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2024-11-05');
  });

  it('can call tools/list', async () => {
    client = new StdioMcpClient(makeConfig());
    const response = await client.forward({
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });

    const body = response.body as Record<string, unknown>;
    const result = body['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<{ name: string }>;
    expect(tools.length).toBe(2);
    expect(tools.map((t) => t.name)).toContain('echo');
    expect(tools.map((t) => t.name)).toContain('add');
  });

  it('can call tools/call echo', async () => {
    client = new StdioMcpClient(makeConfig());
    const response = await client.forward({
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'hello world' } },
      },
    });

    const body = response.body as Record<string, unknown>;
    const result = body['result'] as Record<string, unknown>;
    const content = result['content'] as Array<{ text: string }>;
    expect(content[0]?.text).toBe('hello world');
  });

  it('can call tools/call add', async () => {
    client = new StdioMcpClient(makeConfig());
    const response = await client.forward({
      body: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'add', arguments: { a: 3, b: 7 } },
      },
    });

    const body = response.body as Record<string, unknown>;
    const result = body['result'] as Record<string, unknown>;
    const content = result['content'] as Array<{ text: string }>;
    expect(content[0]?.text).toBe('10');
  });

  it('handles multiple concurrent requests', async () => {
    client = new StdioMcpClient(makeConfig());
    const promises = Array.from({ length: 10 }, (_, i) =>
      client.forward({
        body: {
          jsonrpc: '2.0',
          id: 100 + i,
          method: 'tools/call',
          params: { name: 'add', arguments: { a: i, b: 1 } },
        },
      }),
    );

    const results = await Promise.all(promises);
    for (let i = 0; i < 10; i++) {
      const body = results[i]!.body as Record<string, unknown>;
      const result = body['result'] as Record<string, unknown>;
      const content = result['content'] as Array<{ text: string }>;
      expect(content[0]?.text).toBe(String(i + 1));
    }
  });

  it('reports activeConnections correctly', async () => {
    client = new StdioMcpClient(makeConfig());
    expect(client.activeConnections).toBe(0);

    // During a request, activeConnections should be > 0
    const promise = client.forward({
      body: { jsonrpc: '2.0', id: 50, method: 'initialize', params: {} },
    });

    // After awaiting, back to 0
    await promise;
    expect(client.activeConnections).toBe(0);
  });

  it('throws for openSseStream', async () => {
    client = new StdioMcpClient(makeConfig());
    await expect(client.openSseStream()).rejects.toThrow('SSE streams are not supported');
  });

  it('treats notifications as no-response writes instead of forcing a synthetic id', async () => {
    client = new StdioMcpClient(makeConfig());
    const response = await client.forward({
      body: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    });

    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
    expect(response.isStream).toBe(false);
  });

  it('exposes serverId and serverUrl', () => {
    client = new StdioMcpClient(makeConfig());
    expect(client.serverId).toBe('test-stdio');
    expect(client.serverUrl).toBe('stdio://tsx');
  });

  it('rejects pending requests when process is shut down', async () => {
    client = new StdioMcpClient(makeConfig());
    // Initialize to spawn process
    await client.forward({ body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });

    await client.shutdown();

    await expect(
      client.forward({ body: { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} } }),
    ).rejects.toThrow('shut down');
  });
});
