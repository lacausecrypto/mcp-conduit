import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { runConnect } from '../../src/cli/connect.js';
import { installConnectBundle } from '../../src/connect/local.js';
import type { ConnectInstallBundle } from '../../src/connect/install.js';

describe('connect CLI', () => {
  let tempHome: string;
  let prevHome: string | undefined;
  let prevSecretBackend: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(os.tmpdir(), 'conduit-connect-cli-'));
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

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('supports sync --all as a value-less flag and repairs local installs', async () => {
    const bundle: ConnectInstallBundle = {
      version: 1,
      transport: 'stdio-relay',
      target: 'generic-json',
      target_label: 'Generic JSON',
      profile: 'default',
      profile_label: 'Default',
      scope: 'user',
      scope_effective: 'user',
      base_url: 'http://127.0.0.1:8080',
      servers: [{ id: 'github', alias: 'conduit-github', url: 'http://127.0.0.1:8080/mcp/github' }],
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      auth: { type: 'none' },
    };

    const install = installConnectBundle(bundle);
    writeFileSync(install.config_path, '{\n  "mcpServers": {}\n}\n', 'utf-8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runConnect(['sync', '--all']);

    const config = JSON.parse(readFileSync(install.config_path, 'utf-8')) as Record<string, unknown>;
    expect((config['mcpServers'] as Record<string, unknown>)['conduit-github']).toBeTruthy();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Synced:'));
  });

  it('supports registry-install and prints the direct install bundle information', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      profile_id: 'registry-demo',
      imported_servers: ['demo-server'],
      updated_servers: [],
      install_session: {
        bundle_url: 'http://127.0.0.1:8080/conduit/connect/install/bundles/demo',
        deeplink: 'conduit://install?bundle_url=http%3A%2F%2F127.0.0.1%3A8080%2Fconduit%2Fconnect%2Finstall%2Fbundles%2Fdemo',
        install_command: 'conduit connect install --bundle-url "http://127.0.0.1:8080/conduit/connect/install/bundles/demo"',
      },
    }), { status: 201 })) as typeof fetch);

    await runConnect([
      'registry-install',
      '--base-url', 'http://127.0.0.1:8080',
      '--server-name', 'ai.demo/server',
      '--target', 'cursor',
      '--headers-json', '{"Authorization":"Bearer demo"}',
    ]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Profile:'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Bundle URL:'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Command:'));
  });

  it('supports registry-install and prints remote handoff information for remote targets', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      profile_id: 'registry-demo',
      imported_servers: ['demo-server'],
      updated_servers: [],
      remote_session: {
        bundle_url: 'https://conduit.example.com/conduit/connect/remote/bundles/demo',
        profile_url: 'https://conduit.example.com/mcp/profile/registry-demo',
        settings_url: 'https://claude.ai/settings/connectors',
        remote_ready: true,
      },
    }), { status: 201 })) as typeof fetch);

    await runConnect([
      'registry-install',
      '--base-url', 'https://conduit.example.com',
      '--server-name', 'ai.demo/server',
      '--target', 'claude',
    ]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Profile URL:'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Target URL:'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Ready:'));
  });
});
