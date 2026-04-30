import type { GovernanceRegistryDecision } from '../governance/types.js';
import type {
  ConnectRegistryLibraryFilters,
  ConnectRegistryLibraryItem,
  ConnectRegistryPagination,
  ConnectRegistryLibraryResponse,
  ConnectRegistryLibrarySourceInfo,
  ConnectRegistryPackageType,
  ConnectRegistryReadiness,
  ConnectRegistryResolvedLibraryResponse,
  ConnectRegistrySort,
  ConnectRegistryStrategy,
  OfficialRegistryServerDocument,
} from './registry.js';
import type { ConnectTarget, ConnectTargetDefinition } from './export.js';

export type ConnectRegistryRuntimeStatus = 'not-imported' | 'healthy' | 'unhealthy';
export type ConnectRegistryPolicyFitStatus = 'allowed' | 'blocked' | 'not-evaluated';
export type ConnectRegistryRecommendationAction =
  | 'install-now'
  | 'fix-runtime'
  | 'import-to-conduit'
  | 'configure-and-import'
  | 'manual-review'
  | 'blocked-by-policy';
export type ConnectRegistryCompatibilityLevel = 'native' | 'bridged' | 'manual';

export interface ConnectRegistryManagedRuntime {
  managed: boolean;
  healthy: boolean;
  tool_count: number;
  latency_ms: number;
  last_checked?: string;
  profile_ids: string[];
}

export interface ConnectRegistryPolicyContext {
  workspace_id?: string;
  roles: string[];
  decision?: GovernanceRegistryDecision;
}

export interface ConnectRegistryTargetCompatibility {
  id: ConnectTarget;
  label: string;
  format: ConnectTargetDefinition['format'];
  supported: boolean;
  level: ConnectRegistryCompatibilityLevel;
  recommended: boolean;
  reason: string;
}

export interface ConnectRegistryRuntimeHealth {
  status: ConnectRegistryRuntimeStatus;
  score: number;
  managed: boolean;
  healthy: boolean;
  tool_count: number;
  latency_ms: number;
  last_checked?: string;
  profile_ids: string[];
  summary: string;
}

export interface ConnectRegistryPolicyFit {
  status: ConnectRegistryPolicyFitStatus;
  summary: string;
  workspace_id?: string;
  roles: string[];
  policy_name?: string;
}

export interface ConnectRegistryRecommendation {
  action: ConnectRegistryRecommendationAction;
  strategy: ConnectRegistryStrategy;
  title: string;
  summary: string;
  preferred_targets: ConnectTarget[];
}

export interface ConnectRegistryTrustSummary {
  score: number;
  label: ConnectRegistryLibraryItem['score_label'];
  verified_publisher: boolean;
  publisher_label: string;
  verification_basis: ConnectRegistryLibraryItem['verification_basis'];
  reasons: string[];
}

export interface ConnectRegistrySmartData {
  trust: ConnectRegistryTrustSummary;
  runtime: ConnectRegistryRuntimeHealth;
  policy_fit: ConnectRegistryPolicyFit;
  compatibility: {
    supported_count: number;
    recommended_targets: ConnectTarget[];
    targets: ConnectRegistryTargetCompatibility[];
  };
  recommendation: ConnectRegistryRecommendation;
  badges: string[];
}

export interface ConnectRegistrySmartLibraryItem extends ConnectRegistryLibraryItem {
  smart: ConnectRegistrySmartData;
  governance?: GovernanceRegistryDecision;
}

export interface ConnectRegistrySmartLibraryFilters extends ConnectRegistryLibraryFilters {
  verified_publisher?: boolean;
  runtime_status?: ConnectRegistryRuntimeStatus;
  policy_fit?: Exclude<ConnectRegistryPolicyFitStatus, 'not-evaluated'>;
  target?: ConnectTarget;
  sort?: ConnectRegistrySort;
}

export interface ConnectRegistrySmartLibraryResponse extends Omit<ConnectRegistryLibraryResponse, 'items'> {
  filters: ConnectRegistryLibraryResponse['filters'] & {
    runtime_statuses: ConnectRegistryRuntimeStatus[];
    policy_fit_statuses: Exclude<ConnectRegistryPolicyFitStatus, 'not-evaluated'>[];
    targets: ConnectTarget[];
  };
  stats: ConnectRegistryLibraryResponse['stats'] & {
    verified_publishers: number;
    managed_in_conduit: number;
    healthy_runtime: number;
    policy_blocked: number;
  };
  pagination: ConnectRegistryPagination;
  items: ConnectRegistrySmartLibraryItem[];
}

