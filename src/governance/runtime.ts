import { createHash } from 'node:crypto';
import type {
  GovernanceConfig,
  GovernanceRegistryPolicyConfig,
  GovernanceToolPolicyConfig,
  WorkspaceRole,
} from '../config/types.js';
import type { ConduitGatewayConfig } from '../config/types.js';
import type { AuthenticatedPrincipal, ResolvedWorkspace } from '../identity/types.js';
import { IdentityRuntime } from '../identity/runtime.js';
import { matchesAnyPattern } from '../utils/pattern.js';
import { deterministicStringify, type SortableValue } from '../utils/deep-sort.js';
import { SlidingWindowLimiter } from '../rate-limit/limiter.js';
import type { RateLimitBackend, ToolRateLimitConfig } from '../rate-limit/types.js';
import type { GovernanceStore } from './store.js';
import type {
  CreateGovernanceApprovalRequestInput,
  GovernanceApprovalDecision,
  GovernanceApprovalRequestSummary,
  GovernanceAuditEvent,
  GovernancePrincipal,
  GovernanceQuotaDecision,
  GovernanceRegistryDecision,
  GovernanceRegistrySubject,
  GovernanceToolPolicyDecision,
  GovernanceToolSubject,
  WorkspaceRoleSummary,
} from './types.js';

const WORKSPACE_ROLES: WorkspaceRole[] = ['owner', 'admin', 'approver', 'operator', 'developer', 'viewer'];
const DEFAULT_APPROVER_ROLES: WorkspaceRole[] = ['owner', 'admin', 'approver'];
const DEFAULT_APPROVAL_TTL_SECONDS = 3600;

export class GovernanceRuntime {
  /**
   * Backend behind workspace quota counters. Defaults to in-memory sliding
   * window — fine for single-pod deployments, but becomes per-pod when the
   * gateway is replicated. In multi-pod K8s, a workspace effectively gets
   * `N × limit` requests/minute by hitting different pods. The fix: inject
   * a Redis-backed limiter (cf. audit Sprint 3 #5) so quotas are global.
   */
  private quotaLimiter: RateLimitBackend = new SlidingWindowLimiter();

  constructor(
    private readonly config: ConduitGatewayConfig,
    private readonly identityRuntime: IdentityRuntime,
    private readonly store: GovernanceStore | null,
  ) {}

  /**
   * Replace the in-memory quota backend with a distributed implementation
   * (typically `RedisLimiter`). The wiring lives in the gateway initializer
   * which already manages a Redis connection for rate limits.
   */
  setQuotaBackend(backend: RateLimitBackend): void {
    this.quotaLimiter = backend;
  }

  isEnabled(): boolean {
    return Boolean(this.config.governance?.enabled && this.store);
  }

  getConfig(): GovernanceConfig | undefined {
    return this.config.governance;
  }

  resolveWorkspace(principal: GovernancePrincipal): ResolvedWorkspace {
    return this.identityRuntime.resolveWorkspace(principal.tenant_id);
  }

  listRoleBindings(workspaceId?: string): Array<{ workspace_id: string; role: WorkspaceRole; clients: string[] }> {
    const bindings = this.config.governance?.role_bindings ?? [];
    return bindings
      .filter((binding) => !workspaceId || binding.workspace_id === workspaceId)
      .map((binding) => ({
        workspace_id: binding.workspace_id,
        role: binding.role,
        clients: [...binding.clients],
      }));
  }

  getRolesForClient(workspaceId: string, clientId: string): WorkspaceRole[] {
    const roles = new Set<WorkspaceRole>();
    const bindings = this.config.governance?.role_bindings ?? [];
    for (const binding of bindings) {
      if (binding.workspace_id !== workspaceId) continue;
      if (binding.clients.some((pattern) => matchesAnyPattern([pattern], clientId))) {
        roles.add(binding.role);
      }
    }
    return [...roles].sort((a, b) => WORKSPACE_ROLES.indexOf(a) - WORKSPACE_ROLES.indexOf(b));
  }

  getRoleSummary(workspaceId: string, clientId: string): WorkspaceRoleSummary {
    return {
      workspace_id: workspaceId,
      client_id: clientId,
      roles: this.getRolesForClient(workspaceId, clientId),
    };
  }

