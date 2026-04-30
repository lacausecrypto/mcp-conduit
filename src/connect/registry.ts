import type {
  ConnectManagedRuntimeConfig,
  ConnectRegistryConfig,
  ConduitGatewayConfig,
  ServerConfig,
  ServerCacheConfig,
} from '../config/types.js';
import { createManagedRuntimeForPackage, resolveConnectManagedRuntimeConfig } from '../runtime/managed.js';

const OFFICIAL_REGISTRY_META_KEY = 'io.modelcontextprotocol.registry/official';
const DEFAULT_REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io';
const DEFAULT_CACHE_TTL_SECONDS = 3600;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 0;

type FetchLike = typeof fetch;

export type ConnectRegistryInstallMode = 'remote' | 'package' | 'hybrid';
export type ConnectRegistryReadiness = 'ready' | 'needs-config' | 'manual' | 'blocked';
export type ConnectRegistryStrategy = 'proxy-remote' | 'conduit-host-package' | 'manual';
export type ConnectRegistryPackageType = 'npm' | 'pypi' | 'nuget' | 'oci' | 'mcpb' | 'unknown';
export type ConnectRegistrySort = 'relevance' | 'trust' | 'updated' | 'published' | 'name' | 'runtime';
export type ConnectRegistryRequirementSource = 'remote-variable' | 'remote-header' | 'package-env';
export type ConnectRegistryVerificationBasis = 'registry' | 'namespace-repository-match' | 'package-scope-match' | 'unverified';

export interface ConnectRegistryRequirementField {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  secret: boolean;
  source: ConnectRegistryRequirementSource;
  default_value?: string;
  choices?: string[];
}

export interface ConnectRegistryRequirements {
  variables: ConnectRegistryRequirementField[];
  headers: ConnectRegistryRequirementField[];
  env: ConnectRegistryRequirementField[];
}

export interface OfficialRegistryPackage {
  registryType?: string;
  registryBaseUrl?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  runtimeArguments?: Array<{
    type?: string;
    name?: string;
    value?: string;
  }>;
  transport?: {
    type?: string;
  };
  environmentVariables?: Array<{
    name?: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
    format?: string;
  }>;
}

export interface OfficialRegistryRemote {
  type?: string;
  url?: string;
  variables?: Record<string, {
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
    default?: string;
    choices?: string[];
  }>;
  headers?: Array<{
    name?: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
  }>;
}

export interface OfficialRegistryServerDocument {
  $schema?: string;
  name: string;
  title?: string;
  description?: string;
  version: string;
  repository?: {
    url?: string;
    source?: string;
  };
  packages?: OfficialRegistryPackage[];
  remotes?: OfficialRegistryRemote[];
}

interface OfficialRegistryMeta {
  status?: string;
  statusChangedAt?: string;
  publishedAt?: string;
  updatedAt?: string;
  isLatest?: boolean;
}

interface OfficialRegistryEntry {
  server: OfficialRegistryServerDocument;
  _meta?: Record<string, unknown>;
}

interface OfficialRegistryListResponse {
  servers?: OfficialRegistryEntry[];
  metadata?: {
    nextCursor?: string;
    count?: number;
  };
}

interface RegistryLibraryStoredItem {
  item: ConnectRegistryLibraryItem;
  raw: OfficialRegistryServerDocument;
}

export interface ConnectRegistryLibrarySourceInfo {
  base_url: string;
  synced_at?: string;
  cache_ttl_seconds: number;
  latest_only: boolean;
  stale: boolean;
  last_error?: string;
}

export interface ConnectRegistryLibraryFilterFacets {
  statuses: string[];
  install_modes: ConnectRegistryInstallMode[];
  readiness_levels: ConnectRegistryReadiness[];
  package_types: ConnectRegistryPackageType[];
}

export interface ConnectRegistryLibraryItem {
  name: string;
  conduit_id: string;
  title: string;
  description: string;
  version: string;
  status: string;
  is_latest: boolean;
  install_mode: ConnectRegistryInstallMode;
  readiness: ConnectRegistryReadiness;
  strategy: ConnectRegistryStrategy;
  score: number;
  score_label: 'excellent' | 'good' | 'fair' | 'poor';
  auto_importable: boolean;
  configurable_import: boolean;
  package_types: ConnectRegistryPackageType[];
  package_identifiers: string[];
  remote_patterns: string[];
  package_count: number;
  remote_count: number;
  required_config_count: number;
  requirement_keys: string[];
  strategy_options: Array<Exclude<ConnectRegistryStrategy, 'manual'>>;
  import_requirements: ConnectRegistryRequirements;
  verified_publisher: boolean;
  publisher_label: string;
  verification_basis: ConnectRegistryVerificationBasis;
  repository_url?: string;
  published_at?: string;
  updated_at?: string;
  reasons: string[];
}

