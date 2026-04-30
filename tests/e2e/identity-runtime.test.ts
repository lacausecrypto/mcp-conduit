import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import { resetMetrics } from '../../src/observability/metrics.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { startMockMcpServer, type MockMcpServer } from './mock-mcp-server.js';
import { makeToolCallMessage } from './setup.js';

async function adminRequest(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return app.request(`/conduit${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Conduit-Admin': 'true',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function sendMcpRequest(
  app: Hono,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request('/mcp/test-server', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

describe('Identity runtime', () => {
  let gateway: ConduitGateway;
  let app: Hono;
  let mockServer: MockMcpServer;

  beforeEach(async () => {
    resetMetrics();
    mockServer = await startMockMcpServer(0);

    const config: ConduitGatewayConfig = {
      gateway: { port: 0, host: '127.0.0.1' },
      router: {
        namespace_strategy: 'none',
        health_check: {
          enabled: false,
          interval_seconds: 60,
          timeout_ms: 1000,
          unhealthy_threshold: 3,
          healthy_threshold: 1,
        },
        load_balancing: 'round-robin',
      },
      servers: [
        {
          id: 'test-server',
          url: mockServer.url,
          cache: { default_ttl: 0 },
          upstream_auth: {
            connected_account: {
              provider: 'github',
              binding: 'client',
            },
            forward_identity: {
              mode: 'claims-header',
            },
          },
        },
      ],
      cache: {
        enabled: false,
        l1: { max_entries: 100, max_entry_size_kb: 64 },
      },
      tenant_isolation: {
        enabled: false,
        header: 'Authorization',
      },
      observability: {
        log_args: true,
        log_responses: false,
        redact_fields: ['authorization', 'token', 'secret'],
        retention_days: 30,
        db_path: ':memory:',
      },
      metrics: {
        enabled: false,
        port: 0,
      },
      auth: {
        method: 'api-key',
        api_keys: [
          { key: 'sk-user', client_id: 'user-1', tenant_id: 'tenant-a' },
        ],
      },
      identity: {
        enabled: true,
        db_path: ':memory:',
        default_workspace_id: 'default',
        workspaces: [
          { id: 'workspace-a', tenant_ids: ['tenant-a'] },
        ],
      },
    };

    gateway = new ConduitGateway(config);
    await gateway.initialize();
    app = gateway.createApp();
  });

  afterEach(async () => {
    await gateway.stop();
    await mockServer.close();
  });

  it('injects connected account auth and forwarded identity headers upstream', async () => {
    const createRes = await adminRequest(app, 'POST', '/identity/accounts', {
      provider: 'github',
      workspace_id: 'workspace-a',
      client_id: 'user-1',
      label: 'GitHub user token',
      access_token: 'gho_user_token',
      replace_existing: true,
    });
    expect(createRes.status).toBe(201);

    const res = await sendMcpRequest(
      app,
      makeToolCallMessage('get_contact', { id: '123' }),
      { Authorization: 'Bearer sk-user' },
    );
    expect(res.status).toBe(200);

    const upstreamHeaders = mockServer.getLastHeaders('tools/call');
    expect(upstreamHeaders?.['authorization']).toBe('Bearer gho_user_token');
    expect(upstreamHeaders?.['x-conduit-identity']).toBeTruthy();
  });

  it('fails closed once the connected account is revoked', async () => {
    const createRes = await adminRequest(app, 'POST', '/identity/accounts', {
      provider: 'github',
      workspace_id: 'workspace-a',
      client_id: 'user-1',
      access_token: 'gho_user_token',
    });
    const account = await createRes.json() as { id: string };
    expect(account.id).toBeTruthy();

    const revokeRes = await adminRequest(app, 'POST', `/identity/accounts/${account.id}/revoke`);
    expect(revokeRes.status).toBe(200);

    const res = await sendMcpRequest(
      app,
      makeToolCallMessage('get_contact', { id: '123' }),
      { Authorization: 'Bearer sk-user' },
    );
    const body = await res.json() as { error?: { message?: string } };
    expect(body.error?.message).toContain('No connected account');
  });

  it('surfaces identity preflight through admin and connect APIs', async () => {
    const missingProfileRes = await adminRequest(
      app,
      'GET',
      '/identity/preflight/profile/default?client_id=user-1&tenant_id=tenant-a',
    );
    expect(missingProfileRes.status).toBe(200);
    const missingProfile = await missingProfileRes.json() as {
      profile: {
        ready: boolean;
        blocking_count: number;
        server_requirements: Array<{ status: string }>;
      };
    };
    expect(missingProfile.profile.ready).toBe(false);
    expect(missingProfile.profile.blocking_count).toBe(1);
    expect(missingProfile.profile.server_requirements[0]?.status).toBe('missing-connected-account');

    const createRes = await adminRequest(app, 'POST', '/identity/accounts', {
      provider: 'github',
      workspace_id: 'workspace-a',
      client_id: 'user-1',
      access_token: 'gho_user_token',
      replace_existing: true,
    });
    expect(createRes.status).toBe(201);

    const serverRes = await adminRequest(
      app,
      'GET',
      '/identity/preflight/server/test-server?client_id=user-1&tenant_id=tenant-a',
    );
    expect(serverRes.status).toBe(200);
    const serverBody = await serverRes.json() as {
      server: {
        ready: boolean;
        status: string;
        connected_account?: { resolved: boolean; account?: { id: string } };
      };
    };
    expect(serverBody.server.ready).toBe(true);
    expect(serverBody.server.status).toBe('ready');
    expect(serverBody.server.connected_account?.resolved).toBe(true);
    expect(serverBody.server.connected_account?.account?.id).toBeTruthy();

    const exportRes = await app.request(
      '/conduit/connect/export?target=cursor&profile=default&scope=user&client_id=user-1&tenant_id=tenant-a',
    );
    expect(exportRes.status).toBe(200);
    const exportBody = await exportRes.json() as {
      identity_preflight: {
        ready: boolean;
        server_requirements: Array<{ status: string }>;
      };
    };
    expect(exportBody.identity_preflight.ready).toBe(true);
    expect(exportBody.identity_preflight.server_requirements[0]?.status).toBe('ready');

    const installRes = await adminRequest(app, 'POST', '/connect/install/session', {
      target: 'cursor',
      profile: 'default',
      scope: 'user',
      auth_secret: 'sk-user',
      client_id: 'user-1',
      tenant_id: 'tenant-a',
    });
    expect(installRes.status).toBe(201);
    const installBody = await installRes.json() as {
      bundle_url: string;
      identity_preflight: { ready: boolean };
    };
    expect(installBody.identity_preflight.ready).toBe(true);

    const bundlePath = new URL(installBody.bundle_url).pathname;
    const bundleRes = await app.request(bundlePath);
    expect(bundleRes.status).toBe(200);
    const bundleBody = await bundleRes.json() as {
      identity_preflight: { ready: boolean };
    };
    expect(bundleBody.identity_preflight.ready).toBe(true);
  });
});
