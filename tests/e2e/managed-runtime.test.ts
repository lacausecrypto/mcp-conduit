import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig, ServerConfig } from '../../src/config/types.js';
import { resetMetrics } from '../../src/observability/metrics.js';

const MOCK_STDIO_SERVER_PATH = resolve(import.meta.dirname, './mock-stdio-server.ts');
const MISSING_STDIO_SERVER_PATH = resolve(import.meta.dirname, './missing-managed-runtime-server.ts');

async function adminRequest(
  app: Hono,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/conduit${path}`, {
    method,
    headers: {
      ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Conduit-Admin': '1' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function makeManagedServer(): ServerConfig {
  return {
    id: 'managed-stdio',
    url: 'stdio://npx/tsx',
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', MOCK_STDIO_SERVER_PATH],
    cache: { default_ttl: 0 },
    managed_runtime: {
      enabled: true,
      source_type: 'command',
      source_ref: 'npx tsx',
      channel: 'stable',
      active_release_id: 'stable-1.0.0',
      last_healthy_release_id: 'stable-1.0.0',
      last_rollout_at: '2026-04-22T00:00:00.000Z',
      sandbox: {
        enabled: true,
        root_dir: './.conduit/runtime/managed-stdio',
        sanitize_env: true,
        allow_network: true,
      },
      health_gate: {
        enabled: true,
        auto_rollback: true,
      },
      releases: [
        {
          id: 'stable-1.0.0',
          version: '1.0.0',
          channel: 'stable',
          command: 'npx',
          args: ['tsx', MOCK_STDIO_SERVER_PATH],
          created_at: '2026-04-22T00:00:00.000Z',
          status: 'active',
        },
      ],
    },
  };
}

describe('Managed runtime plane', () => {
  let gateway: ConduitGateway;
  let app: Hono;

  beforeAll(async () => {
    resetMetrics();
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
      servers: [makeManagedServer()],
      cache: {
        enabled: true,
        l1: { max_entries: 1000, max_entry_size_kb: 64 },
      },
      tenant_isolation: { enabled: false, header: 'Authorization' },
      observability: {
        log_args: true,
        log_responses: false,
        redact_fields: ['token', 'secret'],
        retention_days: 30,
        db_path: ':memory:',
      },
      metrics: { enabled: false, port: 0 },
    };

    gateway = new ConduitGateway(config);
    await gateway.initialize();
    app = gateway.createApp();
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it('lists managed stdio servers with release metadata', async () => {
    const res = await adminRequest(app, 'GET', '/runtime/managed/servers');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const items = body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(expect.objectContaining({
      server_id: 'managed-stdio',
      source_type: 'command',
      current_version: '1.0.0',
      channel: 'stable',
      healthy: true,
    }));
  });

  it('rolls back automatically when a new stdio release fails the health gate', async () => {
    const res = await adminRequest(app, 'POST', '/runtime/managed/servers/managed-stdio/rollout', {
      version: '2.0.0-bad',
      channel: 'canary',
      command: 'npx',
      args: ['tsx', MISSING_STDIO_SERVER_PATH],
    });

    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body['rolled_back']).toBe(true);

    const runtime = body['runtime'] as Record<string, unknown>;
    expect(runtime['current_version']).toBe('1.0.0');
    expect(runtime['channel']).toBe('stable');
    expect(runtime['healthy']).toBe(true);
  });

  it('promotes a healthy release and pins its version', async () => {
    const res = await adminRequest(app, 'POST', '/runtime/managed/servers/managed-stdio/rollout', {
      version: '1.1.0',
      channel: 'beta',
      command: 'npx',
      args: ['tsx', MOCK_STDIO_SERVER_PATH],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const rollout = body['rollout'] as Record<string, unknown>;
    expect(rollout['version']).toBe('1.1.0');
    expect(rollout['channel']).toBe('beta');

    const runtime = body['runtime'] as Record<string, unknown>;
    expect(runtime['current_version']).toBe('1.1.0');
    expect(runtime['channel']).toBe('beta');
    expect(runtime['healthy']).toBe(true);
  });

  it('can rollback explicitly to the last healthy release', async () => {
    const res = await adminRequest(app, 'POST', '/runtime/managed/servers/managed-stdio/rollback', {
      release_id: 'stable-1.0.0',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const runtime = body['runtime'] as Record<string, unknown>;
    expect(runtime['current_version']).toBe('1.0.0');
    expect(runtime['channel']).toBe('stable');
    expect(runtime['healthy']).toBe(true);
  });
});
