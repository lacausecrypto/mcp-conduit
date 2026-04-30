import type {
  ConnectProfileConfig,
  ConduitGatewayConfig,
  ServerConfig,
  ServerCacheConfig,
} from '../config/types.js';
import { validateServerUrlWithDns } from '../utils/url-validator.js';
import { pinnedFetch as defaultPinnedFetch } from '../utils/pinned-fetch.js';

/**
 * Test seam: lets unit tests swap the pinned fetch for one that goes
 * through `vi.stubGlobal('fetch', ...)`. Without this, descriptor tests
 * that mock `fetch` globally would bypass pinnedFetch and try a real
 * HTTP connection.
 */
type PinnedFetchFn = typeof defaultPinnedFetch;
let pinnedFetchImpl: PinnedFetchFn = defaultPinnedFetch;
export function _setPinnedFetch(impl: PinnedFetchFn): void { pinnedFetchImpl = impl; }
export function _resetPinnedFetch(): void { pinnedFetchImpl = defaultPinnedFetch; }

export interface ConnectServerDescriptorServer {
  id: string;
  name?: string;
  description?: string;
  transport?: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  replicas?: string[];
  timeout_ms?: number;
  cache?: {
    default_ttl?: number;
    overrides?: ServerCacheConfig['overrides'];
  };
  profile_ids?: string[];
}

export interface ConnectServerDescriptorProfile {
  id: string;
  label?: string;
  description?: string;
  server_ids?: string[];
}

export interface ConnectServerDescriptor {
  version?: number;
  name?: string;
  description?: string;
  server?: ConnectServerDescriptorServer;
  servers?: ConnectServerDescriptorServer[];
  profiles?: ConnectServerDescriptorProfile[];
}

export interface ConnectImportTemplate {
  id: string;
  label: string;
  description: string;
  example_descriptor: ConnectServerDescriptor;
}

export interface NormalizedDescriptorImport {
  name: string;
  description?: string;
  servers: ServerConfig[];
  profiles: ConnectProfileConfig[];
}

const DEFAULT_DESCRIPTOR_TIMEOUT_MS = 5_000;
const MAX_DESCRIPTOR_REDIRECTS = 5;
/**
 * Hard cap on the size of a fetched descriptor body.
 * A descriptor is small JSON metadata (server list, profiles) — 1 MiB is
 * orders of magnitude above any legitimate use. Without this cap, a hostile
 * (or accidentally misbehaving) endpoint can stream gigabytes through
 * `res.json()` and OOM the gateway process.
 */
const MAX_DESCRIPTOR_BODY_BYTES = 1 * 1024 * 1024;

