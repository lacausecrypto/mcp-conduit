import { randomBytes } from 'node:crypto';
import type { ConduitGatewayConfig } from '../config/types.js';
import type { ProfileIdentityPreflight } from '../identity/types.js';
import {
  exportConnectProfile,
  listConnectTargets,
  type ConnectExportOptions,
  type ConnectExportResult,
  type ConnectScope,
  type ConnectTarget,
} from './export.js';

const DEFAULT_INSTALL_TTL_MS = 10 * 60 * 1000;

export interface ConnectInstallBundleAuthNone {
  type: 'none';
}

export interface ConnectInstallBundleAuthBearer {
  type: 'bearer';
  secret: string;
  description: string;
  header_name: 'Authorization';
  prefix: 'Bearer ';
}

export type ConnectInstallBundleAuth =
  | ConnectInstallBundleAuthNone
  | ConnectInstallBundleAuthBearer;

export interface ConnectInstallBundle {
  version: 1;
  transport: 'stdio-relay';
  target: ConnectTarget;
  target_label: string;
  profile: string;
  profile_label: string;
  scope: ConnectScope;
  scope_effective: ConnectExportResult['scope_effective'];
  base_url: string;
  servers: ConnectExportResult['servers'];
  created_at: string;
  expires_at: string;
  auth: ConnectInstallBundleAuth;
  identity_preflight?: ProfileIdentityPreflight;
}

interface StoredInstallBundle {
  bundle: ConnectInstallBundle;
  expiresAtMs: number;
}

export interface CreateConnectInstallSessionOptions extends ConnectExportOptions {
  authSecret?: string;
  ttlMs?: number;
  bundleBaseUrl: string;
  identityPreflight?: ProfileIdentityPreflight;
}

export interface ConnectInstallSessionResponse {
  token: string;
  target: ConnectTarget;
  target_label: string;
  profile: string;
  profile_label: string;
  scope: ConnectScope;
  scope_effective: ConnectExportResult['scope_effective'];
  expires_at: string;
  bundle_url: string;
  install_command: string;
  deeplink?: string;
  identity_preflight?: ProfileIdentityPreflight;
}

export class ConnectInstallSessionStore {
  private readonly sessions = new Map<string, StoredInstallBundle>();

  createSession(
    config: ConduitGatewayConfig,
    options: CreateConnectInstallSessionOptions,
  ): ConnectInstallSessionResponse {
    this.pruneExpired();

    const result = exportConnectProfile(config, options);
    const target = listConnectTargets().find((item) => item.id === result.target);
    if (!target) {
      throw new Error(`Unsupported connect target "${result.target}"`);
    }

    const auth = buildBundleAuth(result, options.authSecret);
    const token = randomBytes(24).toString('base64url');
    const ttlMs = options.ttlMs ?? DEFAULT_INSTALL_TTL_MS;
    const expiresAtMs = Date.now() + ttlMs;
    const bundle: ConnectInstallBundle = {
      version: 1,
      transport: 'stdio-relay',
      target: result.target,
      target_label: target.label,
      profile: result.profile,
      profile_label: result.profile_label,
      scope: result.scope,
      scope_effective: result.scope_effective,
      base_url: result.base_url,
      servers: result.servers,
      created_at: new Date().toISOString(),
      expires_at: new Date(expiresAtMs).toISOString(),
      auth,
      ...(options.identityPreflight ? { identity_preflight: options.identityPreflight } : {}),
    };

    this.sessions.set(token, {
      bundle,
      expiresAtMs,
    });

    const bundleUrl = joinUrl(options.bundleBaseUrl, `/conduit/connect/install/bundles/${token}`);
    const command = buildInstallCommand(bundleUrl, bundle.scope_effective);
    const deeplink = bundle.scope_effective === 'project'
      ? undefined
      : buildConnectDeeplink(bundleUrl);

    return {
      token,
      target: bundle.target,
      target_label: bundle.target_label,
      profile: bundle.profile,
      profile_label: bundle.profile_label,
      scope: bundle.scope,
      scope_effective: bundle.scope_effective,
      expires_at: bundle.expires_at,
      bundle_url: bundleUrl,
      install_command: command,
      ...(bundle.identity_preflight ? { identity_preflight: bundle.identity_preflight } : {}),
      ...(deeplink ? { deeplink } : {}),
    };
  }

  getBundle(token: string): ConnectInstallBundle | null {
    this.pruneExpired();
    const session = this.sessions.get(token);
    if (!session) return null;
    return session.bundle;
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

export function buildConnectDeeplink(bundleUrl: string): string {
  return `conduit://install?bundle_url=${encodeURIComponent(bundleUrl)}`;
}

export function parseConnectDeeplink(deeplink: string): string {
  let parsed: URL;
  try {
    parsed = new URL(deeplink);
  } catch {
    throw new Error('Invalid conduit deeplink');
  }

  if (parsed.protocol !== 'conduit:') {
    throw new Error('Unsupported deeplink protocol');
  }

  if (parsed.hostname !== 'install' && parsed.pathname !== '/install' && parsed.pathname !== 'install') {
    throw new Error('Unsupported conduit deeplink action');
  }

  const bundleUrl = parsed.searchParams.get('bundle_url');
  if (!bundleUrl) {
    throw new Error('Missing bundle_url in conduit deeplink');
  }

  return bundleUrl;
}

function buildBundleAuth(result: ConnectExportResult, authSecret?: string): ConnectInstallBundleAuth {
  if (result.env.length === 0) {
    return { type: 'none' };
  }

  const description = result.env[0]?.description ?? 'Conduit bearer token';
  if (!authSecret) {
    throw new Error(`A gateway token is required to install ${result.target_label}`);
  }

  return {
    type: 'bearer',
    secret: authSecret,
    description,
    header_name: 'Authorization',
    prefix: 'Bearer ',
  };
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function buildInstallCommand(
  bundleUrl: string,
  scopeEffective: ConnectExportResult['scope_effective'],
): string {
  const bundleArg = `--bundle-url "${bundleUrl}"`;
  if (scopeEffective === 'project') {
    return `conduit connect install ${bundleArg} --project-dir "$PWD"`;
  }

  return `conduit connect install ${bundleArg}`;
}
