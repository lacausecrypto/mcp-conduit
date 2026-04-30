/**
 * Tests e2e — Dashboard API connectivity.
 *
 * Verifies that ALL admin API endpoints called by the dashboard
 * respond correctly with the expected response format.
 * This catches format mismatches between frontend and backend.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  setup,
  teardown,
  sendMcpRequest,
  makeToolCallMessage,
  makeToolsListMessage,
  type E2eTestContext,
} from './setup.js';

describe('Dashboard API connectivity', () => {
  let ctx: E2eTestContext;
  let registryServer: Server;
  let secretRemoteServer: Server;
  let registryBaseUrl = '';
  let registryRemoteUrl = 'http://127.0.0.1:65535/mcp';
  let secretRegistryRemoteUrl = 'http://127.0.0.1:65534/mcp';

  beforeAll(async () => {
    secretRemoteServer = createServer((req, res) => {
      const authHeader = req.headers['x-api-key'];
      if (req.url !== '/mcp' || authHeader !== 'phase-secret') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        const id = body['id'] ?? 1;
        const method = body['method'];
        if (method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'secret-remote', version: '1.0.0' },
            },
          }));
          return;
        }

        if (method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: 'secured_tool',
                  description: 'Requires propagated header',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unsupported method' }));
      });
    });

    await new Promise<void>((resolve) => {
      secretRemoteServer.listen(0, '127.0.0.1', () => {
        const address = secretRemoteServer.address();
        if (address && typeof address !== 'string') {
          secretRegistryRemoteUrl = `http://127.0.0.1:${address.port}/mcp`;
        }
        resolve();
      });
    });

    registryServer = createServer((req, res) => {
      if (req.url?.startsWith('/v0.1/servers')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          servers: [
            {
              server: {
                name: 'io.github.example/registry-remote',
                title: 'Registry Remote',
                description: 'Importable remote MCP server',
                version: '1.0.0',
                repository: { url: 'https://github.com/example/registry-remote', source: 'github' },
                remotes: [{ type: 'streamable-http', url: registryRemoteUrl }],
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
                name: 'io.github.example/manual-needs-secret',
                title: 'Manual Secret',
                description: 'Needs a header before it can be imported',
                version: '1.1.0',
                repository: { url: 'https://github.com/example/manual-needs-secret', source: 'github' },
                remotes: [{
                  type: 'streamable-http',
                  url: secretRegistryRemoteUrl,
                  headers: [{ name: 'X-API-Key', isRequired: true }],
                }],
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
          ],
          metadata: { count: 2 },
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => {
      registryServer.listen(0, '127.0.0.1', () => {
        const address = registryServer.address();
        if (address && typeof address !== 'string') {
          registryBaseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });

    ctx = await setup({
      connect: {
        registry: {
          base_url: registryBaseUrl,
          cache_ttl_seconds: 3600,
          page_size: 100,
          max_pages: 1,
          latest_only: true,
        },
      },
    });
    registryRemoteUrl = ctx.mockServer.url;
    // Generate some data for stats
    await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '1' }));
    await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '1' }));
  });

  afterAll(async () => {
    await teardown(ctx);
    await new Promise<void>((resolve, reject) => secretRemoteServer.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => registryServer.close((error) => error ? reject(error) : resolve()));
  });

  // ─── Endpoints the dashboard calls ──────────────────────────

  it('GET /conduit/health returns expected shape', async () => {
    const res = await ctx.app.request('/conduit/health');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('uptime_seconds');
    expect(body).toHaveProperty('backends');
    expect(Array.isArray(body['backends'])).toBe(true);
  });

  it('GET /conduit/stats returns requests + cache + servers', async () => {
    const res = await ctx.app.request('/conduit/stats');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('requests');
    expect(body).toHaveProperty('cache');
    expect(body).toHaveProperty('inflight');
    expect(body).toHaveProperty('servers');

    // Cache stats should have flat L1 properties (used by Overview)
    const cache = body['cache'] as Record<string, unknown>;
    expect(cache).toHaveProperty('hits');
    expect(cache).toHaveProperty('misses');
    expect(cache).toHaveProperty('hitRate');
  });

  it('GET /conduit/cache/stats returns { l1: {...} } format', async () => {
    const res = await ctx.app.request('/conduit/cache/stats');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // Dashboard does c.value.l1 || c.value to unwrap
    expect(body).toHaveProperty('l1');
    const l1 = body['l1'] as Record<string, unknown>;
    expect(l1).toHaveProperty('hits');
    expect(l1).toHaveProperty('misses');
    expect(l1).toHaveProperty('hitRate');
    expect(l1).toHaveProperty('entries');
  });

  it('GET /conduit/circuits returns { circuits: [...] }', async () => {
    const res = await ctx.app.request('/conduit/circuits');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('circuits');
    expect(Array.isArray(body['circuits'])).toBe(true);
  });

  it('GET /conduit/logs returns { logs: [...], count, limit, offset }', async () => {
    const res = await ctx.app.request('/conduit/logs');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('logs');
    expect(body).toHaveProperty('count');
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
    expect(Array.isArray(body['logs'])).toBe(true);
  });

  it('GET /conduit/servers returns { servers: [...] }', async () => {
    const res = await ctx.app.request('/conduit/servers');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('servers');
    const servers = body['servers'] as Array<Record<string, unknown>>;
    expect(servers.length).toBeGreaterThan(0);
    expect(servers[0]).toHaveProperty('id');
    expect(servers[0]).toHaveProperty('healthy');
    expect(servers[0]).toHaveProperty('tools');
  });

  it('GET /conduit/limits returns { enabled, buckets }', async () => {
    const res = await ctx.app.request('/conduit/limits');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('enabled');
    expect(body).toHaveProperty('buckets');
  });

  it('GET /conduit/settings returns a redacted config snapshot', async () => {
    const res = await ctx.app.request('/conduit/settings');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('runtime');
    expect(body).toHaveProperty('gateway');
    expect(body).toHaveProperty('routing');
    expect(body).toHaveProperty('security');
    expect(body).toHaveProperty('caching');
    expect(body).toHaveProperty('connect');

    const connect = body['connect'] as Record<string, unknown>;
    expect(Array.isArray(connect['profiles'])).toBe(true);
  });

  it('GET /conduit/acl/check returns allowed/denied', async () => {
    const res = await ctx.app.request('/conduit/acl/check?client=test&server=test-server&tool=get_contact');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('allowed');
  });

  it('GET /conduit/connect/catalog returns profiles and targets', async () => {
    const res = await ctx.app.request('/conduit/connect/catalog');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('profiles');
    expect(body).toHaveProperty('targets');
    expect(body).toHaveProperty('identity');
    expect(Array.isArray(body['profiles'])).toBe(true);
    expect(Array.isArray(body['targets'])).toBe(true);
    expect((body['targets'] as Array<Record<string, unknown>>).some((target) => target['id'] === 'claude-desktop')).toBe(true);
    expect((body['targets'] as Array<Record<string, unknown>>).some((target) => target['id'] === 'codex')).toBe(true);
    expect((body['targets'] as Array<Record<string, unknown>>).some((target) => target['id'] === 'claude' && target['delivery'] === 'remote-connector')).toBe(true);
    expect((body['targets'] as Array<Record<string, unknown>>).some((target) => target['id'] === 'chatgpt' && target['delivery'] === 'remote-connector')).toBe(true);
    expect((body['identity'] as Record<string, unknown>)).toHaveProperty('profiles');
  });

  it('GET /conduit/connect/import/catalog returns import templates', async () => {
    const res = await ctx.app.request('/conduit/connect/import/catalog');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Array.isArray(body['templates'])).toBe(true);
  });

  it('GET /conduit/connect/registry/library returns official registry items and stats', async () => {
    const res = await ctx.app.request('/conduit/connect/registry/library');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('source');
    expect(body).toHaveProperty('stats');
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('pagination');
    expect(Array.isArray(body['items'])).toBe(true);
    expect((body['items'] as Array<Record<string, unknown>>)[0]).toHaveProperty('score');
    expect((body['filters'] as Record<string, unknown>)).toHaveProperty('runtime_statuses');
    expect((body['filters'] as Record<string, unknown>)).toHaveProperty('policy_fit_statuses');
    expect((body['filters'] as Record<string, unknown>)).toHaveProperty('targets');
    const manualItem = (body['items'] as Array<Record<string, unknown>>)
      .find((item) => item['name'] === 'io.github.example/manual-needs-secret');
    expect(manualItem).toHaveProperty('configurable_import', true);
    expect(manualItem).toHaveProperty('import_requirements');
    expect(manualItem).toHaveProperty('verified_publisher', true);
    expect(manualItem).toHaveProperty('smart');
    expect((manualItem?.['smart'] as Record<string, unknown>)).toHaveProperty('trust');
    expect((manualItem?.['smart'] as Record<string, unknown>)).toHaveProperty('runtime');
    expect((manualItem?.['smart'] as Record<string, unknown>)).toHaveProperty('policy_fit');
    expect((manualItem?.['smart'] as Record<string, unknown>)).toHaveProperty('compatibility');
    expect((manualItem?.['smart'] as Record<string, unknown>)).toHaveProperty('recommendation');
  });

  it('GET /conduit/connect/registry/library supports relevance search and pagination', async () => {
    const relevanceRes = await ctx.app.request('/conduit/connect/registry/library?search=x-api-key&sort=relevance&limit=1');
    expect(relevanceRes.status).toBe(200);
    const relevanceBody = await relevanceRes.json() as Record<string, unknown>;
    const relevanceItems = relevanceBody['items'] as Array<Record<string, unknown>>;
    const relevancePagination = relevanceBody['pagination'] as Record<string, unknown>;

    expect(relevanceItems).toHaveLength(1);
    expect(relevanceItems[0]?.['name']).toBe('io.github.example/manual-needs-secret');
    expect(relevancePagination['limit']).toBe(1);
    expect(relevancePagination['offset']).toBe(0);
    expect(relevanceItems[0]?.['requirement_keys']).toContain('X-API-Key');

    const paginationRes = await ctx.app.request('/conduit/connect/registry/library?search=example&sort=relevance&limit=1');
    expect(paginationRes.status).toBe(200);
    const paginationBody = await paginationRes.json() as Record<string, unknown>;
    const pagination = paginationBody['pagination'] as Record<string, unknown>;
    expect(pagination['has_more']).toBe(true);
    expect(pagination['next_offset']).toBe(1);
  });

  it('GET /conduit/connect/export returns a generated snippet', async () => {
    const res = await ctx.app.request('/conduit/connect/export?target=cursor&profile=default&scope=project');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('title');
    expect(body).toHaveProperty('snippet');
    expect(body).toHaveProperty('servers');
    expect(body).toHaveProperty('identity_preflight');
    expect(body['snippet']).toMatch(/mcpServers/);
  });

  it('POST /mcp/profile/default initializes a Conduit-controlled profile endpoint', async () => {
    const res = await ctx.app.request('/mcp/profile/default', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'profile-test', version: '1.0.0' },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe('conduit-profile-default');
    const body = await res.json() as Record<string, unknown>;
    expect((body['result'] as Record<string, unknown>)['protocolVersion']).toBe('2024-11-05');
  });

  it('POST /mcp/profile/default aggregates tools and routes tool calls through Conduit', async () => {
    const listRes = await ctx.app.request('/mcp/profile/default', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(makeToolsListMessage()),
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as Record<string, unknown>;
    const tools = ((listBody['result'] as Record<string, unknown>)['tools'] as Array<Record<string, unknown>> | undefined) ?? [];
    expect(tools.some((tool) => tool['name'] === 'get_contact')).toBe(true);

    const callRes = await ctx.app.request('/mcp/profile/default', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(makeToolCallMessage('get_contact', { id: '1' })),
    });
    expect(callRes.status).toBe(200);
    const callBody = await callRes.json() as Record<string, unknown>;
    expect(callBody).toHaveProperty('result');
  });

  it('POST /conduit/connect/install/session returns a bundle handle', async () => {
    const res = await ctx.app.request('/conduit/connect/install/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Conduit-Admin': 'true',
      },
      body: JSON.stringify({
        target: 'cursor',
        profile: 'default',
        scope: 'user',
        base_url: 'http://127.0.0.1:8080',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('bundle_url');
    expect(body).toHaveProperty('install_command');
    expect(body).toHaveProperty('identity_preflight');
  });

  it('POST /conduit/connect/remote/session returns a remote connector handoff', async () => {
    const res = await ctx.app.request('/conduit/connect/remote/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Conduit-Admin': 'true',
      },
      body: JSON.stringify({
        target: 'claude',
        profile: 'default',
        scope: 'user',
        base_url: 'https://conduit.example.com',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('delivery', 'remote-connector');
    expect(body).toHaveProperty('profile_url', 'https://conduit.example.com/mcp/profile/default');
    expect(body).toHaveProperty('bundle_url');
    expect(body).toHaveProperty('settings_url', 'https://claude.ai/settings/connectors');
  });

  it('POST /conduit/connect/registry/refresh refreshes the cached official registry view', async () => {
    const res = await ctx.app.request('/conduit/connect/registry/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Conduit-Admin': 'true',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('synced_at');
  });

  it('POST /conduit/connect/import imports a descriptor into the running gateway', async () => {
    const res = await ctx.app.request('/conduit/connect/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Conduit-Admin': 'true',
      },
      body: JSON.stringify({
        descriptor: {
          version: 1,
          name: 'Imported bundle',
          servers: [{
            id: 'imported-http',
            url: ctx.mockServer.url,
            cache: { default_ttl: 60 },
            profile_ids: ['imported-profile'],
          }],
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('imported_servers');
    expect(body['imported_servers']).toContain('imported-http');

    const serversRes = await ctx.app.request('/conduit/servers');
    const serversBody = await serversRes.json() as Record<string, Array<Record<string, unknown>>>;
    expect(serversBody['servers']?.some((server) => server['id'] === 'imported-http')).toBe(true);

    const catalogRes = await ctx.app.request('/conduit/connect/catalog');
    const catalogBody = await catalogRes.json() as Record<string, Array<Record<string, unknown>>>;
    expect(catalogBody['profiles']?.some((profile) => profile['id'] === 'imported-profile')).toBe(true);
  });

  it('POST /conduit/connect/registry/import imports an official registry server into the running gateway', async () => {
    const res = await ctx.app.request('/conduit/connect/registry/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Conduit-Admin': 'true',
      },
      body: JSON.stringify({
        server_name: 'io.github.example/registry-remote',
        profile_id: 'official-registry',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body['imported_servers']).toContain('io-github-example-registry-remote');
    expect(body).toHaveProperty('server_identity_preflight');

    const serversRes = await ctx.app.request('/conduit/servers');
    const serversBody = await serversRes.json() as Record<string, Array<Record<string, unknown>>>;
    expect(serversBody['servers']?.some((server) => server['id'] === 'io-github-example-registry-remote')).toBe(true);

    const libraryRes = await ctx.app.request('/conduit/connect/registry/library?runtime_status=healthy');
    expect(libraryRes.status).toBe(200);
    const libraryBody = await libraryRes.json() as Record<string, Array<Record<string, unknown>>>;
    expect(libraryBody['items']?.some((item) => item['name'] === 'io.github.example/registry-remote')).toBe(true);
  });

  it('POST /conduit/connect/registry/import imports a needs-config registry server when required headers are supplied', async () => {
    const res = await ctx.app.request('/conduit/connect/registry/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Conduit-Admin': 'true',
      },
      body: JSON.stringify({
        server_name: 'io.github.example/manual-needs-secret',
        profile_id: 'official-manual',
        headers: { 'X-API-Key': 'phase-secret' },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body['imported_servers']).toContain('io-github-example-manual-needs-secret');
    expect(body).toHaveProperty('server_identity_preflight');

    const toolsRes = await sendMcpRequest(ctx.app, 'io-github-example-manual-needs-secret', makeToolsListMessage());
    expect(toolsRes.status).toBe(200);
    const toolsBody = await toolsRes.json() as Record<string, unknown>;
    expect(toolsBody).toHaveProperty('result');
  });

  it('POST /conduit/connect/registry/install creates an install bundle directly from a registry entry', async () => {
    const res = await ctx.app.request('/conduit/connect/registry/install', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Conduit-Admin': 'true',
      },
      body: JSON.stringify({
        server_name: 'io.github.example/manual-needs-secret',
        target: 'cursor',
        scope: 'user',
        headers: { 'X-API-Key': 'phase-secret' },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('profile_id', 'registry-io-github-example-manual-needs-secret');
    expect(body).toHaveProperty('install_session');
    expect(body).toHaveProperty('identity_preflight');
    expect(body).toHaveProperty('server_identity_preflight');

    const session = body['install_session'] as Record<string, string>;
    expect(session).toHaveProperty('bundle_url');
    expect(session).toHaveProperty('identity_preflight');
    const bundlePath = new URL(String(session['bundle_url'])).pathname;
    const bundleRes = await ctx.app.request(bundlePath);
    expect(bundleRes.status).toBe(200);
    const bundle = await bundleRes.json() as Record<string, unknown>;
    expect(bundle).toHaveProperty('profile', 'registry-io-github-example-manual-needs-secret');
    expect(bundle).toHaveProperty('servers');
    expect(bundle).toHaveProperty('identity_preflight');
  });

  it('POST /conduit/connect/registry/install creates a remote handoff for remote connector targets', async () => {
    const res = await ctx.app.request('/conduit/connect/registry/install', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Conduit-Admin': 'true',
      },
      body: JSON.stringify({
        server_name: 'io.github.example/registry-remote',
        target: 'claude',
        scope: 'user',
        base_url: 'https://conduit.example.com',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('target_delivery', 'remote-connector');
    expect(body).toHaveProperty('remote_session');
    expect(body).not.toHaveProperty('install_session');

    const session = body['remote_session'] as Record<string, string>;
    expect(session).toHaveProperty('profile_url', 'https://conduit.example.com/mcp/profile/registry-io-github-example-registry-remote');
    const bundlePath = new URL(String(session['bundle_url'])).pathname;
    const bundleRes = await ctx.app.request(bundlePath);
    expect(bundleRes.status).toBe(200);
    const bundle = await bundleRes.json() as Record<string, unknown>;
    expect(bundle).toHaveProperty('delivery', 'remote-connector');
  });

  // ─── CSRF protection on mutations ───────────────────────────

  it('DELETE /conduit/cache/server/:id requires X-Conduit-Admin header', async () => {
    const res = await ctx.app.request('/conduit/cache/server/test-server', {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });

  it('DELETE /conduit/cache/server/:id works WITH X-Conduit-Admin header', async () => {
    const res = await ctx.app.request('/conduit/cache/server/test-server', {
      method: 'DELETE',
      headers: { 'X-Conduit-Admin': 'true' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('deleted_count');
  });

  // ─── Dashboard HTML serves API_BASE correctly ───────────────

  it('dashboard HTML contains API_BASE = /conduit', async () => {
    const res = await ctx.app.request('/conduit/dashboard');
    const html = await res.text();
    expect(html).toMatch(/API_BASE\s*=\s*['"]\/conduit['"]/);
  });

  it('dashboard HTML contains X-Conduit-Admin CSRF header', async () => {
    const res = await ctx.app.request('/conduit/dashboard');
    const html = await res.text();
    expect(html).toContain('X-Conduit-Admin');
  });
});

describe('Dashboard install bundles with admin auth', () => {
  let ctx: E2eTestContext;
  const ADMIN_KEY = 'admin-phase-2';

  beforeAll(async () => {
    ctx = await setup({ adminKey: ADMIN_KEY });
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('GET /conduit/connect/install/bundles/:token stays accessible without admin auth', async () => {
    const createRes = await ctx.app.request('/conduit/connect/install/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_KEY}`,
        'X-Conduit-Admin': 'true',
      },
      body: JSON.stringify({
        target: 'cursor',
        profile: 'default',
        scope: 'user',
        base_url: 'http://127.0.0.1:8080',
      }),
    });

    expect(createRes.status).toBe(201);
    const session = await createRes.json() as Record<string, string>;
    const bundlePath = new URL(String(session['bundle_url'])).pathname;

    const bundleRes = await ctx.app.request(bundlePath);
    expect(bundleRes.status).toBe(200);
    const bundle = await bundleRes.json() as Record<string, unknown>;
    expect(bundle).toHaveProperty('transport', 'stdio-relay');
    expect(bundle).toHaveProperty('servers');
    expect(bundle).toHaveProperty('identity_preflight');
  });
});
