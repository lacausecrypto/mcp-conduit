import type { ConduitGatewayConfig, ServerConfig } from '../config/types.js';
import type { IdentityStore } from './store.js';
import type {
  AuthenticatedPrincipal,
  ConnectedAccountBinding,
  ConnectedAccountSummary,
  ConnectionTemplateSummary,
  ProfileIdentityPreflight,
  ResolvedConnectedAccount,
  ResolvedUpstreamAuth,
  ResolvedWorkspace,
  ServerIdentityPreflight,
} from './types.js';

const DEFAULT_CLAIMS_HEADER = 'X-Conduit-Identity';
const DEFAULT_SHARED_BINDING: ConnectedAccountBinding = 'client-or-workspace';

export class UpstreamIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamIdentityError';
  }
}

export class IdentityRuntime {
  constructor(
    private readonly config: ConduitGatewayConfig,
    private readonly store: IdentityStore | null,
  ) {}

  isEnabled(): boolean {
    return Boolean(this.config.identity?.enabled && this.store);
  }

  resolveWorkspace(tenantId: string): ResolvedWorkspace {
    const identity = this.config.identity;
    const workspaces = identity?.workspaces ?? [];

    for (const workspace of workspaces) {
      if (workspace.tenant_ids?.includes(tenantId)) {
        return {
          id: workspace.id,
          label: workspace.label ?? workspace.id,
          source: 'mapping',
          tenant_ids: [...workspace.tenant_ids],
        };
      }
    }

    if (identity?.default_workspace_id) {
      return {
        id: identity.default_workspace_id,
        label: identity.default_workspace_id,
        source: 'default',
        tenant_ids: [],
      };
    }

    return {
      id: tenantId || 'default',
      label: tenantId || 'default',
      source: 'tenant',
      tenant_ids: tenantId ? [tenantId] : [],
    };
  }

  listWorkspaces(): Array<ResolvedWorkspace & { account_count: number }> {
    const configured = this.config.identity?.workspaces ?? [];
    const accounts = this.store?.listConnectedAccounts() ?? [];
    const counts = new Map<string, number>();
    for (const account of accounts) {
      counts.set(account.workspace_id, (counts.get(account.workspace_id) ?? 0) + 1);
    }

    const resolved: Array<ResolvedWorkspace & { account_count: number }> = configured.map((workspace) => ({
      id: workspace.id,
      label: workspace.label ?? workspace.id,
      source: 'mapping' as const,
      tenant_ids: workspace.tenant_ids ?? [],
      account_count: counts.get(workspace.id) ?? 0,
    }));

    const defaultWorkspaceId = this.config.identity?.default_workspace_id;
    if (defaultWorkspaceId && !resolved.some((workspace) => workspace.id === defaultWorkspaceId)) {
      resolved.push({
        id: defaultWorkspaceId,
        label: defaultWorkspaceId,
        source: 'default',
        tenant_ids: [],
        account_count: counts.get(defaultWorkspaceId) ?? 0,
      });
    }

    return resolved.sort((a, b) => a.id.localeCompare(b.id));
  }

  listConnectionTemplates(): ConnectionTemplateSummary[] {
    return this.config.servers
      .filter((server) => Boolean(server.upstream_auth?.connected_account))
      .map((server) => {
        const template = server.upstream_auth!.connected_account!;
        return {
          server_id: server.id,
          transport: server.transport ?? 'http',
          provider: template.provider,
          binding: template.binding ?? DEFAULT_SHARED_BINDING,
          required: template.required !== false,
          header_templates: template.headers ?? { Authorization: '{{token_type}} {{access_token}}' },
          forward_identity_mode: server.upstream_auth?.forward_identity?.mode ?? 'none',
        };
      });
  }

  getServerPreflight(
    server: ServerConfig,
    principal?: AuthenticatedPrincipal,
  ): ServerIdentityPreflight {
    const transport = server.transport ?? 'http';
    const forwardIdentityMode = server.upstream_auth?.forward_identity?.mode ?? 'none';
    const requirement = server.upstream_auth?.connected_account;

    if (!requirement) {
      return {
        server_id: server.id,
        transport,
        status: 'none',
        ready: true,
        blocking: false,
        forward_identity_mode: forwardIdentityMode,
      };
    }

    const binding = requirement.binding ?? DEFAULT_SHARED_BINDING;
    const required = requirement.required !== false;

    if (transport !== 'http') {
      return {
        server_id: server.id,
        transport,
        status: 'unsupported-transport',
        ready: !required,
        blocking: required,
        forward_identity_mode: forwardIdentityMode,
        connected_account: {
          provider: requirement.provider,
          binding,
          required,
          resolved: false,
          status: 'unsupported-transport',
          message: `Server "${server.id}" uses ${transport} transport and cannot resolve per-request connected accounts`,
        },
      };
    }

    if (!this.isEnabled()) {
      return {
        server_id: server.id,
        transport,
        status: 'identity-disabled',
        ready: !required,
        blocking: required,
        forward_identity_mode: forwardIdentityMode,
        connected_account: {
          provider: requirement.provider,
          binding,
          required,
          resolved: false,
          status: 'identity-disabled',
          message: `Identity plane is disabled but server "${server.id}" requires provider "${requirement.provider}"`,
        },
      };
    }

    if (!principal) {
      return {
        server_id: server.id,
        transport,
        status: 'principal-required',
        ready: !required,
        blocking: required,
        forward_identity_mode: forwardIdentityMode,
        connected_account: {
          provider: requirement.provider,
          binding,
          required,
          resolved: false,
          status: 'principal-required',
          message: `Resolve server "${server.id}" with client_id and tenant_id to check provider "${requirement.provider}"`,
        },
      };
    }

    const workspace = this.resolveWorkspace(principal.tenant_id);
    const account = this.store!.resolveConnectedAccount({
      workspace_id: workspace.id,
      provider: requirement.provider,
      client_id: principal.client_id,
      tenant_id: principal.tenant_id,
      binding,
    });

    if (!account) {
      const status = required ? 'missing-connected-account' : 'optional-unresolved';
      return {
        server_id: server.id,
        transport,
        status,
        ready: !required,
        blocking: required,
        forward_identity_mode: forwardIdentityMode,
        workspace,
        connected_account: {
          provider: requirement.provider,
          binding,
          required,
          resolved: false,
          status,
          message: required
            ? `No connected account for provider "${requirement.provider}" in workspace "${workspace.id}"`
            : `No connected account for optional provider "${requirement.provider}" in workspace "${workspace.id}"`,
        },
      };
    }

    return {
      server_id: server.id,
      transport,
      status: 'ready',
      ready: true,
      blocking: false,
      forward_identity_mode: forwardIdentityMode,
      workspace,
      connected_account: {
        provider: requirement.provider,
        binding,
        required,
        resolved: true,
        status: 'ready',
        message: `Connected account "${account.id}" resolved for provider "${requirement.provider}"`,
        account: toPublicAccount(account),
      },
    };
  }