export async function loadDescriptorFromUrl(
  url: string,
  options: { allowPrivateNetworks?: boolean; timeoutMs?: number } = {},
): Promise<NormalizedDescriptorImport> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Descriptor URL must be a valid absolute URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Descriptor URL must use http or https');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_DESCRIPTOR_TIMEOUT_MS;
  let currentUrl = parsed;

  for (let redirects = 0; redirects <= MAX_DESCRIPTOR_REDIRECTS; redirects++) {
    const urlCheck = await validateServerUrlWithDns(
      currentUrl.toString(),
      options.allowPrivateNetworks === true,
    );
    if (!urlCheck.valid) {
      throw new Error(`Descriptor URL blocked: ${urlCheck.error}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // DNS rebinding mitigation (battle-test #3): when validation resolved
    // the hostname to one or more IPs, dispatch the fetch directly to the
    // first validated IP via pinnedFetch. Without this, undici re-resolves
    // and could be served a different IP (loopback/RFC1918) by an attacker
    // with TTL=0. IP literals and allowPrivate=true callers fall through
    // to the standard fetch path.
    const pinned = !options.allowPrivateNetworks
      && urlCheck.resolvedIps
      && urlCheck.resolvedIps.length > 0
      ? urlCheck.resolvedIps[0]
      : undefined;

    let res: Response;
    try {
      if (pinned) {
        res = await pinnedFetchImpl(currentUrl, {
          pinnedIp: pinned.address,
          family: pinned.family,
          init: {
            redirect: 'manual',
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          },
        });
      } else {
        res = await fetch(currentUrl.toString(), {
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
      }
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.message === 'AbortError')) {
        throw new Error(`Descriptor fetch timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`Descriptor redirect failed: HTTP ${res.status} without Location header`);
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Unable to fetch descriptor: HTTP ${res.status}`);
    }

    // Fast-path rejection on Content-Length, then enforce a hard byte cap on
    // the actual stream so chunked / missing Content-Length responses cannot
    // exhaust memory by streaming an unbounded body through res.json().
    const declaredLength = res.headers.get('content-length');
    if (declaredLength !== null) {
      const parsed = parseInt(declaredLength, 10);
      if (Number.isFinite(parsed) && parsed > MAX_DESCRIPTOR_BODY_BYTES) {
        throw new Error(
          `Descriptor body exceeds maximum size (${MAX_DESCRIPTOR_BODY_BYTES} bytes)`,
        );
      }
    }

    const bodyText = await readBodyWithCap(res, MAX_DESCRIPTOR_BODY_BYTES);
    let descriptor: unknown;
    try {
      descriptor = JSON.parse(bodyText) as unknown;
    } catch (error) {
      throw new Error(
        `Descriptor body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return normalizeDescriptor(descriptor);
  }

  throw new Error(`Descriptor URL exceeded redirect limit (${MAX_DESCRIPTOR_REDIRECTS})`);
}

/**
 * Reads the response body in chunks, aborting (and throwing) as soon as the
 * total bytes consumed exceed `maxBytes`. Equivalent to `res.text()` for
 * well-behaved peers, but safe against responses that lie about (or omit)
 * their Content-Length.
 */
async function readBodyWithCap(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => undefined);
        throw new Error(
          `Descriptor body exceeds maximum size (${maxBytes} bytes)`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function normalizeDescriptor(descriptor: unknown): NormalizedDescriptorImport {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('Descriptor must be a JSON object');
  }

  const raw = descriptor as ConnectServerDescriptor;
  const descriptorServers = [
    ...(raw.server ? [raw.server] : []),
    ...(Array.isArray(raw.servers) ? raw.servers : []),
  ];

  if (descriptorServers.length === 0) {
    throw new Error('Descriptor must define at least one server');
  }

  const servers = descriptorServers.map(normalizeDescriptorServer);
  const serverIds = new Set(servers.map((server) => server.id));
  const profileMap = new Map<string, ConnectProfileConfig>();

  for (const descriptorServer of descriptorServers) {
    for (const profileId of descriptorServer.profile_ids ?? []) {
      if (!profileMap.has(profileId)) {
        profileMap.set(profileId, {
          id: profileId,
          label: titleCaseId(profileId),
          description: `Imported profile "${profileId}".`,
          server_ids: [],
        });
      }

      const profile = profileMap.get(profileId);
      if (profile && !profile.server_ids.includes(descriptorServer.id)) {
        profile.server_ids.push(descriptorServer.id);
      }
    }
  }

  for (const profile of raw.profiles ?? []) {
    if (!profile?.id || typeof profile.id !== 'string') {
      throw new Error('Descriptor profiles must define a non-empty string id');
    }
    const server_ids = Array.isArray(profile.server_ids) ? profile.server_ids.filter((id): id is string => typeof id === 'string') : [];
    const profileEntry = profileMap.get(profile.id) ?? {
      id: profile.id,
      server_ids: [],
    };

    profileMap.set(profile.id, {
      id: profile.id,
      ...(profile.label ? { label: profile.label } : profileEntry.label ? { label: profileEntry.label } : {}),
      ...(profile.description ? { description: profile.description } : profileEntry.description ? { description: profileEntry.description } : {}),
      server_ids: Array.from(new Set([...profileEntry.server_ids, ...server_ids].filter((serverId) => serverIds.has(serverId)))),
    });
  }

  return {
    name: raw.name ?? 'Imported descriptor',
    ...(raw.description ? { description: raw.description } : {}),
    servers,
    profiles: Array.from(profileMap.values()).filter((profile) => profile.server_ids.length > 0),
  };
}