  evaluateToolPolicy(subject: GovernanceToolSubject): GovernanceToolPolicyDecision {
    const policies = this.config.governance?.tool_policies ?? [];
    for (const policy of policies) {
      if (!matchesToolPolicy(policy, subject)) {
        continue;
      }
      return {
        effect: policy.effect,
        policy_name: policy.name,
        reason: policy.reason ?? `Governance policy "${policy.name}" matched`,
        workspace: subject.workspace,
        roles: subject.roles,
      };
    }

    return {
      effect: 'allow',
      policy_name: '',
      reason: 'No governance tool policy matched',
      workspace: subject.workspace,
      roles: subject.roles,
    };
  }

  canViewTool(subject: GovernanceToolSubject): boolean {
    const decision = this.evaluateToolPolicy(subject);
    return decision.effect !== 'deny';
  }

  evaluateRegistryPolicy(subject: GovernanceRegistrySubject): GovernanceRegistryDecision {
    const policies = this.config.governance?.registry_policies ?? [];
    for (const policy of policies) {
      if (!matchesRegistryPolicy(policy, subject)) {
        continue;
      }
      return {
        allowed: policy.effect === 'allow',
        effect: policy.effect,
        policy_name: policy.name,
        reason: policy.reason ?? `Registry policy "${policy.name}" matched`,
        workspace_id: subject.workspace_id,
        roles: subject.roles,
      };
    }

    const defaultAllowed = (this.config.governance?.registry_default_action ?? 'allow') === 'allow';
    return {
      allowed: defaultAllowed,
      effect: defaultAllowed ? 'allow' : 'deny',
      policy_name: '',
      reason: 'No governance registry policy matched',
      workspace_id: subject.workspace_id,
      roles: subject.roles,
    };
  }

  async consumeWorkspaceQuota(
    workspaceId: string,
  ): Promise<GovernanceQuotaDecision> {
    const config = this.resolveWorkspaceQuotaConfig(workspaceId);
    if (!config) {
      return {
        allowed: true,
        workspace_id: workspaceId,
        remaining: Number.POSITIVE_INFINITY,
        limit: Number.POSITIVE_INFINITY,
        reset_at: Date.now() + 60_000,
      };
    }

    for (const check of buildQuotaChecks(`workspace:${workspaceId}`, config)) {
      const result = await Promise.resolve(this.quotaLimiter.consume(check.key, check.limit, check.window_ms));
      if (!result.allowed) {
        return {
          allowed: false,
          workspace_id: workspaceId,
          remaining: result.remaining,
          limit: check.limit,
          reset_at: result.reset_at,
          ...(result.retry_after !== undefined ? { retry_after: result.retry_after } : {}),
          blocked_by: check.label,
        };
      }
    }

    let remaining = Number.POSITIVE_INFINITY;
    let limit = Number.POSITIVE_INFINITY;
    let resetAt = Date.now() + 60_000;
    for (const check of buildQuotaChecks(`workspace:${workspaceId}`, config)) {
      const result = await Promise.resolve(this.quotaLimiter.check(check.key, check.limit, check.window_ms));
      if (result.remaining < remaining) {
        remaining = result.remaining;
        limit = check.limit;
        resetAt = result.reset_at;
      }
    }

    return {
      allowed: true,
      workspace_id: workspaceId,
      remaining,
      limit,
      reset_at: resetAt,
    };
  }

  async getWorkspaceQuota(workspaceId: string): Promise<{
    workspace_id: string;
    enabled: boolean;
    limits: { label: string; remaining: number; limit: number; reset_at: number }[];
  }> {
    const config = this.resolveWorkspaceQuotaConfig(workspaceId);
    if (!config) {
      return { workspace_id: workspaceId, enabled: false, limits: [] };
    }

    const limits = await Promise.all(
      buildQuotaChecks(`workspace:${workspaceId}`, config).map(async (check) => {
        const result = await Promise.resolve(this.quotaLimiter.check(check.key, check.limit, check.window_ms));
        return {
          label: check.label,
          remaining: result.remaining,
          limit: check.limit,
          reset_at: result.reset_at,
        };
      }),
    );

    return { workspace_id: workspaceId, enabled: true, limits };
  }

