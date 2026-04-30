import { loadConfigFromEnv } from '../config/loader.js';
import {
  CONNECT_TARGETS,
  exportConnectProfile,
  listConnectProfiles,
  listConnectTargets,
  type ConnectScope,
  type ConnectTarget,
} from '../connect/export.js';
import { installConnectBundle } from '../connect/local.js';
import { syncAllLocalInstallations, syncLocalInstallation } from '../connect/local.js';
import {
  ConnectInstallSessionStore,
  parseConnectDeeplink,
  type ConnectInstallBundle,
} from '../connect/install.js';
import { ConnectRemoteSessionStore } from '../connect/remote.js';
import { runConnectRelay } from '../connect/relay.js';

export async function runConnect(argv: string[]): Promise<void> {
  const subcommand = argv[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printHelp();
    return;
  }

  switch (subcommand) {
    case 'export':
      await runExport(argv.slice(1));
      return;
    case 'install':
      await runInstall(argv.slice(1));
      return;
    case 'create-remote':
      await runCreateRemote(argv.slice(1));
      return;
    case 'relay':
      await runRelay(argv.slice(1));
      return;
    case 'create-install':
      await runCreateInstall(argv.slice(1));
      return;
    case 'sync':
      await runSync(argv.slice(1));
      return;
    case 'import':
      await runImport(argv.slice(1));
      return;
    case 'registry-install':
      await runRegistryInstall(argv.slice(1));
      return;
    default:
      throw new Error(`Unknown connect subcommand "${subcommand}"`);
  }
}

async function runExport(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const target = parseTarget(args.target);
  const scope = parseScope(args.scope ?? 'user');
  const config = loadConfigFromEnv();
  const result = exportConnectProfile(config, {
    target,
    profile: args.profile ?? 'default',
    scope,
    ...(args['base-url'] ? { baseUrl: args['base-url'] } : {}),
  });

  console.log(`Target:    ${result.target_label}`);
  console.log(`Profile:   ${result.profile_label}`);
  console.log(`Scope:     ${result.scope_effective}`);
  console.log(`Placement: ${result.placement}`);
  console.log(`Base URL:  ${result.base_url}`);

  if (result.env.length > 0) {
    console.log('');
    console.log('Environment:');
    for (const env of result.env) {
      console.log(`  ${env.name}  ${env.description}`);
    }
  }

  console.log('');
  console.log(result.title);
  console.log('─'.repeat(result.title.length));
  console.log(result.snippet);

  if (result.notes.length > 0) {
    console.log('');
    console.log('Notes:');
    for (const note of result.notes) {
      console.log(`  - ${note}`);
    }
  }
}

async function runInstall(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const bundleUrl = resolveBundleUrl(args);
  const projectDir = args['project-dir'];

  const res = await fetch(bundleUrl);
  if (!res.ok) {
    throw new Error(`Unable to fetch install bundle: HTTP ${res.status}`);
  }

  const bundle = await res.json() as ConnectInstallBundle;
  const result = installConnectBundle(bundle, {
    ...(projectDir ? { projectDir } : {}),
  });

  console.log(`Installed: ${bundle.target_label}`);
  console.log(`Scope:     ${result.scope_effective}`);
  console.log(`Config:    ${result.config_path}`);
  console.log(`Manifest:  ${result.installation_path}`);
  console.log('');
  console.log('Servers:');
  for (const alias of result.installed_servers) {
    console.log(`  - ${alias}`);
  }
  console.log('');
  console.log(`Relay command is now managed through installation ${result.installation.id}.`);
}

async function runRelay(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const installId = args['install-id'];
  const serverId = args['server-id'];

  if (!installId) {
    throw new Error('--install-id is required');
  }

  if (!serverId) {
    throw new Error('--server-id is required');
  }

  await runConnectRelay(installId, serverId);
}

async function runCreateInstall(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const target = parseTarget(args.target);
  const scope = parseScope(args.scope ?? 'user');
  const bundleBaseUrl = args['bundle-base-url'] ?? args['base-url'];
  if (!bundleBaseUrl) {
    throw new Error('--bundle-base-url is required');
  }

  const config = loadConfigFromEnv();
  const store = new ConnectInstallSessionStore();
  const session = store.createSession(config, {
    target,
    profile: args.profile ?? 'default',
    scope,
    ...(args['base-url'] ? { baseUrl: args['base-url'] } : {}),
    ...(args['auth-secret'] ? { authSecret: args['auth-secret'] } : {}),
    bundleBaseUrl,
  });

  console.log(`Bundle URL: ${session.bundle_url}`);
  if (session.deeplink) {
    console.log(`Deep link:  ${session.deeplink}`);
  }
  console.log(`Command:    ${session.install_command}`);
  console.log(`Expires:    ${session.expires_at}`);
}