export function listImportTemplates(): ConnectImportTemplate[] {
  return [
    {
      id: 'remote-http',
      label: 'Remote HTTP',
      description: 'Import a remote MCP server available over HTTP(S).',
      example_descriptor: {
        version: 1,
        name: 'Remote CRM',
        description: 'Example remote MCP server descriptor',
        servers: [
          {
            id: 'crm-http',
            transport: 'http',
            url: 'https://crm.example.com/mcp',
            cache: { default_ttl: 120 },
            profile_ids: ['sales'],
          },
        ],
      },
    },
    {
      id: 'local-stdio',
      label: 'Local Stdio',
      description: 'Import a local stdio server launched by Conduit on this machine.',
      example_descriptor: {
        version: 1,
        name: 'Local Filesystem',
        description: 'Example local stdio MCP server descriptor',
        servers: [
          {
            id: 'filesystem-local',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'my-mcp-server', '--root', '/path/to/workdir'],
            cache: { default_ttl: 0 },
            profile_ids: ['local-dev'],
          },
        ],
      },
    },
  ];
}

export function mergeImportedProfiles(
  config: ConduitGatewayConfig,
  importedProfiles: ConnectProfileConfig[],
): { upserted: string[] } {
  if (importedProfiles.length === 0) {
    return { upserted: [] };
  }

  const existing = [...(config.connect?.profiles ?? [])];
  const byId = new Map(existing.map((profile) => [profile.id, profile]));
  const upserted: string[] = [];

  for (const imported of importedProfiles) {
    const current = byId.get(imported.id);
    if (!current) {
      byId.set(imported.id, {
        id: imported.id,
        ...(imported.label ? { label: imported.label } : {}),
        ...(imported.description ? { description: imported.description } : {}),
        server_ids: imported.server_ids,
      });
      upserted.push(imported.id);
      continue;
    }

    const mergedLabel = imported.label ?? current.label;
    const mergedDescription = imported.description ?? current.description;
    byId.set(imported.id, {
      id: imported.id,
      ...(mergedLabel ? { label: mergedLabel } : {}),
      ...(mergedDescription ? { description: mergedDescription } : {}),
      server_ids: Array.from(new Set([...current.server_ids, ...imported.server_ids])),
    });
    upserted.push(imported.id);
  }

  config.connect = {
    ...(config.connect ?? {}),
    profiles: Array.from(byId.values()),
  };

  return { upserted };
}

function normalizeDescriptorServer(server: ConnectServerDescriptorServer): ServerConfig {
  if (!server?.id || typeof server.id !== 'string') {
    throw new Error('Descriptor servers must define a non-empty string id');
  }

  const transport = server.transport ?? (server.command ? 'stdio' : 'http');
  const cache: ServerCacheConfig = {
    default_ttl: server.cache?.default_ttl ?? 0,
    ...(server.cache?.overrides ? { overrides: server.cache.overrides } : {}),
  };

  const result: ServerConfig = {
    id: server.id,
    url: transport === 'http'
      ? String(server.url ?? '')
      : String(server.url ?? `stdio://${server.command ?? server.id}`),
    cache,
    ...(transport === 'stdio' ? { transport: 'stdio' as const } : {}),
  };

  if (transport === 'stdio') {
    if (!server.command) {
      throw new Error(`Descriptor server "${server.id}" is missing "command" for stdio transport`);
    }
    result.command = server.command;
    if (server.args) result.args = server.args.map(String);
    if (server.env) result.env = Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, String(value)]));
  } else if (!server.url) {
    throw new Error(`Descriptor server "${server.id}" is missing "url" for http transport`);
  }

  if (server.headers) {
    result.headers = Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, String(value)]));
  }

  if (server.timeout_ms !== undefined) {
    result.timeout_ms = Number(server.timeout_ms);
  }

  if (server.replicas) {
    result.replicas = server.replicas.map(String);
  }

  return result;
}

function titleCaseId(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || value;
}