  createApprovalRequest(
    input: Omit<CreateGovernanceApprovalRequestInput, 'expires_at'>,
  ): GovernanceApprovalRequestSummary {
    if (!this.store) {
      throw new Error('Governance store is disabled');
    }

    const ttlSeconds = this.config.governance?.approvals?.ttl_seconds ?? DEFAULT_APPROVAL_TTL_SECONDS;
    const request = this.store.createOrReuseApprovalRequest({
      ...input,
      expires_at: new Date(Date.now() + (ttlSeconds * 1000)).toISOString(),
    });

    this.audit({
      workspace_id: input.workspace_id,
      actor_client_id: input.requester_client_id,
      action: 'approval_requested',
      resource_type: 'approval_request',
      resource_id: request.id,
      outcome: 'pending',
      details: {
        source: input.source,
        server_id: input.server_id,
        tool_name: input.tool_name,
        rule_name: input.rule_name,
      },
    });

    return request;
  }

  verifyApprovalGrant(
    approvalId: string,
    workspaceId: string,
    requesterClientId: string,
    serverId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): GovernanceApprovalRequestSummary | null {
    if (!this.store) return null;
    return this.store.verifyApprovalGrant({
      approval_id: approvalId,
      workspace_id: workspaceId,
      requester_client_id: requesterClientId,
      server_id: serverId,
      tool_name: toolName,
      request_fingerprint: buildRequestFingerprint(serverId, toolName, toolArgs),
    });
  }

  decideApproval(
    approvalId: string,
    approverClientId: string,
    decision: 'approved' | 'rejected',
    note?: string,
    options: {
      /**
       * Authenticated principal for the request, when the gateway has real
       * identity-aware auth (jwt / api-key) — not just admin.key. When set,
       * the body's `approverClientId` MUST match the authenticated client_id;
       * otherwise the call is rejected as impersonation. Without this guard,
       * any holder of the admin token could approve as anyone else.
       */
      authenticatedPrincipal?: { client_id: string; tenant_id: string };
    } = {},
  ): GovernanceApprovalDecision {
    if (!this.store) {
      throw new Error('Governance store is disabled');
    }

    const existing = this.store.getApprovalRequest(approvalId);
    if (!existing) {
      throw new Error(`Approval request "${approvalId}" not found`);
    }
    if (existing.status !== 'pending') {
      throw new Error(`Approval request "${approvalId}" is already ${existing.status}`);
    }

    if (
      options.authenticatedPrincipal &&
      options.authenticatedPrincipal.client_id !== approverClientId
    ) {
      throw new Error(
        `Approver impersonation: authenticated client "${options.authenticatedPrincipal.client_id}" ` +
        `cannot decide as "${approverClientId}"`,
      );
    }

    const requiredRoles = this.config.governance?.approvals?.required_roles ?? DEFAULT_APPROVER_ROLES;
    const approverRoles = this.getRolesForClient(existing.workspace_id, approverClientId);
    if (!requiredRoles.some((role) => approverRoles.includes(role))) {
      throw new Error(
        `Client "${approverClientId}" cannot decide approvals in workspace "${existing.workspace_id}"`,
      );
    }

    const allowSelfApproval = this.config.governance?.approvals?.allow_self_approval ?? false;
    if (!allowSelfApproval && existing.requester_client_id === approverClientId) {
      throw new Error('Self approval is not allowed');
    }

    const request = decision === 'approved'
      ? this.store.approveRequest(approvalId, approverClientId, note)
      : this.store.rejectRequest(approvalId, approverClientId, note);
    if (!request) {
      throw new Error(`Approval request "${approvalId}" could not be updated`);
    }

    this.audit({
      workspace_id: request.workspace_id,
      actor_client_id: approverClientId,
      action: decision === 'approved' ? 'approval_approved' : 'approval_rejected',
      resource_type: 'approval_request',
      resource_id: request.id,
      outcome: 'success',
      details: {
        requester_client_id: request.requester_client_id,
        server_id: request.server_id,
        tool_name: request.tool_name,
        note,
      },
    });

    return { request, required_roles: requiredRoles };
  }

  listApprovalRequests(filters?: Parameters<GovernanceStore['listApprovalRequests']>[0]): GovernanceApprovalRequestSummary[] {
    return this.store?.listApprovalRequests(filters) ?? [];
  }

  listAuditEvents(filters?: Parameters<GovernanceStore['listAuditEvents']>[0]): GovernanceAuditEvent[] {
    return this.store?.listAuditEvents(filters) ?? [];
  }

