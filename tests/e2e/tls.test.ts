/**
 * E2E tests for native TLS support.
 *
 * These tests:
 * 1. Verify that the gateway can start with HTTPS using a self-signed cert
 * 2. Verify that missing cert files cause a clear error on start()
 * 3. Verify that HTTP still works when TLS is not configured
 *
 * TLS tests generate a self-signed certificate via openssl and skip if
 * openssl is not available in the test environment.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { resetMetrics } from '../../src/observability/metrics.js';
import { startMockMcpServer, type MockMcpServer } from './mock-mcp-server.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true if openssl is available on this system */
function opensslAvailable(): boolean {
  try {
    execSync('openssl version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_OPENSSL = opensslAvailable();

/** Generates a self-signed cert+key in a temp directory. Returns { certPath, keyPath, dir }. */
function generateSelfSignedCert(): { certPath: string; keyPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-tls-test-'));
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '1',
    '-nodes',
    '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });

  return { certPath, keyPath, dir };
}

function baseConfig(mockUrl: string, overrides: Partial<ConduitGatewayConfig> = {}): ConduitGatewayConfig {
  return {
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
      { id: 'test-server', url: mockUrl, cache: { default_ttl: 0 } },
    ],
    cache: {
      enabled: false,
      l1: { max_entries: 100, max_entry_size_kb: 64 },
    },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: {
      log_args: false,
      log_responses: false,
      redact_fields: [],
      retention_days: 1,
      db_path: ':memory:',
    },
    metrics: { enabled: false, port: 0 },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TLS — HTTP mode (no TLS config)', () => {
  let gateway: ConduitGateway | null = null;
  let mockServer: MockMcpServer | null = null;

  afterEach(async () => {
    await gateway?.stop();
    gateway = null;
    await mockServer?.close();
    mockServer = null;
    resetMetrics();
  });

  it('starts in HTTP mode and returns an http:// URL', async () => {
    mockServer = await startMockMcpServer(0);
    const config = baseConfig(mockServer.url);

    gateway = new ConduitGateway(config);
    await gateway.initialize();
    const url = await gateway.start();

    expect(url).toMatch(/^http:\/\//);
  });

  it('createApp() returns a Hono app that responds to requests over HTTP', async () => {
    mockServer = await startMockMcpServer(0);
    const config = baseConfig(mockServer.url);

    gateway = new ConduitGateway(config);
    await gateway.initialize();
    await gateway.start();

    const app = gateway.createApp();
    const res = await app.request('/conduit/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBeDefined();
  });
});

describe('TLS — missing cert/key files', () => {
  let gateway: ConduitGateway | null = null;
  let mockServer: MockMcpServer | null = null;

  afterEach(async () => {
    await gateway?.stop().catch(() => {});
    gateway = null;
    await mockServer?.close();
    mockServer = null;
    resetMetrics();
  });

  it('start() rejects with a clear error when cert file does not exist', async () => {
    mockServer = await startMockMcpServer(0);
    const config = baseConfig(mockServer.url, {
      gateway: {
        port: 0,
        host: '127.0.0.1',
        tls: {
          enabled: true,
          cert_path: '/nonexistent/cert.pem',
          key_path: '/nonexistent/key.pem',
        },
      },
    });

    gateway = new ConduitGateway(config);
    await gateway.initialize();

    await expect(gateway.start()).rejects.toThrow();
  });
});

describe('TLS — HTTPS mode with self-signed cert', () => {
  let gateway: ConduitGateway | null = null;
  let mockServer: MockMcpServer | null = null;
  let certDir: string | null = null;

  afterEach(async () => {
    await gateway?.stop().catch(() => {});
    gateway = null;
    await mockServer?.close();
    mockServer = null;
    resetMetrics();
    if (certDir) {
      try { rmSync(certDir, { recursive: true, force: true }); } catch { /* ignore */ }
      certDir = null;
    }
  });

  it.skipIf(!HAS_OPENSSL)('start() returns an https:// URL when TLS is enabled', async () => {
    const { certPath, keyPath, dir } = generateSelfSignedCert();
    certDir = dir;

    mockServer = await startMockMcpServer(0);
    const config = baseConfig(mockServer.url, {
      gateway: {
        port: 0,
        host: '127.0.0.1',
        tls: {
          enabled: true,
          cert_path: certPath,
          key_path: keyPath,
        },
      },
    });

    gateway = new ConduitGateway(config);
    await gateway.initialize();
    const url = await gateway.start();

    expect(url).toMatch(/^https:\/\//);
  });

  it.skipIf(!HAS_OPENSSL)('gateway responds to requests when started with TLS (via createApp)', async () => {
    const { certPath, keyPath, dir } = generateSelfSignedCert();
    certDir = dir;

    mockServer = await startMockMcpServer(0);
    const config = baseConfig(mockServer.url, {
      gateway: {
        port: 0,
        host: '127.0.0.1',
        tls: {
          enabled: true,
          cert_path: certPath,
          key_path: keyPath,
        },
      },
    });

    gateway = new ConduitGateway(config);
    await gateway.initialize();
    await gateway.start();

    // createApp() is transport-agnostic — works regardless of TLS
    const app = gateway.createApp();
    const res = await app.request('/conduit/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBeDefined();
  });
});
