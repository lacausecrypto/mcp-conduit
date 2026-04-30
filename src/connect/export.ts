import type { ConduitGatewayConfig, ServerConfig } from '../config/types.js';
import type { AuthMethod } from '../auth/types.js';
import { toTomlKey, toTomlString } from './toml.js';

export const CONNECT_TARGETS = [
  'cursor',
  'claude-code',
  'claude-desktop',
  'codex',
  'windsurf',
  'vscode',
  'generic-json',
  'claude',
  'chatgpt',
  'v0',
] as const;
export type ConnectTarget = typeof CONNECT_TARGETS[number];
export type ConnectScope = 'user' | 'project';
export type ConnectTargetDelivery = 'local-helper' | 'remote-connector';

export interface ConnectTargetDefinition {
  id: ConnectTarget;
  label: string;
  format: 'json' | 'shell' | 'toml';
  delivery: ConnectTargetDelivery;
}

export interface ConnectProfileSummary {
  id: string;
  label: string;
  description: string;
  server_ids: string[];
}

export interface ConnectServerBinding {
  id: string;
  alias: string;
  url: string;
}

export interface ConnectEnvRequirement {
  name: string;
  description: string;
}

export interface ConnectExportResult {
  target: ConnectTarget;
  target_label: string;
  profile: string;
  profile_label: string;
  scope: ConnectScope;
  scope_effective: ConnectScope | 'global';
  format: 'json' | 'shell' | 'toml';
  title: string;
  placement: string;
  base_url: string;
  snippet: string;
  notes: string[];
  env: ConnectEnvRequirement[];
  servers: ConnectServerBinding[];
}

export interface ConnectExportOptions {
  target: ConnectTarget;
  profile?: string;
  scope?: ConnectScope;
  baseUrl?: string;
}

const TARGET_DEFINITIONS: ConnectTargetDefinition[] = [
  { id: 'cursor', label: 'Cursor', format: 'json', delivery: 'local-helper' },
  { id: 'claude-code', label: 'Claude Code', format: 'shell', delivery: 'local-helper' },
  { id: 'claude-desktop', label: 'Claude Desktop', format: 'json', delivery: 'local-helper' },
  { id: 'codex', label: 'Codex', format: 'toml', delivery: 'local-helper' },
  { id: 'windsurf', label: 'Windsurf', format: 'json', delivery: 'local-helper' },
  { id: 'vscode', label: 'VS Code', format: 'json', delivery: 'local-helper' },
  { id: 'generic-json', label: 'Generic JSON', format: 'json', delivery: 'local-helper' },
  { id: 'claude', label: 'Claude', format: 'json', delivery: 'remote-connector' },
  { id: 'chatgpt', label: 'ChatGPT', format: 'json', delivery: 'remote-connector' },
  { id: 'v0', label: 'v0', format: 'json', delivery: 'remote-connector' },
];

export interface ResolvedConnectProfile {
  id: string;
  label: string;
  description: string;
  servers: ServerConfig[];
}

interface AuthExportSpec {
  method: AuthMethod;
  envVar?: string;
  description?: string;
}

export function listConnectTargets(): ConnectTargetDefinition[] {
  return TARGET_DEFINITIONS.map((target) => ({ ...target }));
}

export function listConnectProfiles(config: ConduitGatewayConfig): ConnectProfileSummary[] {
  return resolveAllConnectProfiles(config).map((profile) => ({
    id: profile.id,
    label: profile.label,
    description: profile.description,
    server_ids: profile.servers.map((server) => server.id),
  }));
}