export interface ConnectRegistryLibraryFilters {
  search?: string;
  status?: string;
  install_mode?: ConnectRegistryInstallMode;
  readiness?: ConnectRegistryReadiness;
  package_type?: ConnectRegistryPackageType;
  min_score?: number;
  auto_importable?: boolean;
  sort?: ConnectRegistrySort;
  limit?: number;
  offset?: number;
}

export interface ConnectRegistryPagination {
  limit: number;
  offset: number;
  returned: number;
  total_filtered: number;
  page: number;
  total_pages: number;
  has_more: boolean;
  next_offset?: number;
  previous_offset?: number;
}

export interface ConnectRegistryLibraryResponse {
  source: ConnectRegistryLibrarySourceInfo;
  stats: {
    total: number;
    filtered: number;
    auto_importable: number;
    ready: number;
    needs_config: number;
    remote: number;
    package: number;
    hybrid: number;
  };
  filters: ConnectRegistryLibraryFilterFacets;
  pagination: ConnectRegistryPagination;
  items: ConnectRegistryLibraryItem[];
}

export interface ConnectRegistryRefreshResult {
  total: number;
  synced_at: string;
  stale: boolean;
  last_error?: string;
}

export interface ConnectRegistryImportPlan {
  server: ServerConfig;
  source: {
    name: string;
    version: string;
    strategy: ConnectRegistryStrategy;
  };
}

export interface ConnectRegistryImportOptions {
  strategy?: Exclude<ConnectRegistryStrategy, 'manual'>;
  variables?: Record<string, string>;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ConnectRegistryLibraryResolution {
  item: ConnectRegistryLibraryItem;
  raw: OfficialRegistryServerDocument;
}

export interface ConnectRegistryResolvedLibraryResponse {
  source: ConnectRegistryLibrarySourceInfo;
  filters: ConnectRegistryLibraryFilterFacets;
  items: ConnectRegistryLibraryResolution[];
}

export class ConnectOfficialRegistryStore {
  private readonly fetchImpl: FetchLike;
  private readonly registryConfig: Required<ConnectRegistryConfig>;
  private readonly managedRuntimeConfig: Required<ConnectManagedRuntimeConfig>;
  private cacheExpiresAtMs = 0;
  private syncedAtMs: number | null = null;
  private lastError: string | null = null;
  private cached: RegistryLibraryStoredItem[] = [];

  constructor(
    config: ConduitGatewayConfig,
    options: { fetchImpl?: FetchLike } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.registryConfig = resolveConnectRegistryConfig(config.connect?.registry);
    this.managedRuntimeConfig = resolveConnectManagedRuntimeConfig(config.connect?.managed_runtime);
  }

  async listLibrary(filters: ConnectRegistryLibraryFilters = {}): Promise<ConnectRegistryLibraryResponse> {
    const snapshot = await this.listResolvedLibrary();
    const filtered = applyLibraryFilters(snapshot.items.map((entry) => entry.item), filters);
    const offset = Math.max(0, filters.offset ?? 0);
    const limit = clamp(Math.trunc(filters.limit ?? 40), 1, 200);
    const items = filtered.slice(offset, offset + limit);
    const page = limit > 0 ? Math.floor(offset / limit) + 1 : 1;
    const totalPages = Math.max(1, Math.ceil(filtered.length / limit));

    return {
      source: snapshot.source,
      stats: {
        total: snapshot.items.length,
        filtered: filtered.length,
        auto_importable: snapshot.items.filter((entry) => entry.item.auto_importable).length,
        ready: snapshot.items.filter((entry) => entry.item.readiness === 'ready').length,
        needs_config: snapshot.items.filter((entry) => entry.item.readiness === 'needs-config').length,
        remote: snapshot.items.filter((entry) => entry.item.install_mode === 'remote').length,
        package: snapshot.items.filter((entry) => entry.item.install_mode === 'package').length,
        hybrid: snapshot.items.filter((entry) => entry.item.install_mode === 'hybrid').length,
      },
      filters: snapshot.filters,
      pagination: {
        limit,
        offset,
        returned: items.length,
        total_filtered: filtered.length,
        page,
        total_pages: totalPages,
        has_more: offset + items.length < filtered.length,
        ...(offset + items.length < filtered.length ? { next_offset: offset + limit } : {}),
        ...(offset > 0 ? { previous_offset: Math.max(0, offset - limit) } : {}),
      },
      items,
    };
  }

  async listResolvedLibrary(): Promise<ConnectRegistryResolvedLibraryResponse> {
    await this.ensureFresh();

    return {
      source: buildLibrarySource(this.registryConfig, this.syncedAtMs, this.lastError),
      filters: buildLibraryFilters(this.cached),
      items: this.cached.map((entry) => ({
        item: entry.item,
        raw: entry.raw,
      })),
    };
  }