export function enrichSmartRegistryItem(input: {
  item: ConnectRegistryLibraryItem;
  raw: OfficialRegistryServerDocument;
  targets: ConnectTargetDefinition[];
  managedRuntime?: ConnectRegistryManagedRuntime;
  policy?: ConnectRegistryPolicyContext;
}): ConnectRegistrySmartLibraryItem {
  const runtime = buildRuntimeHealth(input.item, input.managedRuntime);
  const policyFit = buildPolicyFit(input.policy);
  const compatibility = buildCompatibility(input.item, input.targets);
  const recommendation = buildRecommendation(input.item, runtime, policyFit, compatibility.recommended_targets);
  const badges = buildBadges(input.item, runtime, policyFit);

  return {
    ...input.item,
    ...(input.policy?.decision ? { governance: input.policy.decision } : {}),
    smart: {
      trust: {
        score: input.item.score,
        label: input.item.score_label,
        verified_publisher: input.item.verified_publisher,
        publisher_label: input.item.publisher_label,
        verification_basis: input.item.verification_basis,
        reasons: input.item.reasons.slice(0, 5),
      },
      runtime,
      policy_fit: policyFit,
      compatibility,
      recommendation,
      badges,
    },
  };
}

export function applySmartRegistryFilters(
  items: ConnectRegistrySmartLibraryItem[],
  filters: ConnectRegistrySmartLibraryFilters,
): ConnectRegistrySmartLibraryItem[] {
  const search = filters.search?.trim().toLowerCase();
  const searchScores = new Map<string, number>();
  const filtered = items.filter((item) => {
    if (search) {
      const score = scoreSmartRegistrySearch(item, search);
      if (score <= 0) {
        return false;
      }
      searchScores.set(searchKey(item), score);
    }

    if (filters.status && item.status !== filters.status) return false;
    if (filters.install_mode && item.install_mode !== filters.install_mode) return false;
    if (filters.readiness && item.readiness !== filters.readiness) return false;
    if (filters.package_type && !item.package_types.includes(filters.package_type as ConnectRegistryPackageType)) return false;
    if (filters.min_score !== undefined && item.score < filters.min_score) return false;
    if (filters.auto_importable !== undefined && item.auto_importable !== filters.auto_importable) return false;
    if (filters.verified_publisher !== undefined && item.verified_publisher !== filters.verified_publisher) return false;
    if (filters.runtime_status && item.smart.runtime.status !== filters.runtime_status) return false;
    if (filters.policy_fit && item.smart.policy_fit.status !== filters.policy_fit) return false;
    if (filters.target && !item.smart.compatibility.targets.some((target) => target.id === filters.target && target.supported)) return false;

    return true;
  });

  const sort = filters.sort ?? (search ? 'relevance' : 'trust');
  return filtered.sort((left, right) => compareSmartRegistryItems(left, right, sort, searchScores));
}

export function buildSmartRegistryResponse(input: {
  snapshot: ConnectRegistryResolvedLibraryResponse;
  items: ConnectRegistrySmartLibraryItem[];
  filtered: ConnectRegistrySmartLibraryItem[];
  limit: number;
  offset: number;
  targets: ConnectTargetDefinition[];
}): ConnectRegistrySmartLibraryResponse {
  const paged = input.filtered.slice(input.offset, input.offset + input.limit);
  const page = input.limit > 0 ? Math.floor(input.offset / input.limit) + 1 : 1;
  const totalPages = Math.max(1, Math.ceil(input.filtered.length / input.limit));

  return {
    source: input.snapshot.source,
    filters: {
      ...input.snapshot.filters,
      runtime_statuses: ['not-imported', 'healthy', 'unhealthy'],
      policy_fit_statuses: ['allowed', 'blocked'],
      targets: input.targets.map((target) => target.id),
    },
    stats: {
      total: input.items.length,
      filtered: input.filtered.length,
      auto_importable: input.items.filter((item) => item.auto_importable).length,
      ready: input.items.filter((item) => item.readiness === 'ready').length,
      needs_config: input.items.filter((item) => item.readiness === 'needs-config').length,
      remote: input.items.filter((item) => item.install_mode === 'remote').length,
      package: input.items.filter((item) => item.install_mode === 'package').length,
      hybrid: input.items.filter((item) => item.install_mode === 'hybrid').length,
      verified_publishers: input.items.filter((item) => item.verified_publisher).length,
      managed_in_conduit: input.items.filter((item) => item.smart.runtime.managed).length,
      healthy_runtime: input.items.filter((item) => item.smart.runtime.status === 'healthy').length,
      policy_blocked: input.items.filter((item) => item.smart.policy_fit.status === 'blocked').length,
    },
    pagination: {
      limit: input.limit,
      offset: input.offset,
      returned: paged.length,
      total_filtered: input.filtered.length,
      page,
      total_pages: totalPages,
      has_more: input.offset + paged.length < input.filtered.length,
      ...(input.offset + paged.length < input.filtered.length ? { next_offset: input.offset + input.limit } : {}),
      ...(input.offset > 0 ? { previous_offset: Math.max(0, input.offset - input.limit) } : {}),
    },
    items: paged,
  };
}