export function exportConnectProfile(
  config: ConduitGatewayConfig,
  options: ConnectExportOptions,
): ConnectExportResult {
  const profile = resolveConnectProfile(config, options.profile ?? 'default');
  const target = TARGET_DEFINITIONS.find((item) => item.id === options.target);
  if (!target) {
    throw new Error(`Unsupported connect target "${options.target}"`);
  }

  const scope = options.scope ?? 'user';
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? deriveBaseUrl(config));
  const auth = deriveAuthExportSpec(config);
  const servers = profile.servers.map((server) => ({
    id: server.id,
    alias: buildAlias(server.id, target.id),
    url: `${baseUrl}/mcp/${encodeURIComponent(server.id)}`,
  }));

  switch (target.id) {
    case 'cursor':
      return buildCursorExport(target, profile, scope, baseUrl, auth, servers);
    case 'claude-code':
      return buildClaudeCodeExport(target, profile, scope, baseUrl, auth, servers);
    case 'claude-desktop':
      return buildClaudeDesktopExport(target, profile, scope, baseUrl, auth, servers);
    case 'codex':
      return buildCodexExport(target, profile, scope, baseUrl, auth, servers);
    case 'windsurf':
      return buildWindsurfExport(target, profile, scope, baseUrl, auth, servers);
    case 'vscode':
      return buildVsCodeExport(target, profile, scope, baseUrl, auth, servers);
    case 'generic-json':
      return buildGenericJsonExport(target, profile, scope, baseUrl, auth, servers);
    case 'claude':
      return buildClaudeRemoteExport(target, profile, scope, baseUrl, auth);
    case 'chatgpt':
      return buildChatGptRemoteExport(target, profile, scope, baseUrl, auth);
    case 'v0':
      return buildV0RemoteExport(target, profile, scope, baseUrl, auth);
  }
}

export function getConnectTargetDefinition(target: ConnectTarget): ConnectTargetDefinition {
  const definition = TARGET_DEFINITIONS.find((item) => item.id === target);
  if (!definition) {
    throw new Error(`Unsupported connect target "${target}"`);
  }
  return { ...definition };
}

export function isRemoteConnectTarget(target: ConnectTarget): boolean {
  return getConnectTargetDefinition(target).delivery === 'remote-connector';
}

export function buildConnectProfileUrl(baseUrl: string, profileId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/mcp/profile/${encodeURIComponent(profileId)}`;
}

export function deriveBaseUrl(config: ConduitGatewayConfig): string {
  const scheme = config.gateway.tls?.enabled ? 'https' : 'http';
  const host = normalizeListenHost(config.gateway.host);
  return `${scheme}://${host}:${config.gateway.port}`;
}

export function resolveConnectProfile(
  config: ConduitGatewayConfig,
  profileId: string,
): ResolvedConnectProfile {
  const profiles = resolveAllConnectProfiles(config);
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error(`Unknown connect profile "${profileId}"`);
  }

  return profile;
}

export function resolveAllConnectProfiles(config: ConduitGatewayConfig): ResolvedConnectProfile[] {
  const builtIn: ResolvedConnectProfile = {
    id: 'default',
    label: 'Default',
    description: 'All configured upstream MCP servers exposed through this Conduit gateway.',
    servers: config.servers,
  };

  const configured = (config.connect?.profiles ?? []).map((profile) => ({
    id: profile.id,
    label: profile.label ?? titleCaseId(profile.id),
    description: profile.description ?? `Selected Conduit servers for profile "${profile.id}".`,
    servers: profile.server_ids
      .map((serverId) => config.servers.find((server) => server.id === serverId))
      .filter((server): server is ServerConfig => Boolean(server)),
  }));

  return [builtIn, ...configured];
}

function buildCursorExport(
  target: ConnectTargetDefinition,
  profile: ResolvedConnectProfile,
  scope: ConnectScope,
  baseUrl: string,
  auth: AuthExportSpec,
  servers: ConnectServerBinding[],
): ConnectExportResult {
  const snippet = JSON.stringify({
    mcpServers: Object.fromEntries(servers.map((server) => [
      server.alias,
      {
        url: server.url,
        ...(auth.envVar ? { headers: { Authorization: `Bearer \${env:${auth.envVar}}` } } : {}),
      },
    ])),
  }, null, 2);

  return {
    target: target.id,
    target_label: target.label,
    profile: profile.id,
    profile_label: profile.label,
    scope,
    scope_effective: scope,
    format: target.format,
    title: 'Cursor MCP configuration',
    placement: scope === 'project' ? '.cursor/mcp.json' : '~/.cursor/mcp.json',
    base_url: baseUrl,
    snippet,
    notes: [
      'Cursor discovers MCP servers from mcp.json files in the workspace or home directory.',
      auth.envVar
        ? `Set ${auth.envVar} in your shell before launching Cursor so the Authorization header resolves correctly.`
        : 'No gateway authentication is configured, so no Authorization header is required.',
      'Each exported entry points to a single Conduit-routed MCP server under /mcp/:serverId.',
    ],
    env: auth.envVar ? [{ name: auth.envVar, description: auth.description ?? 'Conduit bearer token' }] : [],
    servers,
  };
}

