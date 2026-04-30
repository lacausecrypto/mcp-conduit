import type {
  ConnectedAccountBinding,
  IdentityConfig,
  ServerConfig,
} from '../config/types.js';

export type { ConnectedAccountBinding, IdentityConfig };

export interface IdentitySecretRef {
  backend: 'sqlite';
  secret_id: string;
}

export interface ConnectedAccountSummary {
  id: string;
  workspace_id: string;
  provider: string;
  client_id?: string;
  tenant_id?: string;
  label?: string;
  auth_type: 'bearer';
  token_type: string;
  access_token_ref: IdentitySecretRef;
  refresh_token_ref?: IdentitySecretRef;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  revoked_at?: string;
}

export interface ResolvedConnectedAccount extends ConnectedAccountSummary {
  access_token: string;
  refresh_token?: string;
}

export interface CreateConnectedAccountInput {
  workspace_id: string;
  provider: string;
  client_id?: string;
  tenant_id?: string;
  label?: string;
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  metadata?: Record<string, unknown>;
  replace_existing?: boolean;
}

export interface ConnectedAccountFilters {
  workspace_id?: string;
  provider?: string;
  client_id?: string;
  tenant_id?: string;
  include_revoked?: boolean;
}

export interface ResolveConnectedAccountQuery {
  workspace_id: string;
  provider: string;
  client_id: string;
  tenant_id: string;
  binding: ConnectedAccountBinding;
}

export interface ResolvedWorkspace {
  id: string;
  label: string;
  source: 'mapping' | 'default' | 'tenant';
  tenant_ids: string[];
}

export interface AuthenticatedPrincipal {
  client_id: string;
  tenant_id: string;
  auth_header?: string;
  claims?: Record<string, unknown>;
}

export interface ResolvedUpstreamAuth {
  workspace: ResolvedWorkspace;
  headers: Record<string, string>;
  connected_account?: ConnectedAccountSummary;
}

export interface ConnectionTemplateSummary {
  server_id: string;
  transport: ServerConfig['transport'] | 'http';
  provider: string;
  binding: ConnectedAccountBinding;
  required: boolean;
  header_templates: Record<string, string>;
  forward_identity_mode: 'none' | 'bearer' | 'claims-header';
}

export type IdentityPreflightStatus =
  | 'none'
  | 'ready'
  | 'optional-unresolved'
  | 'missing-connected-account'
  | 'identity-disabled'
  | 'principal-required'
  | 'unsupported-transport';

export interface ConnectedAccountRequirementSummary {
  provider: string;
  binding: ConnectedAccountBinding;
  required: boolean;
  resolved: boolean;
  status: Exclude<IdentityPreflightStatus, 'none'>;
  message: string;
  account?: ConnectedAccountSummary;
}

export interface ServerIdentityPreflight {
  server_id: string;
  transport: ServerConfig['transport'] | 'http';
  status: IdentityPreflightStatus;
  ready: boolean;
  blocking: boolean;
  forward_identity_mode: 'none' | 'bearer' | 'claims-header';
  workspace?: ResolvedWorkspace;
  connected_account?: ConnectedAccountRequirementSummary;
}

export interface ProfileIdentityPreflight {
  profile_id: string;
  profile_label: string;
  ready: boolean;
  blocking_count: number;
  workspace?: ResolvedWorkspace;
  server_requirements: ServerIdentityPreflight[];
}