function compareSmartRegistryItems(
  left: ConnectRegistrySmartLibraryItem,
  right: ConnectRegistrySmartLibraryItem,
  sort: ConnectRegistrySort,
  searchScores: Map<string, number>,
): number {
  const byName = left.name.localeCompare(right.name);
  switch (sort) {
    case 'name':
      return byName;
    case 'updated':
      return (
        compareIsoDates(right.updated_at, left.updated_at) ||
        right.score - left.score ||
        byName
      );
    case 'published':
      return (
        compareIsoDates(right.published_at, left.published_at) ||
        right.score - left.score ||
        byName
      );
    case 'runtime':
      return (
        runtimeRank(right.smart.runtime.status) - runtimeRank(left.smart.runtime.status) ||
        right.smart.runtime.tool_count - left.smart.runtime.tool_count ||
        right.score - left.score ||
        byName
      );
    case 'relevance':
      return (
        (searchScores.get(searchKey(right)) ?? 0) - (searchScores.get(searchKey(left)) ?? 0) ||
        right.score - left.score ||
        Number(right.verified_publisher) - Number(left.verified_publisher) ||
        compareIsoDates(right.updated_at, left.updated_at) ||
        byName
      );
    case 'trust':
    default:
      return (
        right.score - left.score ||
        Number(right.verified_publisher) - Number(left.verified_publisher) ||
        runtimeRank(right.smart.runtime.status) - runtimeRank(left.smart.runtime.status) ||
        compareIsoDates(right.updated_at, left.updated_at) ||
        byName
      );
  }
}

function scoreSmartRegistrySearch(item: ConnectRegistrySmartLibraryItem, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }

  const terms = tokenizeRegistrySearch(normalizedQuery);
  if (terms.length === 0) {
    return 0;
  }

  const fields = buildRegistrySearchFields(item);
  let total = 0;

  for (const term of terms) {
    let best = 0;
    for (const field of fields) {
      const fieldScore = scoreSearchField(field.value, term, field.weight);
      if (fieldScore > best) {
        best = fieldScore;
      }
    }
    if (best === 0) {
      return 0;
    }
    total += best;
  }

  for (const field of fields) {
    if (field.value === normalizedQuery) {
      total += field.weight * 3;
    } else if (field.value.startsWith(normalizedQuery)) {
      total += field.weight * 2;
    } else if (field.value.includes(normalizedQuery)) {
      total += Math.round(field.weight * 1.2);
    }
  }

  if (item.smart.recommendation.action === 'install-now') total += 20;
  if (item.smart.runtime.status === 'healthy') total += 14;
  if (item.auto_importable) total += 10;
  if (item.verified_publisher) total += 8;

  return total;
}

function buildRegistrySearchFields(item: ConnectRegistrySmartLibraryItem): Array<{ value: string; weight: number }> {
  return [
    { value: item.name.toLowerCase(), weight: 120 },
    { value: item.title.toLowerCase(), weight: 105 },
    { value: item.conduit_id.toLowerCase(), weight: 96 },
    { value: item.publisher_label.toLowerCase(), weight: 90 },
    { value: item.description.toLowerCase(), weight: 74 },
    { value: item.repository_url?.toLowerCase() ?? '', weight: 68 },
    { value: item.package_types.join(' ').toLowerCase(), weight: 56 },
    { value: item.package_identifiers.join(' ').toLowerCase(), weight: 82 },
    { value: item.remote_patterns.join(' ').toLowerCase(), weight: 60 },
    { value: item.requirement_keys.join(' ').toLowerCase(), weight: 70 },
    { value: item.reasons.join(' ').toLowerCase(), weight: 42 },
    { value: item.smart.recommendation.title.toLowerCase(), weight: 54 },
    { value: item.smart.recommendation.summary.toLowerCase(), weight: 46 },
    { value: item.smart.policy_fit.summary.toLowerCase(), weight: 40 },
    { value: item.smart.badges.join(' ').toLowerCase(), weight: 36 },
    { value: item.smart.compatibility.targets.map((target) => `${target.id} ${target.label} ${target.reason}`).join(' ').toLowerCase(), weight: 34 },
  ].filter((field) => field.value.length > 0);
}