function buildClaudeCodeExport(
  target: ConnectTargetDefinition,
  profile: ResolvedConnectProfile,
  scope: ConnectScope,
  baseUrl: string,
  auth: AuthExportSpec,
  servers: ConnectServerBinding[],
): ConnectExportResult {
  const commands = servers.map((server) => {
    const parts = [
      'claude mcp add',
      '--transport http',
      `--scope ${scope}`,
    ];

    if (auth.envVar) {
      parts.push(`--header "Authorization: Bearer $${auth.envVar}"`);
    }

    parts.push(server.alias);
    parts.push(server.url);
    return parts.join(' ');
  });

  return {
    target: target.id,
    target_label: target.label,
    profile: profile.id,
    profile_label: profile.label,
    scope,
    scope_effective: scope,
    format: target.format,
    title: 'Claude Code install commands',
    placement: scope === 'project' ? '.mcp.json' : '~/.claude.json',
    base_url: baseUrl,
    snippet: commands.join('\n'),
    notes: [
      'Run each command once to register the Conduit-routed servers in Claude Code.',
      auth.envVar
        ? `Export ${auth.envVar} in your shell before running these commands so Claude Code stores the header placeholder you intend to use.`
        : 'No gateway authentication is configured, so the commands omit Authorization headers.',
      'Use --scope user for machine-wide installs and --scope project for repository-level installs.',
    ],
    env: auth.envVar ? [{ name: auth.envVar, description: auth.description ?? 'Conduit bearer token' }] : [],
    servers,
  };
}

function buildWindsurfExport(
  target: ConnectTargetDefinition,
  profile: ResolvedConnectProfile,
  scope: ConnectScope,
  baseUrl: string,
  auth: AuthExportSpec,
  servers: ConnectServerBinding[],
): ConnectExportResult {
  const snippet = JSON.stringify({
    mcpServers: Object.fromEntries(servers.map((server) => [
      server.alias,
      {
        serverUrl: server.url,
        ...(auth.envVar ? { headers: { Authorization: `Bearer \${env:${auth.envVar}}` } } : {}),
      },
    ])),
  }, null, 2);

  return {
    target: target.id,
    target_label: target.label,
    profile: profile.id,
    profile_label: profile.label,
    scope,
    scope_effective: 'global',
    format: target.format,
    title: 'Windsurf MCP configuration',
    placement: '~/.codeium/mcp_config.json',
    base_url: baseUrl,
    snippet,
    notes: [
      'Conduit targets the current Windsurf raw config path ~/.codeium/mcp_config.json and also keeps the older ~/.codeium/windsurf/mcp_config.json layout in sync during local installs.',
      auth.envVar
        ? `Define ${auth.envVar} in the environment that launches Windsurf if you keep the exported Authorization header placeholder.`
        : 'No gateway authentication is configured, so no Authorization header is required.',
      'Windsurf expects remote MCP servers under serverUrl rather than url.',
    ],
    env: auth.envVar ? [{ name: auth.envVar, description: auth.description ?? 'Conduit bearer token' }] : [],
    servers,
  };
}