async function runCreateRemote(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const target = parseTarget(args.target);
  const scope = parseScope(args.scope ?? 'user');
  const bundleBaseUrl = args['bundle-base-url'] ?? args['base-url'];
  if (!bundleBaseUrl) {
    throw new Error('--bundle-base-url is required');
  }

  const config = loadConfigFromEnv();
  const store = new ConnectRemoteSessionStore();
  const session = store.createSession(config, {
    target,
    profile: args.profile ?? 'default',
    scope,
    ...(args['base-url'] ? { baseUrl: args['base-url'] } : {}),
    bundleBaseUrl,
  });

  console.log(`Bundle URL:   ${session.bundle_url}`);
  console.log(`Profile URL:  ${session.profile_url}`);
  console.log(`Target page:  ${session.settings_url}`);
  console.log(`Ready:        ${session.remote_ready ? 'yes' : 'no'}`);
  console.log(`Expires:      ${session.expires_at}`);

  if (session.blockers.length > 0) {
    console.log('');
    console.log('Blockers:');
    for (const blocker of session.blockers) {
      console.log(`  - ${blocker}`);
    }
  }
}

async function runSync(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const projectDir = args['project-dir'];

  if (args['install-id']) {
    const result = syncLocalInstallation(args['install-id'], {
      ...(projectDir ? { projectDir } : {}),
    });
    printSyncResult(result);
    return;
  }

  const results = syncAllLocalInstallations();
  if (results.length === 0) {
    console.log('No local connect installations found.');
    return;
  }

  for (const result of results) {
    printSyncResult(result);
    console.log('');
  }
}

async function runImport(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const baseUrl = args['base-url'];
  if (!baseUrl) {
    throw new Error('--base-url is required');
  }

  const adminKey = args['admin-key'] ?? process.env['CONDUIT_ADMIN_KEY'];
  const body: Record<string, unknown> = {
    ...(args['descriptor-url'] ? { descriptor_url: args['descriptor-url'] } : {}),
    ...(args['descriptor-json'] ? { descriptor: JSON.parse(args['descriptor-json']) } : {}),
    ...(args['profile-id'] ? { profile_id: args['profile-id'] } : {}),
  };

  if (!body['descriptor_url'] && !body['descriptor']) {
    throw new Error('--descriptor-url or --descriptor-json is required');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Conduit-Admin': 'true',
  };
  if (adminKey) {
    headers['Authorization'] = `Bearer ${adminKey}`;
  }

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/conduit/connect/import`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const responseBody = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(String(responseBody['error'] ?? `HTTP ${res.status}`));
  }

  console.log(`Imported: ${((responseBody['imported_servers'] as string[] | undefined) ?? []).join(', ') || 'none'}`);
  if (Array.isArray(responseBody['profiles_updated']) && responseBody['profiles_updated'].length > 0) {
    console.log(`Profiles: ${responseBody['profiles_updated'].join(', ')}`);
  }
  if (Array.isArray(responseBody['skipped_servers']) && responseBody['skipped_servers'].length > 0) {
    console.log(`Skipped:  ${responseBody['skipped_servers'].map((item) => `${(item as { id: string }).id}`).join(', ')}`);
  }
}

async function runRegistryInstall(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const baseUrl = args['base-url'];
  const serverName = args['server-name'];
  if (!baseUrl) {
    throw new Error('--base-url is required');
  }
  if (!serverName) {
    throw new Error('--server-name is required');
  }

  const target = parseTarget(args.target);
  const scope = parseScope(args.scope ?? 'user');
  const adminKey = args['admin-key'] ?? process.env['CONDUIT_ADMIN_KEY'];
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Conduit-Admin': 'true',
  };
  if (adminKey) {
    headers['Authorization'] = `Bearer ${adminKey}`;
  }

  const body: Record<string, unknown> = {
    server_name: serverName,
    target,
    scope,
    ...(args.version ? { version: args.version } : {}),
    ...(args['profile-id'] ? { profile_id: args['profile-id'] } : {}),
    ...(args['auth-secret'] ? { auth_secret: args['auth-secret'] } : {}),
    ...(args.strategy ? { strategy: args.strategy } : {}),
    ...parseJsonMapArg(args['variables-json'], 'variables-json', 'variables'),
    ...parseJsonMapArg(args['headers-json'], 'headers-json', 'headers'),
    ...parseJsonMapArg(args['env-json'], 'env-json', 'env'),
  };

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/conduit/connect/registry/install`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const responseBody = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(String(responseBody['error'] ?? `HTTP ${res.status}`));
  }

  console.log(`Profile:    ${String(responseBody['profile_id'] ?? 'unknown')}`);
  const imported = (responseBody['imported_servers'] as string[] | undefined) ?? [];
  const updated = (responseBody['updated_servers'] as string[] | undefined) ?? [];
  const changed = [...imported, ...updated];
  console.log(`Servers:    ${changed.join(', ') || 'none'}`);

  const session = responseBody['install_session'] as Record<string, string> | undefined;
  const remoteSession = responseBody['remote_session'] as Record<string, string | boolean | string[]> | undefined;
  if (session) {
    console.log(`Bundle URL: ${session['bundle_url']}`);
    if (session['deeplink']) {
      console.log(`Deep link:  ${session['deeplink']}`);
    }
    console.log(`Command:    ${session['install_command']}`);
  }
  if (remoteSession) {
    console.log(`Bundle URL:  ${remoteSession['bundle_url']}`);
    console.log(`Profile URL: ${remoteSession['profile_url']}`);
    console.log(`Target URL:  ${remoteSession['settings_url']}`);
    console.log(`Ready:       ${remoteSession['remote_ready'] ? 'yes' : 'no'}`);
  }
}