function scoreSearchField(value: string, term: string, weight: number): number {
  if (!value || !term) {
    return 0;
  }
  if (value === term) {
    return weight * 3;
  }
  if (value.startsWith(term)) {
    return weight * 2;
  }
  const tokens = tokenizeRegistrySearch(value);
  if (tokens.includes(term)) {
    return Math.round(weight * 1.6);
  }
  if (tokens.some((token) => token.startsWith(term))) {
    return Math.round(weight * 1.2);
  }
  if (value.includes(term)) {
    return Math.round(weight * 0.8);
  }
  return 0;
}

function tokenizeRegistrySearch(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9@._/-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function runtimeRank(status: ConnectRegistryRuntimeStatus): number {
  switch (status) {
    case 'healthy':
      return 3;
    case 'not-imported':
      return 2;
    case 'unhealthy':
      return 1;
    default:
      return 0;
  }
}

function compareIsoDates(left: string | undefined, right: string | undefined): number {
  const leftMs = left ? Date.parse(left) : 0;
  const rightMs = right ? Date.parse(right) : 0;
  return (Number.isNaN(leftMs) ? 0 : leftMs) - (Number.isNaN(rightMs) ? 0 : rightMs);
}

function searchKey(item: ConnectRegistrySmartLibraryItem): string {
  return `${item.name}@${item.version}`;
}

function buildRuntimeHealth(
  item: ConnectRegistryLibraryItem,
  managedRuntime: ConnectRegistryManagedRuntime | undefined,
): ConnectRegistryRuntimeHealth {
  if (!managedRuntime?.managed) {
    return {
      status: 'not-imported',
      score: 0,
      managed: false,
      healthy: false,
      tool_count: 0,
      latency_ms: 0,
      profile_ids: [],
      summary: 'Not yet imported into Conduit',
    };
  }

  const status: ConnectRegistryRuntimeStatus = managedRuntime.healthy ? 'healthy' : 'unhealthy';
  return {
    status,
    score: managedRuntime.healthy ? 100 : 25,
    managed: true,
    healthy: managedRuntime.healthy,
    tool_count: managedRuntime.tool_count,
    latency_ms: managedRuntime.latency_ms,
    ...(managedRuntime.last_checked ? { last_checked: managedRuntime.last_checked } : {}),
    profile_ids: managedRuntime.profile_ids,
    summary: managedRuntime.healthy
      ? `Managed by Conduit with ${managedRuntime.tool_count} tool${managedRuntime.tool_count === 1 ? '' : 's'}`
      : 'Imported into Conduit but currently unhealthy',
  };
}

function buildPolicyFit(policy: ConnectRegistryPolicyContext | undefined): ConnectRegistryPolicyFit {
  if (!policy?.decision) {
    return {
      status: 'not-evaluated',
      summary: 'No workspace policy evaluation for this registry entry',
      ...(policy?.workspace_id ? { workspace_id: policy.workspace_id } : {}),
      roles: policy?.roles ?? [],
    };
  }

  if (policy.decision.allowed) {
    return {
      status: 'allowed',
      summary: policy.decision.reason,
      ...(policy.workspace_id ? { workspace_id: policy.workspace_id } : {}),
      roles: policy.roles,
      ...(policy.decision.policy_name ? { policy_name: policy.decision.policy_name } : {}),
    };
  }

  return {
    status: 'blocked',
    summary: policy.decision.reason,
    ...(policy.workspace_id ? { workspace_id: policy.workspace_id } : {}),
    roles: policy.roles,
    ...(policy.decision.policy_name ? { policy_name: policy.decision.policy_name } : {}),
  };
}

function buildCompatibility(
  item: ConnectRegistryLibraryItem,
  targets: ConnectTargetDefinition[],
): {
  supported_count: number;
  recommended_targets: ConnectTarget[];
  targets: ConnectRegistryTargetCompatibility[];
} {
  const compat = targets
    .map((target) => {
      const level = compatibilityLevelForTarget(target.id);
      const recommended = level === 'native' && target.id !== 'generic-json';
      return {
        id: target.id,
        label: target.label,
        format: target.format,
        supported: true,
        level,
        recommended,
        reason: compatibilityReason(item, target.id, level),
      };
    })
    .sort((a, b) => compatibilityRank(b) - compatibilityRank(a));

  return {
    supported_count: compat.filter((entry) => entry.supported).length,
    recommended_targets: compat.filter((entry) => entry.recommended).map((entry) => entry.id).slice(0, 3),
    targets: compat,
  };
}

function compatibilityLevelForTarget(target: ConnectTarget): ConnectRegistryCompatibilityLevel {
  switch (target) {
    case 'claude-desktop':
      return 'bridged';
    case 'generic-json':
      return 'manual';
    default:
      return 'native';
  }
}

function compatibilityReason(
  item: ConnectRegistryLibraryItem,
  target: ConnectTarget,
  level: ConnectRegistryCompatibilityLevel,
): string {
  if (level === 'bridged') {
    return `Installed through the Conduit bridge for ${target} after the server is managed here`;
  }
  if (level === 'manual') {
    return 'Generic config export is available, but installation remains manual';
  }
  if (item.readiness === 'blocked') {
    return 'Client adapter exists, but the registry entry itself is blocked before Conduit import';
  }
  return `Native ${target} export is available once the server is routed through Conduit`;
}

function compatibilityRank(entry: ConnectRegistryTargetCompatibility): number {
  const base = entry.level === 'native' ? 100 : entry.level === 'bridged' ? 60 : 20;
  switch (entry.id) {
    case 'cursor':
      return base + 8;
    case 'codex':
      return base + 7;
    case 'vscode':
      return base + 6;
    case 'windsurf':
      return base + 5;
    case 'claude-code':
      return base + 4;
    case 'claude-desktop':
      return base + 3;
    default:
      return base;
  }
}

function buildRecommendation(
  item: ConnectRegistryLibraryItem,
  runtime: ConnectRegistryRuntimeHealth,
  policyFit: ConnectRegistryPolicyFit,
  preferredTargets: ConnectTarget[],
): ConnectRegistryRecommendation {
  if (policyFit.status === 'blocked') {
    return {
      action: 'blocked-by-policy',
      strategy: item.strategy,
      title: 'Blocked by workspace policy',
      summary: policyFit.summary,
      preferred_targets: [],
    };
  }

  if (runtime.status === 'healthy') {
    return {
      action: 'install-now',
      strategy: item.strategy,
      title: 'Ready for client installation',
      summary: `Already healthy in Conduit. Install directly into ${preferredTargets.slice(0, 2).join(' or ') || 'a supported client'}.`,
      preferred_targets: preferredTargets,
    };
  }

  if (runtime.status === 'unhealthy') {
    return {
      action: 'fix-runtime',
      strategy: item.strategy,
      title: 'Fix runtime health before rollout',
      summary: 'This server is already imported into Conduit but is not healthy enough for client rollout.',
      preferred_targets: preferredTargets,
    };
  }

  if (item.readiness === 'ready' && item.auto_importable) {
    return {
      action: 'import-to-conduit',
      strategy: item.strategy,
      title: 'Import, then install',
      summary: `One-click import is available through ${item.strategy}. After import, install it in a supported client.`,
      preferred_targets: preferredTargets,
    };
  }

  if (item.readiness === 'needs-config' && item.configurable_import) {
    return {
      action: 'configure-and-import',
      strategy: item.strategy,
      title: 'Collect secrets, then import',
      summary: `Provide ${item.required_config_count} required runtime value${item.required_config_count === 1 ? '' : 's'} before importing this server into Conduit.`,
      preferred_targets: preferredTargets,
    };
  }

  return {
    action: 'manual-review',
    strategy: item.strategy,
    title: 'Manual review required',
    summary: 'This registry entry cannot be turned into a managed Conduit server without manual intervention.',
    preferred_targets: preferredTargets,
  };
}

function buildBadges(
  item: ConnectRegistryLibraryItem,
  runtime: ConnectRegistryRuntimeHealth,
  policyFit: ConnectRegistryPolicyFit,
): string[] {
  const badges: string[] = [];
  if (item.verified_publisher) badges.push('verified-publisher');
  if (item.auto_importable) badges.push('one-click');
  if (runtime.status === 'healthy') badges.push('runtime-healthy');
  if (runtime.status === 'unhealthy') badges.push('runtime-unhealthy');
  if (policyFit.status === 'blocked') badges.push('policy-blocked');
  if (item.readiness === 'needs-config') badges.push('needs-secrets');
  return badges;
}
