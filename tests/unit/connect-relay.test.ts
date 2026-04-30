import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { installConnectBundle, loadLocalInstallation } from '../../src/connect/local.js';
import { forwardRelayMessage } from '../../src/connect/relay.js';
import type { ConnectInstallBundle } from '../../src/connect/install.js';

describe('connect relay', () => {
  let tempHome: string;
  let prevHome: string | undefined;
  let prevSecretBackend: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(os.tmpdir(), 'conduit-relay-'));
    prevHome = process.env['CONDUIT_CONNECT_HOME'];
    prevSecretBackend = process.env['CONDUIT_CONNECT_SECRET_BACKEND'];
    process.env['CONDUIT_CONNECT_HOME'] = tempHome;
    process.env['CONDUIT_CONNECT_SECRET_BACKEND'] = 'file';
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env['CONDUIT_CONNECT_HOME'];
    else process.env['CONDUIT_CONNECT_HOME'] = prevHome;

    if (prevSecretBackend === undefined) delete process.env['CONDUIT_CONNECT_SECRET_BACKEND'];
    else process.env['CONDUIT_CONNECT_SECRET_BACKEND'] = prevSecretBackend;

    rmSync(tempHome, { recursive: true, force: true });
  });

  it('forwards JSON-RPC messages to Conduit and reuses the stored bearer token', async () => {
    let capturedAuth = '';

    const server = await new Promise<http.Server>((resolve) => {
      const app = http.createServer((req, res) => {
        capturedAuth = String(req.headers['authorization'] ?? '');
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed['id'] ?? null,
            result: { ok: true },
          }));
        });
      });
      app.listen(0, '127.0.0.1', () => resolve(app));
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const bundle: ConnectInstallBundle = {
      version: 1,
      transport: 'stdio-relay',
      target: 'generic-json',
      target_label: 'Generic JSON',
      profile: 'default',
      profile_label: 'Default',
      scope: 'user',
      scope_effective: 'user',
      base_url: `http://127.0.0.1:${port}`,
      servers: [{ id: 'test-server', alias: 'conduit-test-server', url: `http://127.0.0.1:${port}/mcp/test-server` }],
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      auth: {
        type: 'bearer',
        secret: 'sk-phase-2',
        description: 'Conduit API key',
        header_name: 'Authorization',
        prefix: 'Bearer ',
      },
    };

    const install = installConnectBundle(bundle);
    const installation = loadLocalInstallation(install.installation.id);
    const response = await forwardRelayMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    }, installation, 'test-server');

    expect(capturedAuth).toBe('Bearer sk-phase-2');
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    });

    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
});