  async refresh(force = false): Promise<ConnectRegistryRefreshResult> {
    if (!force && !this.shouldRefresh()) {
      return {
        total: this.cached.length,
        synced_at: new Date(this.syncedAtMs ?? Date.now()).toISOString(),
        stale: this.lastError !== null,
        ...(this.lastError ? { last_error: this.lastError } : {}),
      };
    }

    try {
      const entries = await this.fetchAllEntries();
      this.cached = entries
        .filter((entry) => entry.server?.name && entry.server?.version)
        .map((entry) => ({
          raw: entry.server,
          item: scoreOfficialEntry(entry.server, readOfficialMeta(entry)),
        }))
        .sort(compareLibraryItems);
      this.syncedAtMs = Date.now();
      this.cacheExpiresAtMs = this.syncedAtMs + (this.registryConfig.cache_ttl_seconds * 1000);
      this.lastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.cached.length === 0) {
        throw new Error(`Unable to refresh official MCP registry: ${message}`);
      }
      this.lastError = message;
    }

    return {
      total: this.cached.length,
      synced_at: new Date(this.syncedAtMs ?? Date.now()).toISOString(),
      stale: this.lastError !== null,
      ...(this.lastError ? { last_error: this.lastError } : {}),
    };
  }

  async createImportPlan(
    serverName: string,
    version = 'latest',
    options: ConnectRegistryImportOptions = {},
  ): Promise<ConnectRegistryImportPlan> {
    await this.ensureFresh();
    const selected = findOfficialServer(this.cached, serverName, version);
    if (!selected) {
      throw new Error(`Registry server "${serverName}" (${version}) not found in cached library`);
    }

    if (selected.item.status === 'deleted') {
      throw new Error(`Registry server "${serverName}" is marked as deleted and cannot be auto-imported`);
    }

    const support = deriveImportSupport(selected.raw);
    if (!support.configurableImport) {
      throw new Error(support.reason ?? `Registry server "${serverName}" requires manual configuration before import`);
    }

    const planStrategy = options.strategy ?? support.strategy;
    if (planStrategy === 'manual') {
      throw new Error(`Registry server "${serverName}" does not expose a managed Conduit import strategy`);
    }

    const importOption = findImportOption(selected.raw, planStrategy);
    if (!importOption) {
      throw new Error(`Registry server "${serverName}" does not support strategy "${planStrategy}"`);
    }

    return {
      server: buildServerConfigFromOfficialServer(selected.raw, importOption, options, this.managedRuntimeConfig),
      source: {
        name: selected.raw.name,
        version: selected.raw.version,
        strategy: importOption.strategy,
      },
    };
  }

  async getLibraryItem(
    serverName: string,
    version = 'latest',
  ): Promise<ConnectRegistryLibraryResolution | null> {
    await this.ensureFresh();
    const selected = findOfficialServer(this.cached, serverName, version);
    if (!selected) {
      return null;
    }
    return {
      item: selected.item,
      raw: selected.raw,
    };
  }

  private async ensureFresh(): Promise<void> {
    if (this.shouldRefresh()) {
      await this.refresh(true);
    }
  }

  private shouldRefresh(): boolean {
    return this.cached.length === 0 || Date.now() >= this.cacheExpiresAtMs;
  }

