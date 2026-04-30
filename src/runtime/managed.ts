import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ConnectManagedRuntimeConfig,
  ManagedRuntimeChannel,
  ManagedRuntimeReleaseConfig,
  ManagedRuntimeServerConfig,
  ManagedRuntimeSourceType,
  ServerConfig,
} from '../config/types.js';
import type { ServerInfo } from '../router/registry.js';
import { assertSafeSystemPath } from '../utils/path-guard.js';

export interface ManagedRuntimeLaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ManagedRuntimeSummary {
  server_id: string;
  source_type: ManagedRuntimeSourceType;
  source_ref: string;
  channel: ManagedRuntimeChannel;
  active_release_id: string;
  current_version: string;
  healthy: boolean;
  tool_count: number;
  latency_ms: number;
  last_checked?: string;
  last_rollout_at?: string;
  last_healthy_release_id?: string;
  sandbox: {
    enabled: boolean;
    root_dir: string;
    sanitize_env: boolean;
    allow_network: boolean;
  };
  health_gate: {
    enabled: boolean;
    auto_rollback: boolean;
  };
  releases: ManagedRuntimeReleaseConfig[];
}

const DEFAULT_MANAGED_RUNTIME: Required<ConnectManagedRuntimeConfig> = {
  enabled: true,
  root_dir: './.conduit/runtime',
  default_channel: 'stable',
  sanitize_env: true,
  auto_rollback: true,
};

export function resolveConnectManagedRuntimeConfig(
  raw: ConnectManagedRuntimeConfig | undefined,
): Required<ConnectManagedRuntimeConfig> {
  return {
    enabled: raw?.enabled ?? DEFAULT_MANAGED_RUNTIME.enabled,
    root_dir: raw?.root_dir ?? DEFAULT_MANAGED_RUNTIME.root_dir,
    default_channel: raw?.default_channel ?? DEFAULT_MANAGED_RUNTIME.default_channel,
    sanitize_env: raw?.sanitize_env ?? DEFAULT_MANAGED_RUNTIME.sanitize_env,
    auto_rollback: raw?.auto_rollback ?? DEFAULT_MANAGED_RUNTIME.auto_rollback,
  };
}

export function isManagedRuntimeServer(server: ServerConfig): boolean {
  return server.transport === 'stdio' && server.managed_runtime?.enabled === true;
}

export function getActiveManagedRelease(server: ServerConfig): ManagedRuntimeReleaseConfig | undefined {
  const runtime = server.managed_runtime;
  if (!runtime?.enabled) return undefined;
  return runtime.releases.find((release) => release.id === runtime.active_release_id);
}

export function createManagedRuntimeForPackage(input: {
  serverId: string;
  sourceType: Extract<ManagedRuntimeSourceType, 'npm' | 'pypi' | 'oci'>;
  sourceRef: string;
  version: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  defaults?: ConnectManagedRuntimeConfig;
}): ManagedRuntimeServerConfig {
  const defaults = resolveConnectManagedRuntimeConfig(input.defaults);
  const createdAt = new Date().toISOString();
  const release = createRelease({
    channel: defaults.default_channel,
    version: input.version,
    command: input.command,
    args: input.args,
    createdAt,
    status: 'active',
    ...(input.env ? { env: input.env } : {}),
  });

  return {
    enabled: defaults.enabled,
    source_type: input.sourceType,
    source_ref: input.sourceRef,
    channel: release.channel,
    active_release_id: release.id,
    last_healthy_release_id: release.id,
    last_rollout_at: createdAt,
    sandbox: {
      enabled: true,
      root_dir: join(defaults.root_dir, input.serverId),
      sanitize_env: defaults.sanitize_env,
      allow_network: true,
    },
    health_gate: {
      enabled: true,
      auto_rollback: defaults.auto_rollback,
    },
    releases: [release],
  };
}