function buildClaudeDesktopExport(
  target: ConnectTargetDefinition,
  profile: ResolvedConnectProfile,
  scope: ConnectScope,
  baseUrl: string,
  auth: AuthExportSpec,
  servers: ConnectServerBinding[],
): ConnectExportResult {
  const snippet = JSON.stringify({
    mcpServers: Object.fromEntries(servers.map((server) => [
      server.alias,
      {
        command: 'npx',
        args: [
          '-y',
          'mcp-remote',
          server.url,
          ...(auth.envVar ? ['--header', `Authorization: Bearer \${${auth.envVar}}`] : []),
        ],
        env: {},
      },
    ])),
  }, null, 2);

  return {
    target: target.id,
    target_label: target.label,
    profile: profile.id,
    profile_label: profile.label,
    scope,
    scope_effective: 'global',
    format: target.format,
    title: 'Claude Desktop MCP configuration',
    placement: 'Claude Desktop config.json / claude_desktop_config.json',
    base_url: baseUrl,
    snippet,
    notes: [
      'Claude Desktop local MCP config is machine-wide, so project scope collapses to a global install for this target.',
      'The exported entries use `npx mcp-remote` so Claude Desktop launches a local stdio bridge that connects back to Conduit over HTTP.',
      auth.envVar
        ? `Export ${auth.envVar} before launching Claude Desktop so the Authorization header placeholder resolves.`
        : 'No gateway authentication is configured, so the bridge command does not inject Authorization headers.',
    ],
    env: auth.envVar ? [{ name: auth.envVar, description: auth.description ?? 'Conduit bearer token' }] : [],
    servers,
  };
}

function buildCodexExport(
  target: ConnectTargetDefinition,
  profile: ResolvedConnectProfile,
  scope: ConnectScope,
  baseUrl: string,
  auth: AuthExportSpec,
  servers: ConnectServerBinding[],
): ConnectExportResult {
  const snippet = servers.map((server) => {
    const lines = [
      `[mcp_servers.${toTomlKey(server.alias)}]`,
      `url = ${toTomlString(server.url)}`,
    ];

    if (auth.envVar) {
      lines.push(`bearer_token_env_var = ${toTomlString(auth.envVar)}`);
    }

    return lines.join('\n');
  }).join('\n\n');

  return {
    target: target.id,
    target_label: target.label,
    profile: profile.id,
    profile_label: profile.label,
    scope,
    scope_effective: scope,
    format: target.format,
    title: 'Codex MCP configuration',
    placement: scope === 'project' ? '.codex/config.toml' : '~/.codex/config.toml',
    base_url: baseUrl,
    snippet,
    notes: [
      'Codex stores user-level MCP servers in ~/.codex/config.toml and also supports project-scoped overrides in .codex/config.toml for trusted projects.',
      auth.envVar
        ? `The exported config references ${auth.envVar} through bearer_token_env_var instead of storing the gateway token in config.toml.`
        : 'No gateway authentication is configured, so Codex connects without a bearer token.',
      'Each table maps directly to one Conduit-routed MCP endpoint under /mcp/:serverId.',
    ],
    env: auth.envVar ? [{ name: auth.envVar, description: auth.description ?? 'Conduit bearer token' }] : [],
    servers,
  };
}

function buildVsCodeExport(
  target: ConnectTargetDefinition,
  profile: ResolvedConnectProfile,
  scope: ConnectScope,
  baseUrl: string,
  auth: AuthExportSpec,
  servers: ConnectServerBinding[],
): ConnectExportResult {
  const inputId = 'conduitAuthToken';
  const snippet = JSON.stringify({
    ...(auth.envVar ? {
      inputs: [
        {
          type: 'promptString',
          id: inputId,
          description: auth.description ?? 'Conduit bearer token',
          password: true,
        },
      ],
    } : {}),
    servers: Object.fromEntries(servers.map((server) => [
      buildVsCodeAlias(server.id),
      {
        type: 'http',
        url: server.url,
        ...(auth.envVar ? { headers: { Authorization: `Bearer \${input:${inputId}}` } } : {}),
      },
    ])),
  }, null, 2);

  return {
    target: target.id,
    target_label: target.label,
    profile: profile.id,
    profile_label: profile.label,
    scope,
    scope_effective: scope,
    format: target.format,
    title: 'VS Code MCP configuration',
    placement: scope === 'project' ? '.vscode/mcp.json' : 'VS Code user profile mcp.json',
    base_url: baseUrl,
    snippet,
    notes: [
      'VS Code stores MCP configuration in mcp.json using a top-level "servers" object.',
      auth.envVar
        ? 'The exported snippet uses an input variable so VS Code can prompt once and store the token securely.'
        : 'No gateway authentication is configured, so the exported snippet does not define input variables.',
      'For workspace installs, write this file to .vscode/mcp.json at the repository root.',
      'Conduit local installs for the VS Code target also refresh Claude Code (.mcp.json) and Codex (.codex/config.toml) so both extensions can reuse the same routed MCP server.',
    ],
    env: auth.envVar ? [{ name: auth.envVar, description: auth.description ?? 'Conduit bearer token' }] : [],
    servers,
  };
}

