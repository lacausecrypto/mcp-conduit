import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ConnectInstallBundle } from './install.js';
import { toTomlArray, toTomlInlineStringTable, toTomlKey, toTomlString } from './toml.js';
import { assertSafeSystemPath } from '../utils/path-guard.js';

export interface SecretReference {
  backend: 'keychain' | 'file';
  service: string;
  account: string;
}

export interface ConnectLocalInstallation {
  id: string;
  created_at: string;
  target: ConnectInstallBundle['target'];
  profile: string;
  scope: ConnectInstallBundle['scope'];
  scope_effective: ConnectInstallBundle['scope_effective'];
  base_url: string;
  transport: 'stdio-relay';
  servers: ConnectInstallBundle['servers'];
  config_path: string;
  project_dir?: string;
  auth:
    | { type: 'none' }
    | {
      type: 'bearer';
      description: string;
      header_name: 'Authorization';
      prefix: 'Bearer ';
      secret_ref: SecretReference;
    };
}

export interface ConnectInstallResult {
  installation: ConnectLocalInstallation;
  installation_path: string;
  config_path: string;
  scope_effective: ConnectInstallBundle['scope_effective'];
  installed_servers: string[];
}

export interface ConnectSyncResult {
  installation: ConnectLocalInstallation;
  installation_path: string;
  config_path: string;
  repaired_servers: string[];
}

interface CommandSpec {
  command: string;
  args: string[];
}

const SECRET_BACKEND_ENV = 'CONDUIT_CONNECT_SECRET_BACKEND';

export function installConnectBundle(
  bundle: ConnectInstallBundle,
  options: { projectDir?: string } = {},
): ConnectInstallResult {
  const installation = createLocalInstallation(bundle);
  const configPath = installTargetConfig(bundle, installation, options);
  const installationWithPaths: ConnectLocalInstallation = {
    ...installation,
    config_path: configPath,
    ...(bundle.scope_effective === 'project' && options.projectDir ? { project_dir: resolveSafeProjectDir(options.projectDir) } : {}),
  };
  const installationPath = writeInstallationManifest(installationWithPaths, bundle);

  return {
    installation: installationWithPaths,
    installation_path: installationPath,
    config_path: configPath,
    scope_effective: bundle.scope_effective,
    installed_servers: bundle.servers.map((server) => server.alias),
  };
}

export function syncLocalInstallation(
  installId: string,
  options: { projectDir?: string } = {},
): ConnectSyncResult {
  const installation = loadLocalInstallation(installId);
  const projectDir = options.projectDir ?? installation.project_dir;
  if (installation.scope_effective === 'project' && !projectDir) {
    throw new Error(`Installation "${installId}" needs --project-dir because no project path was stored`);
  }
  const configPath = installTargetConfig(buildBundleFromInstallation(installation), installation, {
    ...(projectDir ? { projectDir } : {}),
  });
  const updatedInstallation: ConnectLocalInstallation = {
    ...installation,
    config_path: configPath,
    ...(projectDir ? { project_dir: resolveSafeProjectDir(projectDir) } : {}),
  };
  const installationPath = writeInstallationManifest(updatedInstallation, buildBundleFromInstallation(updatedInstallation));

  return {
    installation: updatedInstallation,
    installation_path: installationPath,
    config_path: configPath,
    repaired_servers: updatedInstallation.servers.map((server) => server.alias),
  };
}

export function syncAllLocalInstallations(): ConnectSyncResult[] {
  return listLocalInstallations().map((installation) => syncLocalInstallation(installation.id));
}

export function listLocalInstallations(): ConnectLocalInstallation[] {
  const dir = getInstallationsDir();
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadLocalInstallation(entry.replace(/\.json$/, '')));
}