  getProfilePreflight(
    profileId: string,
    profileLabel: string,
    servers: ServerConfig[],
    principal?: AuthenticatedPrincipal,
  ): ProfileIdentityPreflight {
    const serverRequirements = servers.map((server) => this.getServerPreflight(server, principal));
    return {
      profile_id: profileId,
      profile_label: profileLabel,
      ready: serverRequirements.every((requirement) => !requirement.blocking),
      blocking_count: serverRequirements.filter((requirement) => requirement.blocking).length,
      ...(principal ? { workspace: this.resolveWorkspace(principal.tenant_id) } : {}),
      server_requirements: serverRequirements,
    };
  }

  resolveUpstreamHeaders(
    server: ServerConfig,
    principal: AuthenticatedPrincipal,
  ): ResolvedUpstreamAuth {
    const workspace = this.resolveWorkspace(principal.tenant_id);
    const headers: Record<string, string> = {};
    const serverAuth = server.upstream_auth;

    if (serverAuth?.forward_identity?.mode === 'bearer' && principal.auth_header) {
      headers['Authorization'] = principal.auth_header;
    }

    if (serverAuth?.forward_identity?.mode === 'claims-header') {
      const headerName = serverAuth.forward_identity.header_name?.trim() || DEFAULT_CLAIMS_HEADER;
      const payload = {
        client_id: principal.client_id,
        tenant_id: principal.tenant_id,
        workspace_id: workspace.id,
        ...(principal.claims ? { claims: principal.claims } : {}),
      };
      headers[headerName] = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
    }

    const account = this.resolveConnectedAccount(server, principal, workspace);
    if (account) {
      const headerTemplates = serverAuth?.connected_account?.headers ?? { Authorization: '{{token_type}} {{access_token}}' };
      const values = buildTemplateValues(principal, workspace, account);
      for (const [headerName, template] of Object.entries(headerTemplates)) {
        headers[headerName] = interpolateTemplate(template, values);
      }
    }

    return {
      workspace,
      headers,
      ...(account ? { connected_account: toPublicAccount(account) } : {}),
    };
  }

  private resolveConnectedAccount(
    server: ServerConfig,
    principal: AuthenticatedPrincipal,
    workspace: ResolvedWorkspace,
  ): ResolvedConnectedAccount | null {
    const requirement = server.upstream_auth?.connected_account;
    if (!requirement) return null;

    if ((server.transport ?? 'http') !== 'http') {
      throw new UpstreamIdentityError(
        `Server "${server.id}" uses ${server.transport ?? 'http'} transport and cannot resolve per-request connected accounts`,
      );
    }

    if (!this.isEnabled()) {
      throw new UpstreamIdentityError(
        `Identity plane is disabled but server "${server.id}" requires provider "${requirement.provider}"`,
      );
    }

    const account = this.store!.resolveConnectedAccount({
      workspace_id: workspace.id,
      provider: requirement.provider,
      client_id: principal.client_id,
      tenant_id: principal.tenant_id,
      binding: requirement.binding ?? DEFAULT_SHARED_BINDING,
    });

    if (!account && requirement.required !== false) {
      throw new UpstreamIdentityError(
        `No connected account for provider "${requirement.provider}" in workspace "${workspace.id}"`,
      );
    }

    return account;
  }
}

function buildTemplateValues(
  principal: AuthenticatedPrincipal,
  workspace: ResolvedWorkspace,
  account: ResolvedConnectedAccount,
): Record<string, string> {
  return {
    access_token: account.access_token,
    token_type: account.token_type,
    account_id: account.id,
    workspace_id: workspace.id,
    tenant_id: principal.tenant_id,
    client_id: principal.client_id,
    provider: account.provider,
    ...(account.refresh_token ? { refresh_token: account.refresh_token } : {}),
  };
}

function interpolateTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_full, key: string) => values[key] ?? '');
}

function toPublicAccount(account: ResolvedConnectedAccount): ConnectedAccountSummary {
  const { access_token: _accessToken, refresh_token: _refreshToken, ...publicAccount } = account;
  return publicAccount;
}