  private async fetchAllEntries(): Promise<OfficialRegistryEntry[]> {
    const entries: OfficialRegistryEntry[] = [];
    let cursor: string | null = null;
    let page = 0;

    while (this.registryConfig.max_pages === 0 || page < this.registryConfig.max_pages) {
      const url = new URL('/v0.1/servers', this.registryConfig.base_url);
      url.searchParams.set('limit', String(this.registryConfig.page_size));
      if (cursor) {
        url.searchParams.set('cursor', cursor);
      }

      const res = await this.fetchImpl(url.toString());
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} when fetching ${url.pathname}`);
      }

      const body = await res.json() as OfficialRegistryListResponse;
      const pageServers = Array.isArray(body.servers) ? body.servers : [];
      const filteredPage = this.registryConfig.latest_only
        ? pageServers.filter((entry) => readOfficialMeta(entry).isLatest === true)
        : pageServers;

      entries.push(...filteredPage);
      cursor = body.metadata?.nextCursor ?? null;
      page += 1;

      if (!cursor) {
        break;
      }
    }

    return entries;
  }
}

export function resolveConnectRegistryConfig(
  raw: ConnectRegistryConfig | undefined,
): Required<ConnectRegistryConfig> {
  return {
    base_url: raw?.base_url ?? DEFAULT_REGISTRY_BASE_URL,
    cache_ttl_seconds: raw?.cache_ttl_seconds ?? DEFAULT_CACHE_TTL_SECONDS,
    page_size: raw?.page_size ?? DEFAULT_PAGE_SIZE,
    max_pages: raw?.max_pages ?? DEFAULT_MAX_PAGES,
    latest_only: raw?.latest_only ?? true,
  };
}

function readOfficialMeta(entry: OfficialRegistryEntry): OfficialRegistryMeta {
  const rawMeta = entry._meta?.[OFFICIAL_REGISTRY_META_KEY];
  if (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) {
    return {};
  }

  const meta = rawMeta as Record<string, unknown>;
  return {
    ...(typeof meta['status'] === 'string' ? { status: meta['status'] } : {}),
    ...(typeof meta['statusChangedAt'] === 'string' ? { statusChangedAt: meta['statusChangedAt'] } : {}),
    ...(typeof meta['publishedAt'] === 'string' ? { publishedAt: meta['publishedAt'] } : {}),
    ...(typeof meta['updatedAt'] === 'string' ? { updatedAt: meta['updatedAt'] } : {}),
    ...(typeof meta['isLatest'] === 'boolean' ? { isLatest: meta['isLatest'] } : {}),
  };
}

function scoreOfficialEntry(
  server: OfficialRegistryServerDocument,
  meta: OfficialRegistryMeta,
): ConnectRegistryLibraryItem {
  const support = deriveImportSupport(server);
  const installMode = deriveInstallMode(server);
  const packageTypes = listPackageTypes(server);
  const packageIdentifiers = listPackageIdentifiers(server);
  const remotePatterns = listRemotePatterns(server);
  const requiredConfigCount = countRequirements(support.requirements);
  const requirementKeys = listRequirementKeys(support.requirements);
  const status = meta.status ?? 'unknown';
  const publisher = derivePublisherVerification(server, meta);

  if (status === 'deleted') {
    support.autoImportable = false;
    support.configurableImport = false;
    support.readiness = 'blocked';
    support.strategy = 'manual';
    support.strategyOptions = [];
    support.requirements = emptyRequirements();
    support.reason = 'Deleted registry entries are blocked from auto-import';
  }

  let score = 0;
  const reasons: string[] = [];

  if (status === 'active') {
    score += 30;
    reasons.push('Registry status is active');
  } else if (status === 'deprecated') {
    score += 12;
    reasons.push('Registry marks this server as deprecated');
  } else if (status === 'deleted') {
    reasons.push('Registry marks this server as deleted');
  } else {
    score += 8;
    reasons.push('Registry status is not explicitly active');
  }

  if (meta.isLatest) {
    score += 10;
    reasons.push('Latest published version');
  }

  if (server.repository?.url) {
    score += 10;
    reasons.push('Repository URL is published');
  }

  if (publisher.verified) {
    score += 12;
    reasons.push(publisher.reason);
  } else {
    reasons.push('Publisher identity could not be verified heuristically');
  }

  if ((server.remotes?.length ?? 0) > 0) {
    score += installMode === 'hybrid' ? 20 : 24;
    reasons.push('Remote transport is advertised');
  }

  if ((server.packages?.length ?? 0) > 0) {
    score += installMode === 'hybrid' ? 14 : 18;
    reasons.push('Installable package metadata is published');
  }

  if (support.autoImportable) {
    score += 18;
    reasons.push(`Conduit can auto-import this server via ${support.strategy}`);
  } else if (support.configurableImport && support.readiness === 'needs-config') {
    score += 6;
    reasons.push(support.reason ?? 'Extra configuration is required before import');
  } else {
    reasons.push(support.reason ?? 'Manual setup is required');
  }

  if (requiredConfigCount > 0) {
    score -= Math.min(18, requiredConfigCount * 6);
    reasons.push(`${requiredConfigCount} required runtime parameter${requiredConfigCount > 1 ? 's' : ''} must be provided`);
  }

  const freshnessBonus = computeFreshnessBonus(meta.updatedAt ?? meta.publishedAt);
  if (freshnessBonus > 0) {
    score += freshnessBonus;
    reasons.push('Metadata was updated recently');
  }

  score = clamp(score, 0, 100);

  return {
    name: server.name,
    conduit_id: toConduitServerId(server.name),
    title: server.title ?? trailingName(server.name),
    description: server.description ?? 'No description provided.',
    version: server.version,
    status,
    is_latest: meta.isLatest === true,
    install_mode: installMode,
    readiness: support.readiness,
    strategy: support.strategy,
    score,
    score_label: score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 45 ? 'fair' : 'poor',
    auto_importable: support.autoImportable,
    configurable_import: support.configurableImport,
    package_types: packageTypes,
    package_identifiers: packageIdentifiers,
    remote_patterns: remotePatterns,
    package_count: server.packages?.length ?? 0,
    remote_count: server.remotes?.length ?? 0,
    required_config_count: requiredConfigCount,
    requirement_keys: requirementKeys,
    strategy_options: support.strategyOptions,
    import_requirements: support.requirements,
    verified_publisher: publisher.verified,
    publisher_label: publisher.label,
    verification_basis: publisher.basis,
    ...(server.repository?.url ? { repository_url: server.repository.url } : {}),
    ...(meta.publishedAt ? { published_at: meta.publishedAt } : {}),
    ...(meta.updatedAt ? { updated_at: meta.updatedAt } : {}),
    reasons,
  };
}

function buildLibrarySource(
  config: Required<ConnectRegistryConfig>,
  syncedAtMs: number | null,
  lastError: string | null,
): ConnectRegistryLibrarySourceInfo {
  return {
    base_url: config.base_url,
    ...(syncedAtMs ? { synced_at: new Date(syncedAtMs).toISOString() } : {}),
    cache_ttl_seconds: config.cache_ttl_seconds,
    latest_only: config.latest_only,
    stale: lastError !== null,
    ...(lastError ? { last_error: lastError } : {}),
  };
}

function buildLibraryFilters(cached: RegistryLibraryStoredItem[]): ConnectRegistryLibraryFilterFacets {
  return {
    statuses: uniqueStrings(cached.map((entry) => entry.item.status)),
    install_modes: ['remote', 'package', 'hybrid'],
    readiness_levels: ['ready', 'needs-config', 'manual', 'blocked'],
    package_types: uniqueStrings(cached.flatMap((entry) => entry.item.package_types)) as ConnectRegistryPackageType[],
  };
}

function applyLibraryFilters(
  items: ConnectRegistryLibraryItem[],
  filters: ConnectRegistryLibraryFilters,
): ConnectRegistryLibraryItem[] {
  const search = filters.search?.trim().toLowerCase();
  const searchTerms = tokenizeLibrarySearch(search);

  return items.filter((item) => {
    if (search && searchTerms.length > 0) {
      const haystack = [
        item.name,
        item.title,
        item.conduit_id,
        item.description,
        item.publisher_label,
        item.verification_basis,
        item.repository_url ?? '',
        item.package_types.join(' '),
        item.package_identifiers.join(' '),
        item.remote_patterns.join(' '),
        item.requirement_keys.join(' '),
        item.reasons.join(' '),
      ].join(' ').toLowerCase();
      if (!searchTerms.every((term) => haystack.includes(term))) {
        return false;
      }
    }

    if (filters.status && item.status !== filters.status) {
      return false;
    }

    if (filters.install_mode && item.install_mode !== filters.install_mode) {
      return false;
    }

    if (filters.readiness && item.readiness !== filters.readiness) {
      return false;
    }

    if (filters.package_type && !item.package_types.includes(filters.package_type)) {
      return false;
    }

    if (filters.min_score !== undefined && item.score < filters.min_score) {
      return false;
    }

    if (filters.auto_importable !== undefined && item.auto_importable !== filters.auto_importable) {
      return false;
    }

    return true;
  });
}

function tokenizeLibrarySearch(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .toLowerCase()
    .split(/[^a-z0-9@._/-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function compareLibraryItems(a: RegistryLibraryStoredItem, b: RegistryLibraryStoredItem): number {
  return (
    b.item.score - a.item.score ||
    Number(b.item.auto_importable) - Number(a.item.auto_importable) ||
    a.item.name.localeCompare(b.item.name)
  );
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeFreshnessBonus(timestamp: string | undefined): number {
  if (!timestamp) return 0;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return 0;
  const ageDays = (Date.now() - ms) / (24 * 60 * 60 * 1000);
  if (ageDays <= 30) return 10;
  if (ageDays <= 180) return 6;
  if (ageDays <= 365) return 3;
  return 0;
}

function deriveInstallMode(server: OfficialRegistryServerDocument): ConnectRegistryInstallMode {
  const hasRemotes = (server.remotes?.length ?? 0) > 0;
  const hasPackages = (server.packages?.length ?? 0) > 0;
  if (hasRemotes && hasPackages) return 'hybrid';
  if (hasRemotes) return 'remote';
  return 'package';
}

function listPackageTypes(server: OfficialRegistryServerDocument): ConnectRegistryPackageType[] {
  const values = uniqueStrings((server.packages ?? []).map((pkg) => normalizePackageType(pkg.registryType)));
  return values.length > 0 ? values as ConnectRegistryPackageType[] : ['unknown'];
}

function listPackageIdentifiers(server: OfficialRegistryServerDocument): string[] {
  return uniqueStrings(
    (server.packages ?? [])
      .map((pkg) => pkg.identifier?.trim() ?? '')
      .filter((value) => value.length > 0),
  );
}

function listRemotePatterns(server: OfficialRegistryServerDocument): string[] {
  return uniqueStrings(
    (server.remotes ?? [])
      .map((remote) => remote.url?.trim() ?? '')
      .filter((value) => value.length > 0),
  );
}

function listRequirementKeys(requirements: ConnectRegistryRequirements): string[] {
  return uniqueStrings([
    ...requirements.variables.map((field) => field.key),
    ...requirements.headers.map((field) => field.key),
    ...requirements.env.map((field) => field.key),
  ]);
}

function normalizePackageType(value: string | undefined): ConnectRegistryPackageType {
  switch (value) {
    case 'npm':
    case 'pypi':
    case 'nuget':
    case 'oci':
    case 'mcpb':
      return value;
    default:
      return 'unknown';
  }
}

interface ImportSupport {
  autoImportable: boolean;
  configurableImport: boolean;
  readiness: ConnectRegistryReadiness;
  strategy: ConnectRegistryStrategy;
  strategyOptions: Array<Exclude<ConnectRegistryStrategy, 'manual'>>;
  requirements: ConnectRegistryRequirements;
  reason?: string;
}

function deriveImportSupport(server: OfficialRegistryServerDocument): ImportSupport {
  const options = deriveImportOptions(server);
  const preferred = options[0];
  if (preferred) {
    return {
      autoImportable: preferred.readiness === 'ready',
      configurableImport: true,
      readiness: preferred.readiness,
      strategy: preferred.strategy,
      strategyOptions: Array.from(new Set(options.map((option) => option.strategy))),
      requirements: preferred.requirements,
      ...(preferred.readiness === 'needs-config'
        ? { reason: 'Required headers, variables, or environment values must be collected before import' }
        : {}),
    };
  }

  return {
    autoImportable: false,
    configurableImport: false,
    readiness: 'manual',
    strategy: 'manual',
    strategyOptions: [],
    requirements: emptyRequirements(),
    reason: 'This registry entry cannot yet be mapped automatically into a managed Conduit runtime',
  };
}

interface ImportOption {
  strategy: Exclude<ConnectRegistryStrategy, 'manual'>;
  readiness: Extract<ConnectRegistryReadiness, 'ready' | 'needs-config'>;
  requirements: ConnectRegistryRequirements;
  remote?: OfficialRegistryRemote;
  package?: OfficialRegistryPackage;
}

function deriveImportOptions(server: OfficialRegistryServerDocument): ImportOption[] {
  const options: ImportOption[] = [];

  const remote = (server.remotes ?? []).find((candidate) => typeof candidate.url === 'string');
  if (remote) {
    const requirements = buildRemoteRequirements(remote);
    options.push({
      strategy: 'proxy-remote',
      readiness: countRequirements(requirements) > 0 ? 'needs-config' : 'ready',
      requirements,
      remote,
    });
  }

  const packageCandidate = (server.packages ?? []).find(canAutoImportPackage);
  if (packageCandidate) {
    const requirements = buildPackageRequirements(packageCandidate);
    options.push({
      strategy: 'conduit-host-package',
      readiness: countRequirements(requirements) > 0 ? 'needs-config' : 'ready',
      requirements,
      package: packageCandidate,
    });
  }

  return options.sort(compareImportOptions);
}

function canAutoImportPackage(pkg: OfficialRegistryPackage): boolean {
  const packageType = normalizePackageType(pkg.registryType);
  return packageType === 'npm' || packageType === 'pypi' || packageType === 'oci';
}

function compareImportOptions(a: ImportOption, b: ImportOption): number {
  const readinessRank = a.readiness === b.readiness
    ? 0
    : a.readiness === 'ready'
      ? -1
      : 1;
  if (readinessRank !== 0) {
    return readinessRank;
  }

  if (a.strategy === b.strategy) {
    return 0;
  }

  return a.strategy === 'proxy-remote' ? -1 : 1;
}

function findImportOption(
  server: OfficialRegistryServerDocument,
  strategy: Exclude<ConnectRegistryStrategy, 'manual'>,
): ImportOption | undefined {
  return deriveImportOptions(server).find((option) => option.strategy === strategy);
}

function buildRemoteRequirements(remote: OfficialRegistryRemote): ConnectRegistryRequirements {
  return {
    variables: Object.entries(remote.variables ?? {}).map(([key, variable]) => ({
      key,
      label: key,
      ...(variable?.description ? { description: variable.description } : {}),
      required: variable?.isRequired === true,
      secret: variable?.isSecret === true,
      source: 'remote-variable' as const,
      ...(typeof variable?.default === 'string' ? { default_value: variable.default } : {}),
      ...(Array.isArray(variable?.choices)
        ? { choices: variable.choices.filter((choice): choice is string => typeof choice === 'string') }
        : {}),
    })),
    headers: (remote.headers ?? [])
      .filter((header): header is NonNullable<typeof header> & { name: string } => typeof header?.name === 'string' && header.name.trim().length > 0)
      .map((header) => ({
        key: header.name,
        label: header.name,
        ...(header.description ? { description: header.description } : {}),
        required: header.isRequired === true,
        secret: header.isSecret === true,
        source: 'remote-header' as const,
      })),
    env: [],
  };
}

function buildPackageRequirements(pkg: OfficialRegistryPackage): ConnectRegistryRequirements {
  return {
    variables: [],
    headers: [],
    env: (pkg.environmentVariables ?? [])
      .filter((variable): variable is NonNullable<typeof variable> & { name: string } => typeof variable?.name === 'string' && variable.name.trim().length > 0)
      .map((variable) => ({
        key: variable.name,
        label: variable.name,
        ...(variable.description ? { description: variable.description } : {}),
        required: variable.isRequired === true,
        secret: variable.isSecret === true,
        source: 'package-env' as const,
      })),
  };
}

function emptyRequirements(): ConnectRegistryRequirements {
  return {
    variables: [],
    headers: [],
    env: [],
  };
}

function countRequirements(requirements: ConnectRegistryRequirements): number {
  return requirements.variables.filter((field) => field.required).length +
    requirements.headers.filter((field) => field.required).length +
    requirements.env.filter((field) => field.required).length;
}

function buildServerConfigFromOfficialServer(
  server: OfficialRegistryServerDocument,
  option: ImportOption,
  config: ConnectRegistryImportOptions,
  managedRuntimeConfig: ConnectManagedRuntimeConfig,
): ServerConfig {
  const cache: ServerCacheConfig = { default_ttl: 0 };
  const id = toConduitServerId(server.name);

  if (option.remote?.url) {
    const url = resolveRemoteUrl(option.remote.url, option.requirements.variables, config.variables);
    const headers = resolveRequirementMap(option.requirements.headers, config.headers);
    return {
      id,
      url,
      cache,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  if (option.package) {
    const packageType = normalizePackageType(option.package.registryType);
    const identifier = option.package.identifier ?? '';
    const version = option.package.version ?? server.version;
    const env = resolveRequirementMap(option.requirements.env, config.env);

    if (packageType === 'npm') {
      const args = [
        '-y',
        buildVersionedPackageIdentifier(identifier, version),
        ...buildPackageRuntimeArguments(option.package),
      ];
      return {
        id,
        transport: 'stdio',
        url: `stdio://npx/${identifier}`,
        command: 'npx',
        args,
        cache,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        managed_runtime: createManagedRuntimeForPackage({
          serverId: id,
          sourceType: 'npm',
          sourceRef: identifier,
          version,
          command: 'npx',
          args,
          ...(Object.keys(env).length > 0 ? { env } : {}),
          defaults: managedRuntimeConfig,
        }),
      };
    }

    if (packageType === 'pypi') {
      const args = [
        version ? `${identifier}==${version}` : identifier,
        ...buildPackageRuntimeArguments(option.package),
      ];
      return {
        id,
        transport: 'stdio',
        url: `stdio://uvx/${identifier}`,
        command: 'uvx',
        args,
        cache,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        managed_runtime: createManagedRuntimeForPackage({
          serverId: id,
          sourceType: 'pypi',
          sourceRef: identifier,
          version,
          command: 'uvx',
          args,
          ...(Object.keys(env).length > 0 ? { env } : {}),
          defaults: managedRuntimeConfig,
        }),
      };
    }

    if (packageType === 'oci') {
      const args = ['run', '-i', '--rm', identifier, ...buildPackageRuntimeArguments(option.package)];
      return {
        id,
        transport: 'stdio',
        url: `stdio://docker/${identifier}`,
        command: 'docker',
        args,
        cache,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        managed_runtime: createManagedRuntimeForPackage({
          serverId: id,
          sourceType: 'oci',
          sourceRef: identifier,
          version,
          command: 'docker',
          args,
          ...(Object.keys(env).length > 0 ? { env } : {}),
          defaults: managedRuntimeConfig,
        }),
      };
    }
  }

  throw new Error(`Registry server "${server.name}" cannot be converted into a Conduit server config automatically`);
}

