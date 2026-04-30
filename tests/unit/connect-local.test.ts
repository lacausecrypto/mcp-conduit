import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import {
  installConnectBundle,
  listLocalInstallations,
  loadLocalInstallation,
  readInstallationSecret,
  syncLocalInstallation,
} from '../../src/connect/local.js';
import type { ConnectInstallBundle } from '../../src/connect/install.js';

describe('connect local install', () => {
  let tempHome: string;
  let prevHome: string | undefined;
  let prevSecretBackend: string | undefined;
  let prevClaudeDesktopConfig: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(os.tmpdir(), 'conduit-connect-'));
    prevHome = process.env['CONDUIT_CONNECT_HOME'];
    prevSecretBackend = process.env['CONDUIT_CONNECT_SECRET_BACKEND'];
    prevClaudeDesktopConfig = process.env['CONDUIT_CLAUDE_DESKTOP_CONFIG'];
    process.env['CONDUIT_CONNECT_HOME'] = tempHome;
    process.env['CONDUIT_CONNECT_SECRET_BACKEND'] = 'file';
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env['CONDUIT_CONNECT_HOME'];
    else process.env['CONDUIT_CONNECT_HOME'] = prevHome;

    if (prevSecretBackend === undefined) delete process.env['CONDUIT_CONNECT_SECRET_BACKEND'];
    else process.env['CONDUIT_CONNECT_SECRET_BACKEND'] = prevSecretBackend;

    if (prevClaudeDesktopConfig === undefined) delete process.env['CONDUIT_CLAUDE_DESKTOP_CONFIG'];
    else process.env['CONDUIT_CLAUDE_DESKTOP_CONFIG'] = prevClaudeDesktopConfig;

    rmSync(tempHome, { recursive: true, force: true });
  });

  it('writes a Cursor stdio config and stores the secret outside the client config', () => {
    const bundle: ConnectInstallBundle = {
      version: 1,
      transport: 'stdio-relay',
      target: 'cursor',
      target_label: 'Cursor',
      profile: 'default',
      profile_label: 'Default',
      scope: 'user',
      scope_effective: 'user',
      base_url: 'http://127.0.0.1:8080',
      servers: [{ id: 'salesforce', alias: 'conduit-salesforce', url: 'http://127.0.0.1:8080/mcp/salesforce' }],
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      auth: {
        type: 'bearer',
        secret: 'sk-demo',
        description: 'Conduit API key',
        header_name: 'Authorization',
        prefix: 'Bearer ',
      },
    };

    const result = installConnectBundle(bundle);
    const config = JSON.parse(readFileSync(result.config_path, 'utf-8')) as Record<string, unknown>;
    const mcpServers = config['mcpServers'] as Record<string, Record<string, unknown>>;
    const entry = mcpServers['conduit-salesforce'];

    expect(result.config_path).toBe(join(tempHome, '.cursor', 'mcp.json'));
    expect(entry['command']).toBe(process.execPath);
    expect(entry['args']).toContain('connect');
    expect(entry['args']).toContain('relay');
    expect(JSON.stringify(config)).not.toContain('sk-demo');

    const installation = loadLocalInstallation(result.installation.id);
    expect(readInstallationSecret(installation)).toBe('sk-demo');
  });

  it('writes Claude Code project installs to .mcp.json with stdio type', () => {
    const projectDir = join(tempHome, 'project-a');
    const bundle: ConnectInstallBundle = {
      version: 1,
      transport: 'stdio-relay',
      target: 'claude-code',
      target_label: 'Claude Code',
      profile: 'default',
      profile_label: 'Default',
      scope: 'project',
      scope_effective: 'project',
      base_url: 'http://127.0.0.1:8080',
      servers: [{ id: 'github', alias: 'conduit-github', url: 'http://127.0.0.1:8080/mcp/github' }],
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      auth: { type: 'none' },
    };

    const result = installConnectBundle(bundle, { projectDir });
    const config = JSON.parse(readFileSync(result.config_path, 'utf-8')) as Record<string, unknown>;
    const mcpServers = config['mcpServers'] as Record<string, Record<string, unknown>>;

    expect(result.config_path).toBe(join(projectDir, '.mcp.json'));
    expect(mcpServers['conduit-github']?.['type']).toBe('stdio');
  });

  it('writes VS Code installs into VS Code, Claude Code, and Codex configs for the same scope', () => {
    const projectDir = join(tempHome, 'project-vscode');
    const bundle: ConnectInstallBundle = {
      version: 1,
      transport: 'stdio-relay',
      target: 'vscode',
      target_label: 'VS Code',
      profile: 'default',
      profile_label: 'Default',
      scope: 'project',
      scope_effective: 'project',
      base_url: 'http://127.0.0.1:8080',
      servers: [{ id: 'io-github-lacausecrypto-sophon', alias: 'conduitIoGithubLacausecryptoSophon', url: 'http://127.0.0.1:8080/mcp/io-github-lacausecrypto-sophon' }],
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      auth: { type: 'none' },
    };

    const result = installConnectBundle(bundle, { projectDir });
    const vscodeConfig = JSON.parse(readFileSync(result.config_path, 'utf-8')) as Record<string, unknown>;
    const claudeConfig = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf-8')) as Record<string, unknown>;
    const codexConfig = readFileSync(join(projectDir, '.codex', 'config.toml'), 'utf-8');

    expect(result.config_path).toBe(join(projectDir, '.vscode', 'mcp.json'));
    expect((vscodeConfig['servers'] as Record<string, unknown>)['conduitIoGithubLacausecryptoSophon']).toBeTruthy();
    expect((claudeConfig['mcpServers'] as Record<string, unknown>)['conduit-io-github-lacausecrypto-sophon']).toBeTruthy();
    expect(codexConfig).toContain('[mcp_servers.conduit-io-github-lacausecrypto-sophon]');
  });

  it('writes Claude Desktop installs to the configured desktop config path', () => {
    const desktopConfig = join(tempHome, 'claude-desktop', 'config.json');
    process.env['CONDUIT_CLAUDE_DESKTOP_CONFIG'] = desktopConfig;

    const bundle: ConnectInstallBundle = {
      version: 1,
      transport: 'stdio-relay',
      target: 'claude-desktop',
      target_label: 'Claude Desktop',
      profile: 'default',
      profile_label: 'Default',
      scope: 'project',
      scope_effective: 'global',
      base_url: 'http://127.0.0.1:8080',
      servers: [{ id: 'github', alias: 'conduit-github', url: 'http://127.0.0.1:8080/mcp/github' }],
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      auth: { type: 'none' },
    };

    const result = installConnectBundle(bundle);
    const config = JSON.parse(readFileSync(result.config_path, 'utf-8')) as Record<string, unknown>;
    const mcpServers = config['mcpServers'] as Record<string, Record<string, unknown>>;

    expect(result.config_path).toBe(desktopConfig);
    expect(mcpServers['conduit-github']?.['command']).toBe(process.execPath);
  });

  it('writes Windsurf installs to both supported raw config paths', () => {
    const bundle: ConnectInstallBundle = {
      version: 1,
      transport: 'stdio-relay',
      target: 'windsurf',
      target_label: 'Windsurf',
      profile: 'default',
      profile_label: 'Default',
      scope: 'user',
      scope_effective: 'global',
      base_url: 'http://127.0.0.1:8080',
      servers: [{ id: 'github', alias: 'conduit-github', url: 'http://127.0.0.1:8080/mcp/github' }],
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      auth: { type: 'none' },
    };

    const result = installConnectBundle(bundle);
    const primaryConfig = JSON.parse(readFileSync(result.config_path, 'utf-8')) as Record<string, unknown>;
    const legacyPath = join(tempHome, '.codeium', 'windsurf', 'mcp_config.json');
    const legacyConfig = JSON.parse(readFileSync(legacyPath, 'utf-8')) as Record<string, unknown>;

    expect(result.config_path).toBe(join(tempHome, '.codeium', 'mcp_config.json'));
    expect((primaryConfig['mcpServers'] as Record<string, unknown>)['conduit-github']).toBeTruthy();
    expect((legacyConfig['mcpServers'] as Record<string, unknown>)['conduit-github']).toBeTruthy();
  });

  it('writes Codex installs to config.toml and keeps the secret in the manifest backend only', () => {
    const bundle: ConnectInstallBundle = {
      version: 1,
      transport: 'stdio-relay',
      target: 'codex',
      target_label: 'Codex',
      profile: 'default',
      profile_label: 'Default',
      scope: 'user',
      scope_effective: 'user',
      base_url: 'http://127.0.0.1:8080',
      servers: [{ id: 'salesforce', alias: 'conduit-salesforce', url: 'http://127.0.0.1:8080/mcp/salesforce' }],
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      auth: {
        type: 'bearer',
        secret: 'sk-codex',
        description: 'Conduit bearer token',
        header_name: 'Authorization',
        prefix: 'Bearer ',
      },
    };

    const result = installConnectBundle(bundle);
    const content = readFileSync(result.config_path, 'utf-8');

    expect(result.config_path).toBe(join(tempHome, '.codex', 'config.toml'));
    expect(content).toContain('[mcp_servers.conduit-salesforce]');
    expect(content).toContain(`command = ${JSON.stringify(process.execPath)}`);
    expect(content).toContain('connect');
    expect(content).not.toContain('sk-codex');

    const installation = loadLocalInstallation(result.installation.id);
    expect(readInstallationSecret(installation)).toBe('sk-codex');
  });

  it('marks Codex project installs as trusted in the user config', () => {
    const projectDir = join(tempHome, 'project-codex');
    const bundle: ConnectInstallBundle = {
      version: 1,
      transport: 'stdio-relay',
      target: 'codex',
      target_label: 'Codex',
      profile: 'default',
      profile_label: 'Default',
      scope: 'project',
      scope_effective: 'project',
      base_url: 'http://127.0.0.1:8080',
      servers: [{ id: 'docs', alias: 'conduit-docs', url: 'http://127.0.0.1:8080/mcp/docs' }],
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      auth: { type: 'none' },
    };

    const result = installConnectBundle(bundle, { projectDir });
    const projectConfig = readFileSync(result.config_path, 'utf-8');
    const userConfig = readFileSync(join(tempHome, '.codex', 'config.toml'), 'utf-8');

    expect(result.config_path).toBe(join(projectDir, '.codex', 'config.toml'));
    expect(projectConfig).toContain('[mcp_servers.conduit-docs]');
    expect(userConfig).toContain(`[projects.${JSON.stringify(projectDir)}]`);
    expect(userConfig).toContain('trust_level = "trusted"');
  });

  it('syncs an installation and repairs a deleted config file from the manifest', () => {
    const bundle: ConnectInstallBundle = {
      version: 1,
      transport: 'stdio-relay',
      target: 'cursor',
      target_label: 'Cursor',
      profile: 'default',
      profile_label: 'Default',
      scope: 'user',
      scope_effective: 'user',
      base_url: 'http://127.0.0.1:8080',
      servers: [{ id: 'salesforce', alias: 'conduit-salesforce', url: 'http://127.0.0.1:8080/mcp/salesforce' }],
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      auth: { type: 'none' },
    };

    const install = installConnectBundle(bundle);
    rmSync(install.config_path, { force: true });

    const synced = syncLocalInstallation(install.installation.id);
    const config = JSON.parse(readFileSync(synced.config_path, 'utf-8')) as Record<string, unknown>;

    expect(synced.config_path).toBe(install.config_path);
    expect((config['mcpServers'] as Record<string, unknown>)['conduit-salesforce']).toBeTruthy();
  });

  it('lists persisted local installations', () => {
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

    installConnectBundle(bundle);
    const installations = listLocalInstallations();
    expect(installations).toHaveLength(1);
    expect(installations[0]?.target).toBe('generic-json');
  });
});