export function loadLocalInstallation(installId: string): ConnectLocalInstallation {
  const manifestPath = getInstallationManifestPath(installId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read connect installation "${installId}": ${String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid connect installation manifest for "${installId}"`);
  }

  return parsed as ConnectLocalInstallation;
}

export function readInstallationSecret(installation: ConnectLocalInstallation): string | null {
  if (installation.auth.type === 'none') {
    return null;
  }

  const ref = installation.auth.secret_ref;
  if (ref.backend === 'keychain') {
    return readKeychainSecret(ref.service, ref.account);
  }

  return readFileSecret(ref.service, ref.account);
}

export function getRelayCommandSpec(
  installId: string,
  serverId: string,
): CommandSpec {
  const scriptPath = fileURLToPath(new URL('../index.js', import.meta.url));
  return {
    command: process.execPath,
    args: [scriptPath, 'connect', 'relay', '--install-id', installId, '--server-id', serverId],
  };
}

function createLocalInstallation(bundle: ConnectInstallBundle): ConnectLocalInstallation {
  const installId = randomUUID();
  const auth = bundle.auth.type === 'none'
    ? { type: 'none' as const }
    : {
      type: 'bearer' as const,
      description: bundle.auth.description,
      header_name: bundle.auth.header_name,
      prefix: bundle.auth.prefix,
      secret_ref: storeSecret(bundle.auth.secret, installId),
    };

  return {
    id: installId,
    created_at: new Date().toISOString(),
    target: bundle.target,
    profile: bundle.profile,
    scope: bundle.scope,
    scope_effective: bundle.scope_effective,
    base_url: bundle.base_url,
    transport: 'stdio-relay',
    servers: bundle.servers,
    config_path: '',
    auth,
  };
}

function writeInstallationManifest(
  installation: ConnectLocalInstallation,
  bundle: ConnectInstallBundle,
): string {
  const manifestPath = getInstallationManifestPath(installation.id);
  ensureDir(dirname(manifestPath));
  writeJsonFile(manifestPath, {
    ...installation,
    target_label: bundle.target_label,
    profile_label: bundle.profile_label,
  });
  return manifestPath;
}

function installTargetConfig(
  bundle: ConnectInstallBundle,
  installation: ConnectLocalInstallation,
  options: { projectDir?: string },
): string {
  switch (bundle.target) {
    case 'cursor':
      return mergeMcpServersJson(resolveScopedPath(bundle.target, installation.scope_effective, options), installation, false);
    case 'claude-desktop':
      return mergeMcpServersJson(resolveScopedPath(bundle.target, installation.scope_effective, options), installation, false);
    case 'codex':
      return mergeCodexToml(
        resolveScopedPath(bundle.target, installation.scope_effective, options),
        installation,
        {
          ...(installation.scope_effective === 'project'
            ? { projectDir: resolveSafeProjectDir(options.projectDir) }
            : {}),
        },
      );
    case 'windsurf':
      return installWindsurfConfig(installation, options);
    case 'generic-json':
      return mergeMcpServersJson(resolveScopedPath(bundle.target, installation.scope_effective, options), installation, false);
    case 'vscode':
      return installVsCodeSuite(bundle, installation, options);
    case 'claude-code':
      return mergeMcpServersJson(resolveScopedPath(bundle.target, installation.scope_effective, options), installation, true);
    default:
      throw new Error(`Local install is not supported for target "${bundle.target}"`);
  }
}

function installVsCodeSuite(
  _bundle: ConnectInstallBundle,
  installation: ConnectLocalInstallation,
  options: { projectDir?: string },
): string {
  const primaryPath = resolveScopedPath('vscode', installation.scope_effective, options);
  mergeVsCodeJson(primaryPath, withAliasesForTarget(installation, 'vscode'));

  const claudePath = resolveScopedPath('claude-code', installation.scope_effective, options);
  mergeMcpServersJson(claudePath, withAliasesForTarget(installation, 'claude-code'), true);

  const codexPath = resolveScopedPath('codex', installation.scope_effective, options);
  mergeCodexToml(
    codexPath,
    withAliasesForTarget(installation, 'codex'),
    {
      ...(installation.scope_effective === 'project'
        ? { projectDir: resolveSafeProjectDir(options.projectDir) }
        : {}),
    },
  );

  return primaryPath;
}

function installWindsurfConfig(
  installation: ConnectLocalInstallation,
  options: { projectDir?: string },
): string {
  const primaryPath = resolveScopedPath('windsurf', installation.scope_effective, options);
  mergeMcpServersJson(primaryPath, installation, false);

  const legacyPath = resolveLegacyWindsurfPath();
  if (legacyPath !== primaryPath) {
    mergeMcpServersJson(legacyPath, installation, false);
  }

  return primaryPath;
}

function withAliasesForTarget(
  installation: ConnectLocalInstallation,
  target: ConnectInstallBundle['target'],
): ConnectLocalInstallation {
  return {
    ...installation,
    servers: installation.servers.map((server) => ({
      ...server,
      alias: buildAliasForTarget(server.id, target),
    })),
  };
}

function mergeMcpServersJson(
  filePath: string,
  installation: ConnectLocalInstallation,
  includeType: boolean,
): string {
  const doc = readJsonObject(filePath);
  const servers = readObject(doc, 'mcpServers');

  for (const server of installation.servers) {
    const relay = getRelayCommandSpec(installation.id, server.id);
    servers[server.alias] = {
      ...(includeType ? { type: 'stdio' } : {}),
      command: relay.command,
      args: relay.args,
      env: {},
    };
  }

  doc['mcpServers'] = servers;
  writeJsonFile(filePath, doc);
  return filePath;
}

function mergeVsCodeJson(
  filePath: string,
  installation: ConnectLocalInstallation,
): string {
  const doc = readJsonObject(filePath);
  const servers = readObject(doc, 'servers');

  for (const server of installation.servers) {
    const relay = getRelayCommandSpec(installation.id, server.id);
    servers[toVsCodeAlias(server.id)] = {
      type: 'stdio',
      command: relay.command,
      args: relay.args,
      env: {},
    };
  }

  doc['servers'] = servers;
  writeJsonFile(filePath, doc);
  return filePath;
}

function mergeCodexToml(
  filePath: string,
  installation: ConnectLocalInstallation,
  options: { projectDir?: string } = {},
): string {
  let content = existsSync(filePath)
    ? readFileSync(filePath, 'utf-8')
    : '';

  for (const server of installation.servers) {
    content = removeCodexManagedServer(content, server.alias);
  }

  const blocks = installation.servers.map((server) => {
    const relay = getRelayCommandSpec(installation.id, server.id);
    return [
      `[mcp_servers.${toTomlKey(server.alias)}]`,
      `command = ${toTomlString(relay.command)}`,
      `args = ${toTomlArray(relay.args)}`,
      `env = ${toTomlInlineStringTable({})}`,
    ].join('\n');
  }).join('\n\n');

  const next = content.trimEnd()
    ? `${content.trimEnd()}\n\n${blocks}\n`
    : `${blocks}\n`;

  ensureDir(dirname(filePath));
  writeFileSync(filePath, next, 'utf-8');

  if (installation.scope_effective === 'project') {
    const projectDir = resolveSafeProjectDir(options.projectDir);
    ensureCodexProjectTrusted(projectDir);
  }

  return filePath;
}

function resolveScopedPath(
  target: ConnectInstallBundle['target'],
  scopeEffective: ConnectInstallBundle['scope_effective'],
  options: { projectDir?: string },
): string {
  const home = getConnectHome();
  const projectDir = resolveSafeProjectDir(options.projectDir);

  switch (target) {
    case 'cursor':
      return scopeEffective === 'project'
        ? join(projectDir, '.cursor', 'mcp.json')
        : join(home, '.cursor', 'mcp.json');
    case 'claude-desktop':
      return getClaudeDesktopConfigPath(home);
    case 'codex':
      return scopeEffective === 'project'
        ? join(projectDir, '.codex', 'config.toml')
        : join(home, '.codex', 'config.toml');
    case 'windsurf':
      return join(home, '.codeium', 'mcp_config.json');
    case 'vscode':
      return scopeEffective === 'project'
        ? join(projectDir, '.vscode', 'mcp.json')
        : getVsCodeUserConfigPath(home);
    case 'claude-code':
      return scopeEffective === 'project'
        ? join(projectDir, '.mcp.json')
        : join(home, '.claude.json');
    case 'generic-json':
      return scopeEffective === 'project'
        ? join(projectDir, 'mcp.json')
        : join(getConnectBaseDir(), 'generic-mcp.json');
    default:
      throw new Error(`Local install path is not supported for target "${target}"`);
  }
}

function resolveSafeProjectDir(candidate: string | undefined): string {
  const base = candidate ?? process.cwd();
  return assertSafeSystemPath(base, 'projectDir');
}

function getVsCodeUserConfigPath(home: string): string {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }

  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    return join(appData, 'Code', 'User', 'mcp.json');
  }

  return join(home, '.config', 'Code', 'User', 'mcp.json');
}

function resolveLegacyWindsurfPath(): string {
  return join(getConnectHome(), '.codeium', 'windsurf', 'mcp_config.json');
}

function getCodexUserConfigPath(home: string): string {
  return join(home, '.codex', 'config.toml');
}

function getClaudeDesktopConfigPath(home: string): string {
  const override = process.env['CONDUIT_CLAUDE_DESKTOP_CONFIG'];
  if (override) {
    return resolve(override);
  }

  const candidates = process.platform === 'darwin'
    ? [
      join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      join(home, '.config', 'claude-desktop', 'config.json'),
    ]
    : process.platform === 'win32'
      ? [
        join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'),
        join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Claude Desktop', 'config.json'),
      ]
      : [
        join(home, '.config', 'claude-desktop', 'config.json'),
        join(home, '.config', 'Claude', 'claude_desktop_config.json'),
      ];

  const fallback = candidates[0];
  if (!fallback) {
    throw new Error('Unable to determine Claude Desktop config path');
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? fallback;
}

function toVsCodeAlias(serverId: string): string {
  const parts = serverId.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return 'conduitServer';
  return `conduit${parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join('')}`;
}

function buildAliasForTarget(
  serverId: string,
  target: ConnectInstallBundle['target'],
): string {
  if (target === 'vscode') {
    return toVsCodeAlias(serverId);
  }

  return `conduit-${serverId}`;
}

function removeCodexManagedServer(content: string, alias: string): string {
  const header = `\\[mcp_servers\\.${escapeRegExp(toTomlKey(alias))}\\]`;
  const pattern = new RegExp(`(?:^|\\n)${header}\\n[\\s\\S]*?(?=\\n\\[|$)`, 'g');
  return content.replace(pattern, (match, offset) => {
    if (offset === 0 && match.startsWith('\n')) {
      return '';
    }
    return match.startsWith('\n') ? '\n' : '';
  }).replace(/\n{3,}/g, '\n\n');
}

function ensureCodexProjectTrusted(projectDir: string): void {
  const userConfigPath = getCodexUserConfigPath(getConnectHome());
  const normalizedProjectDir = resolve(projectDir);
  const trustSectionHeader = `[projects.${toTomlString(normalizedProjectDir)}]`;
  const trustLine = 'trust_level = "trusted"';
  let content = existsSync(userConfigPath)
    ? readFileSync(userConfigPath, 'utf-8')
    : '';

  const dottedTrustKey = `projects.${toTomlString(normalizedProjectDir)}.trust_level`;
  const dottedTrustPattern = new RegExp(
    `(^|\\n)${escapeRegExp(dottedTrustKey)}\\s*=\\s*.*(?=\\n|$)`,
    'm',
  );

  if (dottedTrustPattern.test(content)) {
    content = content.replace(dottedTrustPattern, (_match, prefix: string) => `${prefix}${dottedTrustKey} = "trusted"`);
  } else {
    const sectionPattern = new RegExp(
      `(^|\\n)${escapeRegExp(trustSectionHeader)}\\n([\\s\\S]*?)(?=\\n\\[|$)`,
      'm',
    );
    const sectionMatch = sectionPattern.exec(content);

    if (sectionMatch) {
      const sectionBody = sectionMatch[2] ?? '';
      const updatedBody = /^trust_level\s*=.*$/m.test(sectionBody)
        ? sectionBody.replace(/^trust_level\s*=.*$/m, trustLine)
        : `${sectionBody.replace(/\s*$/, '')}${sectionBody.trim().length > 0 ? '\n' : ''}${trustLine}\n`;
      const replacement = `${sectionMatch[1]}${trustSectionHeader}\n${updatedBody}`;
      content = `${content.slice(0, sectionMatch.index)}${replacement}${content.slice(sectionMatch.index + sectionMatch[0].length)}`;
    } else {
      const trustBlock = `${trustSectionHeader}\n${trustLine}\n`;
      content = content.trimEnd()
        ? `${content.trimEnd()}\n\n${trustBlock}`
        : trustBlock;
    }
  }

  ensureDir(dirname(userConfigPath));
  writeFileSync(userConfigPath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${filePath}`);
  }

  return parsed as Record<string, unknown>;
}

function readObject(
  doc: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const current = doc[key];
  if (current === undefined) {
    return {};
  }

  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error(`Expected "${key}" to be a JSON object`);
  }

  return { ...(current as Record<string, unknown>) };
}

function writeJsonFile(filePath: string, doc: Record<string, unknown>): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getConnectHome(): string {
  return process.env['CONDUIT_CONNECT_HOME'] ?? os.homedir();
}

function getConnectBaseDir(): string {
  const override = process.env['CONDUIT_CONNECT_HOME'];
  if (override) {
    return join(override, '.conduit-link');
  }

  if (process.platform === 'darwin') {
    return join(os.homedir(), 'Library', 'Application Support', 'Conduit Link');
  }

  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(os.homedir(), 'AppData', 'Roaming');
    return join(appData, 'Conduit Link');
  }

  return join(os.homedir(), '.config', 'conduit-link');
}