function buildVersionedPackageIdentifier(identifier: string, version: string | undefined): string {
  if (!version) {
    return identifier;
  }

  if (identifier.startsWith('@')) {
    const secondAt = identifier.indexOf('@', 1);
    return secondAt === -1 ? `${identifier}@${version}` : identifier;
  }

  return identifier.includes('@') ? identifier : `${identifier}@${version}`;
}

function buildPackageRuntimeArguments(pkg: OfficialRegistryPackage): string[] {
  const args: string[] = [];

  for (const runtimeArg of pkg.runtimeArguments ?? []) {
    if (!runtimeArg || typeof runtimeArg !== 'object') {
      continue;
    }

    const type = typeof runtimeArg.type === 'string' ? runtimeArg.type : 'positional';
    const name = typeof runtimeArg.name === 'string' ? runtimeArg.name.trim() : '';
    const value = typeof runtimeArg.value === 'string' ? runtimeArg.value : '';

    if (type === 'positional') {
      if (value.trim().length > 0) {
        args.push(value);
      }
      continue;
    }

    if ((type === 'flag' || type === 'switch') && (name || value)) {
      const flag = normalizeRuntimeFlag(name || value);
      if (flag) {
        args.push(flag);
      }
      continue;
    }

    if ((type === 'option' || type === 'named') && name && value.trim().length > 0) {
      const flag = normalizeRuntimeFlag(name);
      if (flag) {
        args.push(flag, value);
      }
      continue;
    }
  }

  return args;
}