function buildGenericJsonExport(
  target: ConnectTargetDefinition,
  profile: ResolvedConnectProfile,
  scope: ConnectScope,
  baseUrl: string,
  auth: AuthExportSpec,
  servers: ConnectServerBinding[],
): ConnectExportResult {
  const snippet = JSON.stringify({
    mcpServers: Object.fromEntries(servers.map((server) => [
      server.alias,
      {
        type: 'http',
        url: server.url,
        ...(auth.envVar ? { headers: { Authorization: `Bearer \${env:${auth.envVar}}` } } : {}),
      },
    ])),
  }, null, 2);

  return {
    target: target.id,
    target_label: target.label,
    profile: profile.id,
    profile_label: profile.label,
    scope,
    scope_effective: scope,
    format: target.format,
    title: 'Generic MCP JSON',
    placement: 'Client-specific MCP JSON config',
    base_url: baseUrl,
    snippet,
    notes: [
      'This export uses the common mcpServers JSON shape understood by many MCP desktop clients.',
      auth.envVar
        ? `Replace or resolve ${auth.envVar} according to your client’s environment-variable interpolation rules.`
        : 'No gateway authentication is configured, so no Authorization header is required.',
    ],
    env: auth.envVar ? [{ name: auth.envVar, description: auth.description ?? 'Conduit bearer token' }] : [],
    servers,
  };
}

function buildClaudeRemoteExport(
  target: ConnectTargetDefinition,
  profile: ResolvedConnectProfile,
  scope: ConnectScope,
  baseUrl: string,
  auth: AuthExportSpec,
): ConnectExportResult {
  const profileUrl = buildConnectProfileUrl(baseUrl, profile.id);
  const snippet = JSON.stringify({
    name: `Conduit ${profile.label}`,
    url: profileUrl,
    transport: 'streamable-http',
    authentication: auth.method === 'none' ? 'none' : 'unsupported-by-conduit-remote',
  }, null, 2);

  return {
    target: target.id,
    target_label: target.label,
    profile: profile.id,
    profile_label: profile.label,
    scope,
    scope_effective: 'global',
    format: target.format,
    title: 'Claude remote connector manifest',
    placement: 'Claude Settings → Connectors → Add custom connector',
    base_url: baseUrl,
    snippet,
    notes: [
      'This target uses one public Conduit profile URL so Claude connects to the profile, not to raw upstream MCP servers.',
      auth.method === 'none'
        ? 'Claude remote connectors can reach this Conduit profile directly when the gateway is public and reachable over HTTPS.'
        : 'Conduit remote distribution currently expects an authless public gateway URL because Claude remote connectors need authless or OAuth-based remote MCP access.',
      'The exported URL is profile-scoped: /mcp/profile/:profileId.',
    ],
    env: [],
    servers: [{ id: profile.id, alias: `conduit-profile-${profile.id}`, url: profileUrl }],
  };
}