function getInstallationManifestPath(installId: string): string {
  return join(getInstallationsDir(), `${installId}.json`);
}

function getInstallationsDir(): string {
  return join(getConnectBaseDir(), 'installations');
}

function storeSecret(secret: string, installId: string): SecretReference {
  if (shouldUseKeychain()) {
    const service = 'io.mcp-conduit.connect';
    const account = installId;
    writeKeychainSecret(service, account, secret);
    return { backend: 'keychain', service, account };
  }

  const service = 'file';
  const account = installId;
  const filePath = getSecretFilePath(service, account);
  ensureDir(dirname(filePath));
  writeFileSync(filePath, secret, { encoding: 'utf-8', mode: 0o600 });
  return { backend: 'file', service, account };
}

function shouldUseKeychain(): boolean {
  if (process.env[SECRET_BACKEND_ENV] === 'file') {
    return false;
  }

  return process.platform === 'darwin';
}

function writeKeychainSecret(service: string, account: string, secret: string): void {
  execFileSync('security', [
    'add-generic-password',
    '-U',
    '-s',
    service,
    '-a',
    account,
    '-w',
    secret,
  ], { stdio: 'pipe' });
}

function readKeychainSecret(service: string, account: string): string {
  return execFileSync('security', [
    'find-generic-password',
    '-s',
    service,
    '-a',
    account,
    '-w',
  ], { encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function readFileSecret(service: string, account: string): string {
  return readFileSync(getSecretFilePath(service, account), 'utf-8').trim();
}

function getSecretFilePath(service: string, account: string): string {
  return join(getConnectBaseDir(), 'secrets', `${service}-${account}.secret`);
}

function buildBundleFromInstallation(installation: ConnectLocalInstallation): ConnectInstallBundle {
  return {
    version: 1,
    transport: 'stdio-relay',
    target: installation.target,
    target_label: installation.target,
    profile: installation.profile,
    profile_label: installation.profile,
    scope: installation.scope,
    scope_effective: installation.scope_effective,
    base_url: installation.base_url,
    servers: installation.servers,
    created_at: installation.created_at,
    expires_at: installation.created_at,
    auth: installation.auth.type === 'none'
      ? { type: 'none' }
      : {
        type: 'bearer',
        secret: readInstallationSecret(installation) ?? '',
        description: installation.auth.description,
        header_name: installation.auth.header_name,
        prefix: installation.auth.prefix,
      },
  };
}