function normalizeRuntimeFlag(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('-')) {
    return trimmed;
  }

  return trimmed.length === 1 ? `-${trimmed}` : `--${trimmed}`;
}

function resolveRemoteUrl(
  template: string,
  requirements: ConnectRegistryRequirementField[],
  supplied: Record<string, string> | undefined,
): string {
  let resolved = template;

  for (const requirement of requirements) {
    const value = resolveRequirementValue(requirement, supplied?.[requirement.key]);
    if (value === undefined) {
      continue;
    }
    resolved = resolved.replaceAll(`{${requirement.key}}`, encodeURIComponent(value));
  }

  const unresolved = Array.from(resolved.matchAll(/\{([^{}]+)\}/g)).map((match) => match[1]);
  if (unresolved.length > 0) {
    throw new Error(`Missing URL template values for ${Array.from(new Set(unresolved)).join(', ')}`);
  }

  return resolved;
}

function resolveRequirementMap(
  requirements: ConnectRegistryRequirementField[],
  supplied: Record<string, string> | undefined,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const requirement of requirements) {
    const value = resolveRequirementValue(requirement, supplied?.[requirement.key]);
    if (value !== undefined) {
      resolved[requirement.key] = value;
    }
  }
  return resolved;
}

function resolveRequirementValue(
  requirement: ConnectRegistryRequirementField,
  suppliedValue: string | undefined,
): string | undefined {
  const trimmed = suppliedValue?.trim();
  const value = trimmed && trimmed.length > 0
    ? trimmed
    : requirement.default_value;

  if ((value === undefined || value.length === 0) && requirement.required) {
    throw new Error(`Missing required ${requirement.source} value "${requirement.key}"`);
  }

  if (value && requirement.choices && requirement.choices.length > 0 && !requirement.choices.includes(value)) {
    throw new Error(`Invalid value for "${requirement.key}". Expected one of: ${requirement.choices.join(', ')}`);
  }

  return value;
}