export function buildManagedRuntimeLaunchSpec(server: ServerConfig): ManagedRuntimeLaunchSpec | null {
  if (!isManagedRuntimeServer(server)) {
    return null;
  }

  const runtime = server.managed_runtime!;
  const release = getActiveManagedRelease(server);
  const command = release?.command ?? server.command;
  if (!command) {
    throw new Error(`Managed runtime "${server.id}" has no executable command`);
  }

  const args = [...(release?.args ?? server.args ?? [])];
  const sandboxEnabled = runtime.sandbox?.enabled !== false;
  const sanitizeEnv = runtime.sandbox?.sanitize_env !== false;
  const sandboxRoot = assertSafeSystemPath(
    runtime.sandbox?.root_dir ?? join(DEFAULT_MANAGED_RUNTIME.root_dir, server.id),
    `managed_runtime.sandbox.root_dir for "${server.id}"`,
  );

  // Even in non-sanitize mode, never inherit known-leaky env vars from the
  // parent process — they would carry registry credentials or CI tokens into
  // the sandboxed child where third-party code may exfiltrate them.
  let env: NodeJS.ProcessEnv = sanitizeEnv
    ? pickSandboxEnv(process.env)
    : stripSandboxLeakyEnv(process.env);
  if (sandboxEnabled) {
    try {
      mkdirSync(sandboxRoot, { recursive: true });
    } catch (error) {
      throw new Error(
        `Managed runtime "${server.id}" failed to create sandbox at ${sandboxRoot}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    env = {
      ...env,
      HOME: sandboxRoot,
      XDG_CACHE_HOME: join(sandboxRoot, 'cache'),
      XDG_CONFIG_HOME: join(sandboxRoot, 'config'),
      XDG_DATA_HOME: join(sandboxRoot, 'data'),
      npm_config_cache: join(sandboxRoot, 'npm-cache'),
      PIP_CACHE_DIR: join(sandboxRoot, 'pip-cache'),
      UV_CACHE_DIR: join(sandboxRoot, 'uv-cache'),
      CONDUIT_SANDBOX_ROOT: sandboxRoot,
      CONDUIT_SANDBOX_NETWORK: runtime.sandbox?.allow_network === false ? 'disabled' : 'enabled',
    };
  }

  env = {
    ...env,
    ...(server.env ?? {}),
    ...(release?.env ?? {}),
  };

  return {
    command,
    args,
    env,
    ...(sandboxEnabled ? { cwd: sandboxRoot } : {}),
  };
}

export function rolloutManagedRuntime(
  server: ServerConfig,
  input: {
    version: string;
    channel?: ManagedRuntimeChannel;
    env?: Record<string, string>;
    notes?: string;
    command?: string;
    args?: string[];
  },
): { server: ServerConfig; release: ManagedRuntimeReleaseConfig; previousReleaseId?: string } {
  if (!isManagedRuntimeServer(server)) {
    throw new Error(`Server "${server.id}" is not managed by the runtime plane`);
  }

  const runtime = server.managed_runtime!;
  const nextChannel = input.channel ?? runtime.channel;
  const createdAt = new Date().toISOString();
  const nextEnv = {
    ...(server.env ?? {}),
    ...(input.env ?? {}),
  };
  const commandRuntime = {
    ...(input.command ? { command: input.command } : {}),
    ...(input.args ? { args: input.args } : {}),
  };
  const release = createRelease({
    channel: nextChannel,
    version: input.version,
    createdAt,
    status: 'candidate',
    ...buildReleaseCommand(runtime.source_type, runtime.source_ref, input.version, nextEnv, commandRuntime),
    ...(input.notes ? { notes: input.notes } : {}),
  });

  const clone = cloneServer(server);
  const previousReleaseId = clone.managed_runtime?.active_release_id;
  if (!clone.managed_runtime) {
    throw new Error(`Server "${server.id}" lost managed_runtime metadata`);
  }

  clone.command = release.command;
  clone.args = [...(release.args ?? [])];
  if (release.env) {
    clone.env = { ...release.env };
  } else {
    delete clone.env;
  }
  clone.managed_runtime.channel = nextChannel;
  clone.managed_runtime.active_release_id = release.id;
  clone.managed_runtime.last_rollout_at = createdAt;
  clone.managed_runtime.releases = clone.managed_runtime.releases.map((existing) =>
    existing.id === previousReleaseId
      ? { ...existing, status: existing.id === clone.managed_runtime?.last_healthy_release_id ? 'healthy' : existing.status ?? 'healthy' }
      : existing,
  );
  clone.managed_runtime.releases.push(release);

  return { server: clone, release, ...(previousReleaseId ? { previousReleaseId } : {}) };
}

export function markManagedRuntimeRelease(
  server: ServerConfig,
  releaseId: string,
  outcome: 'healthy' | 'failed' | 'rolled_back',
): ServerConfig {
  const clone = cloneServer(server);
  const runtime = clone.managed_runtime;
  if (!runtime?.enabled) {
    return clone;
  }

  runtime.releases = runtime.releases.map((release) =>
    release.id === releaseId
      ? {
        ...release,
        status: outcome === 'healthy' && runtime.active_release_id === releaseId ? 'active' : outcome,
      }
      : release,
  );

  if (outcome === 'healthy') {
    runtime.last_healthy_release_id = releaseId;
  }

  return clone;
}

export function rollbackManagedRuntime(
  server: ServerConfig,
  releaseId?: string,
): ServerConfig {
  if (!isManagedRuntimeServer(server)) {
    throw new Error(`Server "${server.id}" is not managed by the runtime plane`);
  }

  const clone = cloneServer(server);
  const runtime = clone.managed_runtime!;
  const currentReleaseId = runtime.active_release_id;
  const fallbackId = releaseId
    ?? runtime.last_healthy_release_id
    ?? runtime.releases.find((candidate) => candidate.id !== currentReleaseId)?.id;

  if (!fallbackId) {
    throw new Error(`Managed runtime "${server.id}" has no rollback target`);
  }

  const target = runtime.releases.find((release) => release.id === fallbackId);
  if (!target) {
    throw new Error(`Managed runtime "${server.id}" cannot find rollback release "${fallbackId}"`);
  }

  runtime.releases = runtime.releases.map((release) => {
    if (release.id === currentReleaseId) {
      return { ...release, status: 'rolled_back' };
    }
    if (release.id === fallbackId) {
      return { ...release, status: 'active' };
    }
    return release;
  });
  runtime.active_release_id = fallbackId;
  runtime.channel = target.channel;
  runtime.last_healthy_release_id = fallbackId;
  runtime.last_rollout_at = new Date().toISOString();
  clone.command = target.command;
  clone.args = [...(target.args ?? [])];
  if (target.env) {
    clone.env = { ...target.env };
  } else {
    delete clone.env;
  }
  return clone;
}

export function summarizeManagedRuntime(serverInfo: ServerInfo): ManagedRuntimeSummary | null {
  if (!isManagedRuntimeServer(serverInfo.config)) {
    return null;
  }

  const runtime = serverInfo.config.managed_runtime!;
  const active = getActiveManagedRelease(serverInfo.config);
  // summarize doesn't throw: fall back to a naive resolve if the path is unsafe so callers get a visible string.
  const rawSandboxRoot = runtime.sandbox?.root_dir ?? join(DEFAULT_MANAGED_RUNTIME.root_dir, serverInfo.config.id);
  let sandboxRoot: string;
  try {
    sandboxRoot = assertSafeSystemPath(rawSandboxRoot, `managed_runtime.sandbox.root_dir for "${serverInfo.config.id}"`);
  } catch {
    sandboxRoot = resolve(rawSandboxRoot);
  }

  return {
    server_id: serverInfo.config.id,
    source_type: runtime.source_type,
    source_ref: runtime.source_ref,
    channel: runtime.channel,
    active_release_id: runtime.active_release_id,
    current_version: active?.version ?? 'unknown',
    healthy: serverInfo.health.healthy,
    tool_count: serverInfo.tools.length,
    latency_ms: serverInfo.health.latencyMs,
    ...(serverInfo.health.lastChecked > 0 ? { last_checked: new Date(serverInfo.health.lastChecked).toISOString() } : {}),
    ...(runtime.last_rollout_at ? { last_rollout_at: runtime.last_rollout_at } : {}),
    ...(runtime.last_healthy_release_id ? { last_healthy_release_id: runtime.last_healthy_release_id } : {}),
    sandbox: {
      enabled: runtime.sandbox?.enabled !== false,
      root_dir: sandboxRoot,
      sanitize_env: runtime.sandbox?.sanitize_env !== false,
      allow_network: runtime.sandbox?.allow_network !== false,
    },
    health_gate: {
      enabled: runtime.health_gate?.enabled !== false,
      auto_rollback: runtime.health_gate?.auto_rollback !== false,
    },
    releases: runtime.releases.map((release) => ({
      ...release,
      ...(release.args ? { args: [...release.args] } : {}),
      ...(release.env ? { env: { ...release.env } } : {}),
    })),
  };
}

function createRelease(input: {
  version: string;
  channel: ManagedRuntimeChannel;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  createdAt: string;
  status: ManagedRuntimeReleaseConfig['status'];
  notes?: string;
}): ManagedRuntimeReleaseConfig {
  return {
    id: `${input.channel}-${sanitizeToken(input.version)}-${Date.now()}`,
    version: input.version,
    channel: input.channel,
    command: input.command,
    ...(input.args?.length ? { args: [...input.args] } : {}),
    ...(input.env && Object.keys(input.env).length > 0 ? { env: { ...input.env } } : {}),
    created_at: input.createdAt,
    ...(input.status ? { status: input.status } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

function buildReleaseCommand(
  sourceType: ManagedRuntimeSourceType,
  sourceRef: string,
  version: string,
  env?: Record<string, string>,
  commandRuntime?: {
    command?: string;
    args?: string[];
  },
): { command: string; args: string[]; env?: Record<string, string> } {
  switch (sourceType) {
    case 'npm':
      return {
        command: 'npx',
        args: ['-y', buildVersionedPackageIdentifier(sourceRef, version)],
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
      };
    case 'pypi':
      return {
        command: 'uvx',
        args: [version ? `${sourceRef}==${version}` : sourceRef],
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
      };
    case 'oci':
      return {
        command: 'docker',
        args: ['run', '-i', '--rm', ...(env ? flattenDockerEnv(env) : []), sourceRef],
      };
    case 'command':
      if (!commandRuntime?.command) {
        throw new Error('Command runtimes must provide an explicit command to rollout');
      }
      return {
        command: commandRuntime.command,
        args: [...(commandRuntime.args ?? [])],
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
      };
    default:
      throw new Error(`Unsupported managed runtime source "${sourceType}"`);
  }
}

function buildVersionedPackageIdentifier(identifier: string, version: string): string {
  if (!version) {
    return identifier;
  }

  if (identifier.startsWith('@')) {
    const secondAt = identifier.indexOf('@', 1);
    return secondAt === -1 ? `${identifier}@${version}` : identifier;
  }

  return identifier.includes('@') ? identifier : `${identifier}@${version}`;
}

function flattenDockerEnv(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
}

function pickSandboxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'ComSpec', 'PATHEXT'];
  const picked: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (env[key] !== undefined) {
      picked[key] = env[key];
    }
  }
  return picked;
}

/**
 * Audit Sprint 3 #6 — sandbox parent-env contamination.
 *
 * Even when `sanitize_env: false` (operator opts to inherit the parent env),
 * a small set of keys are *never* safe to pass through:
 *   - npm_config_*  : parent registry/cafile/proxy settings can redirect the
 *                     child to a hostile registry or trust an attacker CA.
 *   - NPM_TOKEN, NODE_AUTH_TOKEN, GITHUB_TOKEN, NUGET_API_KEY, ...:
 *                     CI tokens that would otherwise be forwarded to packages
 *                     installed/run in the sandbox.
 *   - PIP_*, UV_INDEX_URL, POETRY_HTTP_BASIC_*: same risk on the Python side.
 *
 * The gateway re-injects its own controlled values (npm_config_cache, HOME,
 * etc.) AFTER this strip, so legitimate sandbox configuration is preserved.
 */
const SANDBOX_ENV_DENYLIST_PREFIXES = [
  'npm_config_',
  'pip_',
  'pipx_',
  'poetry_',
  'uv_',
  'cargo_',
];
const SANDBOX_ENV_DENYLIST_KEYS = new Set([
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'NUGET_API_KEY',
  'TWINE_USERNAME',
  'TWINE_PASSWORD',
  'PYPI_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CONDUIT_ADMIN_KEY',
]);

export function stripSandboxLeakyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (SANDBOX_ENV_DENYLIST_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    if (SANDBOX_ENV_DENYLIST_KEYS.has(key.toUpperCase())) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function sanitizeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function cloneServer(server: ServerConfig): ServerConfig {
  return JSON.parse(JSON.stringify(server)) as ServerConfig;
}
