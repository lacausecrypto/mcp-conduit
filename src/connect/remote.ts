import { randomBytes } from 'node:crypto';
import type { ConduitGatewayConfig } from '../config/types.js';
import type { ProfileIdentityPreflight } from '../identity/types.js';
import {
  exportConnectProfile,
  getConnectTargetDefinition,
  isRemoteConnectTarget,
  type ConnectExportOptions,
  type ConnectExportResult,
  type ConnectTarget,
} from './export.js';

const DEFAULT_REMOTE_TTL_MS = 10 * 60 * 1000;

export interface ConnectRemoteBundle {
  version: 1;
  delivery: 'remote-connector';
  target: ConnectTarget;
  target_label: string;
  profile: string;
  profile_label: string;
  created_at: string;
  expires_at: string;
  profile_url: string;
  settings_url: string;
  settings_label: string;
  remote_ready: boolean;
  blockers: string[];
  export: ConnectExportResult;
  identity_preflight?: ProfileIdentityPreflight;
}

interface StoredRemoteBundle {
  bundle: ConnectRemoteBundle;
  expiresAtMs: number;
}

export interface CreateConnectRemoteSessionOptions extends ConnectExportOptions {
  ttlMs?: number;
  bundleBaseUrl: string;
  identityPreflight?: ProfileIdentityPreflight;
}

export interface ConnectRemoteSessionResponse {
  token: string;
  delivery: 'remote-connector';
  target: ConnectTarget;
  target_label: string;
  profile: string;
  profile_label: string;
  expires_at: string;
  bundle_url: string;
  profile_url: string;
  settings_url: string;
  settings_label: string;
  placement: string;
  format: ConnectExportResult['format'];
  snippet: string;
  notes: string[];
  remote_ready: boolean;
  blockers: string[];
  identity_preflight?: ProfileIdentityPreflight;
}

export class ConnectRemoteSessionStore {
  private readonly sessions = new Map<string, StoredRemoteBundle>();

  createSession(
    config: ConduitGatewayConfig,
    options: CreateConnectRemoteSessionOptions,
  ): ConnectRemoteSessionResponse {
    this.pruneExpired();

    if (!isRemoteConnectTarget(options.target)) {
      throw new Error(`Target "${options.target}" is not a remote connector`);
    }

    const exported = exportConnectProfile(config, options);
    const definition = getConnectTargetDefinition(exported.target);
    const settings = getRemoteTargetSettings(exported.target);
    const blockers = buildRemoteBlockers(config, exported);
    const token = randomBytes(24).toString('base64url');
    const ttlMs = options.ttlMs ?? DEFAULT_REMOTE_TTL_MS;
    const expiresAtMs = Date.now() + ttlMs;
    const profileUrl = exported.servers[0]?.url ?? exported.base_url;
    const bundle: ConnectRemoteBundle = {
      version: 1,
      delivery: 'remote-connector',
      target: exported.target,
      target_label: definition.label,
      profile: exported.profile,
      profile_label: exported.profile_label,
      created_at: new Date().toISOString(),
      expires_at: new Date(expiresAtMs).toISOString(),
      profile_url: profileUrl,
      settings_url: settings.url,
      settings_label: settings.label,
      remote_ready: blockers.length === 0,
      blockers,
      export: exported,
      ...(options.identityPreflight ? { identity_preflight: options.identityPreflight } : {}),
    };

    this.sessions.set(token, {
      bundle,
      expiresAtMs,
    });

    const bundleUrl = joinUrl(options.bundleBaseUrl, `/conduit/connect/remote/bundles/${token}`);
    return {
      token,
      delivery: 'remote-connector',
      target: bundle.target,
      target_label: bundle.target_label,
      profile: bundle.profile,
      profile_label: bundle.profile_label,
      expires_at: bundle.expires_at,
      bundle_url: bundleUrl,
      profile_url: bundle.profile_url,
      settings_url: bundle.settings_url,
      settings_label: bundle.settings_label,
      placement: bundle.export.placement,
      format: bundle.export.format,
      snippet: bundle.export.snippet,
      notes: bundle.export.notes,
      remote_ready: bundle.remote_ready,
      blockers: [...bundle.blockers],
      ...(bundle.identity_preflight ? { identity_preflight: bundle.identity_preflight } : {}),
    };
  }

  getBundle(token: string): ConnectRemoteBundle | null {
    this.pruneExpired();
    return this.sessions.get(token)?.bundle ?? null;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAtMs <= now) {
        this.sessions.delete(token);
      }
    }
  }
}

function buildRemoteBlockers(
  config: ConduitGatewayConfig,
  result: ConnectExportResult,
): string[] {
  const blockers: string[] = [];

  if ((config.auth?.method ?? 'none') !== 'none') {
    blockers.push('Conduit remote distribution currently requires an authless gateway or a future OAuth bridge.');
  }

  try {
    const parsed = new URL(result.servers[0]?.url ?? result.base_url);
    if (parsed.protocol !== 'https:') {
      blockers.push('Remote connectors require an HTTPS Conduit URL.');
    }
    if (isPrivateHost(parsed.hostname)) {
      blockers.push('Remote connectors require a public Conduit host reachable from the internet.');
    }
  } catch {
    blockers.push('The exported Conduit profile URL is invalid.');
  }

  return blockers;
}

function getRemoteTargetSettings(target: ConnectTarget): { label: string; url: string } {
  switch (target) {
    case 'claude':
      return {
        label: 'Claude connector settings',
        url: 'https://claude.ai/settings/connectors',
      };
    case 'chatgpt':
      return {
        label: 'ChatGPT apps settings',
        url: 'https://chatgpt.com/',
      };
    case 'v0':
      return {
        label: 'v0 MCP settings',
        url: 'https://v0.app/',
      };
    default:
      throw new Error(`Target "${target}" is not a remote connector`);
  }
}

function isPrivateHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.endsWith('.local')
  ) {
    return true;
  }

  if (/^10\.\d+\.\d+\.\d+$/.test(normalized)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(normalized)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(normalized)) return true;

  return false;
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}