function findOfficialServer(
  cached: RegistryLibraryStoredItem[],
  name: string,
  version: string,
): RegistryLibraryStoredItem | undefined {
  if (version === 'latest') {
    return cached.find((entry) => entry.raw.name === name && entry.item.is_latest);
  }

  return cached.find((entry) => entry.raw.name === name && entry.raw.version === version);
}

function trailingName(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1] ?? name;
}

interface PublisherVerification {
  verified: boolean;
  basis: ConnectRegistryVerificationBasis;
  label: string;
  reason: string;
}

function derivePublisherVerification(
  server: OfficialRegistryServerDocument,
  meta: OfficialRegistryMeta,
): PublisherVerification {
  if (meta.status === 'active' && (meta as Record<string, unknown>)['publisherVerified'] === true) {
    return {
      verified: true,
      basis: 'registry',
      label: derivePublisherLabel(server),
      reason: 'Registry metadata marks the publisher as verified',
    };
  }

  const repository = parseRepository(server.repository?.url);
  const namespace = parseRegistryNamespace(server.name);
  if (
    repository?.owner &&
    namespace?.owner &&
    repository.owner.toLowerCase() === namespace.owner.toLowerCase()
  ) {
    return {
      verified: true,
      basis: 'namespace-repository-match',
      label: repository.owner,
      reason: 'Repository owner matches the published registry namespace',
    };
  }

  const packageScope = findPackageScope(server.packages);
  if (
    repository?.owner &&
    packageScope &&
    repository.owner.toLowerCase() === packageScope.toLowerCase()
  ) {
    return {
      verified: true,
      basis: 'package-scope-match',
      label: repository.owner,
      reason: 'Package scope matches the declared repository owner',
    };
  }

  return {
    verified: false,
    basis: 'unverified',
    label: derivePublisherLabel(server),
    reason: 'Publisher identity could not be verified from repository or package metadata',
  };
}

