import type {
  GovernanceApprovalsConfig,
  GovernanceConfig,
  GovernanceRegistryPolicyConfig,
  GovernanceToolPolicyConfig,
  WorkspaceRole,
} from '../config/types.js';
import type { ResolvedWorkspace } from '../identity/types.js';

export type { GovernanceApprovalsConfig, GovernanceConfig, GovernanceRegistryPolicyConfig, GovernanceToolPolicyConfig, WorkspaceRole };

export interface GovernancePrincipal {
  client_id: string;
  tenant_id: string;
}

export interface WorkspaceRoleSummary {
  workspace_id: string;
  client_id: string;
  roles: WorkspaceRole[];
}

export interface GovernanceToolPolicyDecision {
  effect: 'allow' | 'deny' | 'require_approval';
  policy_name: string;
  reason: string;
  workspace: ResolvedWorkspace;
  roles: WorkspaceRole[];
}

export interface GovernanceRegistryDecision {
  allowed: boolean;
  effect: 'allow' | 'deny';
  policy_name: string;
  reason: string;
  workspace_id: string;
  roles: WorkspaceRole[];
}

export interface GovernanceQuotaDecision {
  allowed: boolean;
  workspace_id: string;
  remaining: number;
  limit: number;
  reset_at: number;
  retry_after?: number;
  blocked_by?: string;
}

export interface GovernanceApprovalRequestSummary {
  id: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  source: 'guardrail' | 'governance';
  workspace_id: string;
  requester_client_id: string;
  approver_client_id?: string;
  server_id: string;
  tool_name: string;
  rule_name?: string;
  reason: string;
  trace_id?: string;
  request_fingerprint: string;
  tool_args?: Record<string, unknown>;
  note?: string;
}

export interface CreateGovernanceApprovalRequestInput {
  source: 'guardrail' | 'governance';
  workspace_id: string;
  requester_client_id: string;
  server_id: string;
  tool_name: string;
  rule_name?: string;
  reason: string;
  trace_id?: string;
  request_fingerprint: string;
  tool_args: Record<string, unknown>;
  expires_at: string;
}

export interface ListGovernanceApprovalFilters {
  workspace_id?: string;
  status?: GovernanceApprovalRequestSummary['status'];
  requester_client_id?: string;
  approver_client_id?: string;
  source?: GovernanceApprovalRequestSummary['source'];
  limit?: number;
  offset?: number;
}

export interface GovernanceApprovalDecision {
  request: GovernanceApprovalRequestSummary;
  required_roles: WorkspaceRole[];
}

export interface GovernanceAuditEvent {
  id: number;
  timestamp: string;
  workspace_id?: string;
  actor_client_id?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  outcome: 'success' | 'denied' | 'pending' | 'error';
  details?: Record<string, unknown>;
}

export interface CreateGovernanceAuditEventInput {
  workspace_id?: string;
  actor_client_id?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  outcome: 'success' | 'denied' | 'pending' | 'error';
  details?: Record<string, unknown>;
}

export interface GovernanceApprovalGrantQuery {
  approval_id: string;
  workspace_id: string;
  requester_client_id: string;
  server_id: string;
  tool_name: string;
  request_fingerprint: string;
}

export interface GovernanceRegistrySubject {
  workspace_id: string;
  client_id?: string;
  roles: WorkspaceRole[];
  server_name: string;
  package_types: string[];
  install_mode?: string;
}

export interface GovernanceToolSubject {
  workspace: ResolvedWorkspace;
  client_id: string;
  roles: WorkspaceRole[];
  server_id: string;
  tool_name: string;
}