function resolveBundleUrl(args: Record<string, string>): string {
  if (args['bundle-url']) {
    return args['bundle-url'];
  }

  if (args.deeplink) {
    return parseConnectDeeplink(args.deeplink);
  }

  if (args.token && args['base-url']) {
    const base = args['base-url'].replace(/\/+$/, '');
    return `${base}/conduit/connect/install/bundles/${args.token}`;
  }

  throw new Error('Use --bundle-url, --deeplink, or --token with --base-url');
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current?.startsWith('--')) continue;

    const key = current.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      if (key === 'all') {
        args[key] = 'true';
        continue;
      }
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    i += 1;
  }

  return args;
}

function parseTarget(value: string | undefined): ConnectTarget {
  if (!value || !CONNECT_TARGETS.includes(value as ConnectTarget)) {
    throw new Error(`--target is required and must be one of: ${CONNECT_TARGETS.join(', ')}`);
  }

  return value as ConnectTarget;
}

function parseScope(value: string): ConnectScope {
  if (value !== 'user' && value !== 'project') {
    throw new Error('--scope must be either "user" or "project"');
  }

  return value;
}

function printHelp(): void {
  const targets = listConnectTargets().map((target) => `    - ${target.id}`).join('\n');
  const profiles = listConnectProfiles(loadConfigFromEnv()).map((profile) => `    - ${profile.id}`).join('\n');

  console.log(`
  conduit connect export --target <target> [options]
  conduit connect create-install --target <target> --bundle-base-url <url> [options]
  conduit connect create-remote --target <target> --bundle-base-url <url> [options]
  conduit connect install --bundle-url <url> [--project-dir <path>]
  conduit connect relay --install-id <id> --server-id <server>
  conduit connect sync [--all] [--install-id <id>] [--project-dir <path>]
  conduit connect import --base-url <url> --descriptor-url <url>
  conduit connect registry-install --base-url <url> --server-name <name> --target <target>

  Targets:
${targets}

  Profiles:
${profiles}

  Export / install options:
    --profile <name>       Profile to export (default: default)
    --scope <scope>        user | project (default: user)
    --base-url <url>       Override the Conduit base URL embedded in configs

  Phase 2 install options:
    --bundle-base-url <url>  Base Conduit URL used to publish a temporary install bundle
    --auth-secret <token>    Bearer token to store in the local helper backend
    --bundle-url <url>       Full install bundle URL
    --deeplink <url>         conduit://install deep link
    --project-dir <path>     Project root for project-scoped installs
    --descriptor-url <url>   Remote server descriptor to import into a running Conduit gateway
    --descriptor-json <json> Inline server descriptor JSON to import
    --profile-id <id>        Attach imported servers to this connect profile
    --admin-key <token>      Admin key for the running Conduit gateway
    --server-name <name>     Official registry server name to install
    --version <value>        Registry version (default: latest)
    --headers-json <json>    JSON object for required remote headers
    --variables-json <json>  JSON object for required URL template variables
    --env-json <json>        JSON object for required package environment values

  Examples:
    conduit connect export --target cursor --profile default --scope project
    conduit connect create-install --target cursor --bundle-base-url http://127.0.0.1:8080 --auth-secret sk-demo
    conduit connect create-remote --target claude --bundle-base-url https://conduit.example.com --base-url https://conduit.example.com
    conduit connect install --bundle-url http://127.0.0.1:8080/conduit/connect/install/bundles/abc
    conduit connect sync --all
    conduit connect sync --install-id 123e4567-e89b-12d3-a456-426614174000
    conduit connect import --base-url http://127.0.0.1:8080 --descriptor-url https://example.com/.well-known/mcp-server.json
    conduit connect registry-install --base-url http://127.0.0.1:8080 --server-name ai.fodda/mcp-server --target cursor --headers-json '{"Authorization":"Bearer fk_live_..."}'
`);
}

function printSyncResult(result: Awaited<ReturnType<typeof syncLocalInstallation>>): void {
  console.log(`Synced:     ${result.installation.id}`);
  console.log(`Target:     ${result.installation.target}`);
  console.log(`Profile:    ${result.installation.profile}`);
  console.log(`Config:     ${result.config_path}`);
  console.log(`Repaired:   ${result.repaired_servers.join(', ')}`);
}

function parseJsonMapArg(
  raw: string | undefined,
  flagName: string,
  bodyKey: 'variables' | 'headers' | 'env',
): Partial<Record<typeof bodyKey, Record<string, string>>> {
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--${flagName} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--${flagName} must be a JSON object`);
  }

  const value = Object.fromEntries(
    Object.entries(parsed).map(([key, entryValue]) => [key, String(entryValue)]),
  );
  return { [bodyKey]: value } as Partial<Record<typeof bodyKey, Record<string, string>>>;
}