function derivePublisherLabel(server: OfficialRegistryServerDocument): string {
  const repository = parseRepository(server.repository?.url);
  if (repository?.owner) {
    return repository.owner;
  }

  const packageScope = findPackageScope(server.packages);
  if (packageScope) {
    return packageScope;
  }

  const namespace = parseRegistryNamespace(server.name);
  if (namespace?.owner) {
    return namespace.owner;
  }

  return 'community';
}

function parseRepository(url: string | undefined): { host: string; owner?: string; repo?: string } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return {
      host: parsed.hostname.toLowerCase(),
      ...(segments[0] ? { owner: segments[0] } : {}),
      ...(segments[1] ? { repo: segments[1].replace(/\.git$/i, '') } : {}),
    };
  } catch {
    return null;
  }
}

function parseRegistryNamespace(name: string): { owner?: string } | null {
  const [namespace] = name.split('/');
  if (!namespace) return null;
  const parts = namespace.split('.');
  if (parts.length < 3) {
    return null;
  }
  return parts[2] ? { owner: parts[2] } : null;
}

function findPackageScope(packages: OfficialRegistryPackage[] | undefined): string | undefined {
  for (const pkg of packages ?? []) {
    if (!pkg.identifier) continue;
    const match = pkg.identifier.match(/^@([^/]+)\//);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

export function toConduitServerId(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized || 'registry-server';
}