function buildChatGptRemoteExport(
  target: ConnectTargetDefinition,
  profile: ResolvedConnectProfile,
  scope: ConnectScope,
  baseUrl: string,
  auth: AuthExportSpec,
): ConnectExportResult {
  const profileUrl = buildConnectProfileUrl(baseUrl, profile.id);
  const snippet = JSON.stringify({
    name: `Conduit ${profile.label}`,
    server_url: profileUrl,
    transport: 'streamable-http',
    authentication: auth.method === 'none' ? 'none' : 'unsupported-by-conduit-remote',
    usage: 'ChatGPT Settings → Connectors → Advanced → Developer mode',
  }, null, 2);

  return {
    target: target.id,
    target_label: target.label,
    profile: profile.id,
    profile_label: profile.label,
    scope,
    scope_effective: 'global',
    format: target.format,
    title: 'ChatGPT remote connector manifest',
    placement: 'ChatGPT Settings → Connectors → Developer mode',
    base_url: baseUrl,
    snippet,
    notes: [
      'ChatGPT custom connectors expect a remote MCP URL; Conduit exposes one profile endpoint so the connector stays under Conduit control.',
      auth.method === 'none'
        ? 'Use a public HTTPS Conduit base URL for ChatGPT remote distribution.'
        : 'Conduit remote distribution currently requires an authless public gateway because ChatGPT custom connectors expect authless or OAuth-capable remote MCP servers.',
      'The profile endpoint keeps multi-server routing inside Conduit instead of exposing each upstream separately.',
    ],
    env: [],
    servers: [{ id: profile.id, alias: `conduit-profile-${profile.id}`, url: profileUrl }],
  };
}

function buildV0RemoteExport(
  target: ConnectTargetDefinition,
  profile: ResolvedConnectProfile,
  scope: ConnectScope,
  baseUrl: string,
  auth: AuthExportSpec,
): ConnectExportResult {
  const profileUrl = buildConnectProfileUrl(baseUrl, profile.id);
  const snippet = JSON.stringify({
    name: `Conduit ${profile.label}`,
    url: profileUrl,
    authentication: auth.method === 'none' ? 'none' : 'unsupported-by-conduit-remote',
    sdk_example: {
      method: 'v0.mcpServers.create',
      body: {
        name: `Conduit ${profile.label}`,
        url: profileUrl,
      },
    },
  }, null, 2);

  return {
    target: target.id,
    target_label: target.label,
    profile: profile.id,
    profile_label: profile.label,
    scope,
    scope_effective: 'global',
    format: target.format,
    title: 'v0 remote MCP manifest',
    placement: 'v0 custom MCP configuration / API',
    base_url: baseUrl,
    snippet,
    notes: [
      'v0 can attach a custom remote MCP server, so Conduit exports one profile-scoped endpoint instead of many raw upstream URLs.',
      auth.method === 'none'
        ? 'For API-based installs, provide the exported Conduit profile URL to v0.'
        : 'Conduit remote distribution for v0 currently requires an authless public gateway URL or a future OAuth bridge.',
      'This keeps v0 attached to a Conduit-managed profile that you can audit, rate limit, and update centrally.',
    ],
    env: [],
    servers: [{ id: profile.id, alias: `conduit-profile-${profile.id}`, url: profileUrl }],
  };
}

function deriveAuthExportSpec(config: ConduitGatewayConfig): AuthExportSpec {
  const method = config.auth?.method ?? 'none';
  if (method === 'api-key') {
    return {
      method,
      envVar: 'CONDUIT_API_KEY',
      description: 'Conduit API key passed as a Bearer token to the gateway',
    };
  }

  if (method === 'jwt') {
    return {
      method,
      envVar: 'CONDUIT_BEARER_TOKEN',
      description: 'JWT bearer token accepted by the Conduit gateway',
    };
  }

  return { method: 'none' };
}

function buildAlias(serverId: string, target: ConnectTarget): string {
  if (target === 'vscode') {
    return buildVsCodeAlias(serverId);
  }

  return `conduit-${serverId}`;
}

function buildVsCodeAlias(serverId: string): string {
  const parts = serverId.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return 'conduitServer';

  const suffix = parts
    .map((part, index) => {
      const lower = part.toLowerCase();
      return index === 0
        ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`
        : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join('');

  return `conduit${suffix}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function normalizeListenHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '::0' || host === '') {
    return 'localhost';
  }
  return host;
}

function titleCaseId(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || value;
}