  audit(event: {
    workspace_id?: string;
    actor_client_id?: string;
    action: string;
    resource_type: string;
    resource_id?: string;
    outcome: 'success' | 'denied' | 'pending' | 'error';
    details?: Record<string, unknown>;
  }): GovernanceAuditEvent | null {
    if (!this.store) return null;
    return this.store.insertAuditEvent(event);
  }

  private resolveWorkspaceQuotaConfig(workspaceId: string): ToolRateLimitConfig | undefined {
    return pickQuotaConfig(workspaceId, this.getConfig());
  }
}

export function buildRequestFingerprint(
  serverId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(`${serverId}\n${toolName}\n${deterministicStringify(toolArgs as SortableValue)}`)
    .digest('hex');
}

function matchesToolPolicy(
  policy: GovernanceToolPolicyConfig,
  subject: GovernanceToolSubject,
): boolean {
  if (policy.workspace_ids?.length && !matchesAnyPattern(policy.workspace_ids, subject.workspace.id)) {
    return false;
  }
  if (policy.roles?.length && !policy.roles.some((role) => subject.roles.includes(role))) {
    return false;
  }
  if (policy.clients?.length && !matchesAnyPattern(policy.clients, subject.client_id)) {
    return false;
  }
  if (policy.servers?.length && !matchesAnyPattern(policy.servers, subject.server_id)) {
    return false;
  }
  if (policy.tools?.length && !matchesAnyPattern(policy.tools, subject.tool_name)) {
    return false;
  }
  return true;
}

function matchesRegistryPolicy(
  policy: GovernanceRegistryPolicyConfig,
  subject: GovernanceRegistrySubject,
): boolean {
  if (policy.workspace_ids?.length && !matchesAnyPattern(policy.workspace_ids, subject.workspace_id)) {
    return false;
  }
  if (policy.roles?.length && !policy.roles.some((role) => subject.roles.includes(role))) {
    return false;
  }
  if (policy.clients?.length) {
    if (!subject.client_id || !matchesAnyPattern(policy.clients, subject.client_id)) {
      return false;
    }
  }
  if (policy.server_names?.length && !matchesAnyPattern(policy.server_names, subject.server_name)) {
    return false;
  }
  if (policy.package_types?.length) {
    const wanted = new Set(policy.package_types.map((value) => value.toLowerCase()));
    if (!subject.package_types.some((value) => wanted.has(value.toLowerCase()))) {
      return false;
    }
  }
  if (policy.install_modes?.length) {
    if (!subject.install_mode || !policy.install_modes.includes(subject.install_mode)) {
      return false;
    }
  }
  return true;
}

function buildQuotaChecks(key: string, config: ToolRateLimitConfig): Array<{
  key: string;
  limit: number;
  window_ms: number;
  label: string;
}> {
  const checks: Array<{ key: string; limit: number; window_ms: number; label: string }> = [];
  if (config.requests_per_minute !== undefined) {
    checks.push({ key, limit: config.requests_per_minute, window_ms: 60_000, label: 'workspace/minute' });
  }
  if (config.requests_per_hour !== undefined) {
    checks.push({ key, limit: config.requests_per_hour, window_ms: 3_600_000, label: 'workspace/hour' });
  }
  if (config.requests_per_day !== undefined) {
    checks.push({ key, limit: config.requests_per_day, window_ms: 86_400_000, label: 'workspace/day' });
  }
  return checks;
}

function pickQuotaConfig(
  workspaceId: string,
  governance: GovernanceConfig | undefined,
): ToolRateLimitConfig | undefined {
  const workspaceSpecific = governance?.quotas?.workspaces?.find((item) => item.workspace_id === workspaceId);
  if (workspaceSpecific) {
    return {
      ...(workspaceSpecific.requests_per_minute !== undefined ? { requests_per_minute: workspaceSpecific.requests_per_minute } : {}),
      ...(workspaceSpecific.requests_per_hour !== undefined ? { requests_per_hour: workspaceSpecific.requests_per_hour } : {}),
      ...(workspaceSpecific.requests_per_day !== undefined ? { requests_per_day: workspaceSpecific.requests_per_day } : {}),
    };
  }
  return governance?.quotas?.default;
}
