import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import {
  setup,
  teardown,
  sendMcpRequestJson,
  makeToolCallMessage,
  type E2eTestContext,
} from './setup.js';

type JsonRpcResponse = {
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
};

async function adminRequest(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  return app.request(`/conduit${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Conduit-Admin': 'true',
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('Governance plane', () => {
  let ctx: E2eTestContext;
  let registryServer: Server;
  let registryBaseUrl = '';

  const auth: ConduitGatewayConfig['auth'] = {
    method: 'api-key',
    api_keys: [
      { key: 'sk-developer', client_id: 'developer-1', tenant_id: 'tenant-a' },
      { key: 'sk-approver', client_id: 'approver-1', tenant_id: 'tenant-a' },
      { key: 'sk-self', client_id: 'self-1', tenant_id: 'tenant-a' },
    ],
  };

  const identity: ConduitGatewayConfig['identity'] = {
    enabled: true,
    db_path: ':memory:',
    default_workspace_id: 'default',
    workspaces: [
      { id: 'workspace-a', tenant_ids: ['tenant-a'] },
    ],
  };

  beforeAll(async () => {
    registryServer = createServer((req, res) => {
      if (!req.url?.startsWith('/v0.1/servers')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        servers: [
          {
            server: {
              name: 'io.github.example/blocked-remote',
              title: 'Blocked Remote',
              description: 'Blocked by governance',
              version: '1.0.0',
              remotes: [{ type: 'streamable-http', url: 'http://127.0.0.1:65531/mcp' }],
            },
            _meta: {
              'io.modelcontextprotocol.registry/official': {
                status: 'active',
                isLatest: true,
                publishedAt: '2026-04-01T00:00:00.000Z',
                updatedAt: '2026-04-10T00:00:00.000Z',
              },
            },
          },
        ],
        metadata: { count: 1 },
      }));
    });

    await new Promise<void>((resolve) => {
      registryServer.listen(0, '127.0.0.1', () => {
        const address = registryServer.address();
        if (address && typeof address !== 'string') {
          registryBaseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => registryServer.close((error) => error ? reject(error) : resolve()));
  });

  beforeEach(async () => {
    ctx = await setup({
      auth,
      identity,
      connect: {
        registry: {
          base_url: registryBaseUrl,
          cache_ttl_seconds: 3600,
          page_size: 100,
          max_pages: 1,
          latest_only: true,
        },
      },
      governance: {
        enabled: true,
        db_path: ':memory:',
        registry_default_action: 'allow',
        role_bindings: [
          { workspace_id: 'workspace-a', role: 'developer', clients: ['developer-1'] },
          { workspace_id: 'workspace-a', role: 'approver', clients: ['approver-1'] },
          { workspace_id: 'workspace-a', role: 'developer', clients: ['self-1'] },
          { workspace_id: 'workspace-a', role: 'approver', clients: ['self-1'] },
        ],
        tool_policies: [
          {
            name: 'deny-delete-contact',
            workspace_ids: ['workspace-a'],
            roles: ['developer'],
            servers: ['test-server'],
            tools: ['delete_contact'],
            effect: 'deny',
            reason: 'Deletion is blocked by workspace governance',
          },
          {
            name: 'approve-create-contact',
            workspace_ids: ['workspace-a'],
            roles: ['developer'],
            servers: ['test-server'],
            tools: ['create_contact'],
            effect: 'require_approval',
            reason: 'Create contact requires approval',
          },
        ],
        registry_policies: [
          {
            name: 'deny-blocked-registry',
            workspace_ids: ['workspace-a'],
            server_names: ['io.github.example/blocked-*'],
            effect: 'deny',
            reason: 'Registry entry is blocked for this workspace',
          },
        ],
        quotas: {
          workspaces: [
            { workspace_id: 'workspace-a', requests_per_minute: 10 },
          ],
        },
        approvals: {
          enabled: true,
          ttl_seconds: 3600,
          required_roles: ['owner', 'admin', 'approver'],
          allow_self_approval: false,
        },
      },
    });
  });

  afterEach(async () => {
    await teardown(ctx);
  });

  it('resolves RBAC roles and blocks denied tools', async () => {
    const rolesRes = await adminRequest(
      ctx.app,
      'GET',
      '/governance/roles?workspace_id=workspace-a&client_id=developer-1',
    );
    expect(rolesRes.status).toBe(200);
    const rolesBody = await rolesRes.json() as {
      resolved?: { roles: string[] };
    };
    expect(rolesBody.resolved?.roles).toContain('developer');

    const body = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('delete_contact', { id: '123' }),
      { Authorization: 'Bearer sk-developer' },
    );
    expect(body.error?.code).toBe(-32010);
    expect(body.error?.message).toContain('workspace governance');
    expect(body.error?.data?.['workspace_id']).toBe('workspace-a');
    expect(body.error?.data?.['policy_name']).toBe('deny-delete-contact');

    const auditRes = await adminRequest(ctx.app, 'GET', '/governance/audit?action=tool_policy_denied');
    expect(auditRes.status).toBe(200);
    const auditBody = await auditRes.json() as {
      events: Array<{ action: string; resource_id: string; outcome: string }>;
    };
    expect(auditBody.events.some((event) => event.action === 'tool_policy_denied' && event.resource_id === 'test-server:delete_contact' && event.outcome === 'denied')).toBe(true);
  });

  it('queues approvals, enforces approver roles, and unlocks approved calls', async () => {
    const firstAttempt = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('create_contact', { name: 'Alice' }),
      { Authorization: 'Bearer sk-developer' },
    );
    expect(firstAttempt.error?.code).toBe(-32011);
    expect(firstAttempt.error?.message).toContain('requires approval');

    const approvalId = String(firstAttempt.error?.data?.['approval_request_id'] ?? '');
    expect(approvalId).toBeTruthy();
    expect(firstAttempt.error?.data?.['approval_header']).toBe('X-Conduit-Approval-Id');

    const approvalsRes = await adminRequest(ctx.app, 'GET', '/governance/approvals?status=pending');
    expect(approvalsRes.status).toBe(200);
    const approvalsBody = await approvalsRes.json() as {
      approvals: Array<{ id: string; status: string; tool_name: string }>;
    };
    expect(approvalsBody.approvals.some((approval) => approval.id === approvalId && approval.status === 'pending' && approval.tool_name === 'create_contact')).toBe(true);

    const deniedSelfApprovalRes = await adminRequest(
      ctx.app,
      'POST',
      `/governance/approvals/${approvalId}/approve`,
      { approver_client_id: 'developer-1', note: 'Trying without approver role' },
      // The approver impersonation guard requires the authenticated principal
      // to match approver_client_id; presenting developer-1's key here proves
      // the body claim — but governance still refuses because developer-1
      // lacks the approver role.
      { Authorization: 'Bearer sk-developer' },
    );
    expect(deniedSelfApprovalRes.status).toBe(400);
    const deniedSelfApproval = await deniedSelfApprovalRes.json() as { error?: string };
    expect(deniedSelfApproval.error).toContain('cannot decide approvals');

    const approveRes = await adminRequest(
      ctx.app,
      'POST',
      `/governance/approvals/${approvalId}/approve`,
      { approver_client_id: 'approver-1', note: 'Looks good' },
      { Authorization: 'Bearer sk-approver' },
    );
    expect(approveRes.status).toBe(200);
    const approveBody = await approveRes.json() as {
      request: { id: string; status: string; approver_client_id?: string };
      required_roles: string[];
    };
    expect(approveBody.request.id).toBe(approvalId);
    expect(approveBody.request.status).toBe('approved');
    expect(approveBody.request.approver_client_id).toBe('approver-1');
    expect(approveBody.required_roles).toContain('approver');

    const approvedAttempt = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('create_contact', { name: 'Alice' }),
      {
        Authorization: 'Bearer sk-developer',
        'X-Conduit-Approval-Id': approvalId,
      },
    );
    expect(approvedAttempt.error).toBeUndefined();
    expect(approvedAttempt.result).toBeDefined();

    const auditRes = await adminRequest(ctx.app, 'GET', '/governance/audit');
    const auditBody = await auditRes.json() as {
      events: Array<{ action: string; outcome: string }>;
    };
    expect(auditBody.events.some((event) => event.action === 'approval_requested' && event.outcome === 'pending')).toBe(true);
    expect(auditBody.events.some((event) => event.action === 'approval_approved' && event.outcome === 'success')).toBe(true);
  });

  it('rejects self approval when the requester also has approver rights', async () => {
    const firstAttempt = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('create_contact', { name: 'Self user' }),
      { Authorization: 'Bearer sk-self' },
    );
    const approvalId = String(firstAttempt.error?.data?.['approval_request_id'] ?? '');
    expect(firstAttempt.error?.code).toBe(-32011);
    expect(approvalId).toBeTruthy();

    const selfApproveRes = await adminRequest(
      ctx.app,
      'POST',
      `/governance/approvals/${approvalId}/approve`,
      { approver_client_id: 'self-1' },
      { Authorization: 'Bearer sk-self' },
    );
    expect(selfApproveRes.status).toBe(400);
    const selfApproveBody = await selfApproveRes.json() as { error?: string };
    expect(selfApproveBody.error).toContain('Self approval is not allowed');
  });

  // ── Audit Sprint 3 #2 — approver impersonation ───────────────────────────
  it('rejects approver impersonation when authenticated principal mismatches body', async () => {
    const firstAttempt = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('create_contact', { name: 'Impersonation target' }),
      { Authorization: 'Bearer sk-developer' },
    );
    const approvalId = String(firstAttempt.error?.data?.['approval_request_id'] ?? '');
    expect(approvalId).toBeTruthy();

    // developer-1 presents their own bearer but tries to claim approver-1's
    // identity in the body. Pre-fix: governance only checked the body's role
    // and approved (the developer is in the approver's workspace). Post-fix:
    // the runtime refuses because the authenticated principal does not match.
    const impersonationRes = await adminRequest(
      ctx.app,
      'POST',
      `/governance/approvals/${approvalId}/approve`,
      { approver_client_id: 'approver-1', note: 'Sneaky' },
      { Authorization: 'Bearer sk-developer' },
    );
    expect(impersonationRes.status).toBe(400);
    const body = await impersonationRes.json() as { error?: string };
    expect(body.error).toMatch(/[Ii]mpersonation/);
  });

  it('rejects approval calls without an authenticated principal when auth is configured', async () => {
    const firstAttempt = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('create_contact', { name: 'No-auth' }),
      { Authorization: 'Bearer sk-developer' },
    );
    const approvalId = String(firstAttempt.error?.data?.['approval_request_id'] ?? '');
    expect(approvalId).toBeTruthy();

    // No Authorization header at all — the gateway's admin key lets the
    // request through, but the impersonation guard demands a real identity.
    const noAuthRes = await adminRequest(
      ctx.app,
      'POST',
      `/governance/approvals/${approvalId}/approve`,
      { approver_client_id: 'approver-1' },
    );
    expect(noAuthRes.status).toBe(401);
    const body = await noAuthRes.json() as { error?: string };
    expect(body.error).toBeTruthy();
  });

  it('enforces workspace quotas and exposes remaining quota state', async () => {
    await teardown(ctx);
    ctx = await setup({
      auth,
      identity,
      governance: {
        enabled: true,
        db_path: ':memory:',
        role_bindings: [
          { workspace_id: 'workspace-a', role: 'developer', clients: ['developer-1'] },
        ],
        quotas: {
          workspaces: [
            { workspace_id: 'workspace-a', requests_per_minute: 1 },
          ],
        },
      },
    });

    const firstCall = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '1' }),
      { Authorization: 'Bearer sk-developer' },
    );
    expect(firstCall.error).toBeUndefined();

    const secondCall = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: '2' }),
      { Authorization: 'Bearer sk-developer' },
    );
    expect(secondCall.error?.code).toBe(-32012);
    expect(secondCall.error?.message).toContain('Workspace quota exceeded');
    expect(Number(secondCall.error?.data?.['retry_after'] ?? 0)).toBeGreaterThan(0);

    const quotaRes = await adminRequest(ctx.app, 'GET', '/governance/quotas/workspace/workspace-a');
    expect(quotaRes.status).toBe(200);
    const quotaBody = await quotaRes.json() as {
      enabled: boolean;
      limits: Array<{ label: string; limit: number; remaining: number }>;
    };
    expect(quotaBody.enabled).toBe(true);
    expect(quotaBody.limits.some((limit) => limit.label === 'workspace/minute' && limit.limit === 1)).toBe(true);

    const auditRes = await adminRequest(ctx.app, 'GET', '/governance/audit?action=workspace_quota_blocked');
    const auditBody = await auditRes.json() as {
      events: Array<{ action: string; outcome: string }>;
    };
    expect(auditBody.events.some((event) => event.action === 'workspace_quota_blocked' && event.outcome === 'denied')).toBe(true);
  });

  it('blocks registry imports by workspace policy and records the denial', async () => {
    const res = await adminRequest(ctx.app, 'POST', '/connect/registry/import', {
      server_name: 'io.github.example/blocked-remote',
      profile_id: 'workspace-a-blocked',
      client_id: 'developer-1',
      tenant_id: 'tenant-a',
    });
    expect(res.status).toBe(403);
    const body = await res.json() as {
      error?: string;
      governance?: {
        workspace_id: string;
        decision: { allowed: boolean; policy_name: string };
      };
    };
    expect(body.error).toContain('blocked');
    expect(body.governance?.workspace_id).toBe('workspace-a');
    expect(body.governance?.decision.allowed).toBe(false);
    expect(body.governance?.decision.policy_name).toBe('deny-blocked-registry');

    const auditRes = await adminRequest(ctx.app, 'GET', '/governance/audit?action=registry_import_denied');
    expect(auditRes.status).toBe(200);
    const auditBody = await auditRes.json() as {
      events: Array<{ action: string; resource_id: string; outcome: string }>;
    };
    expect(auditBody.events.some((event) => event.action === 'registry_import_denied' && event.resource_id === 'io.github.example/blocked-remote' && event.outcome === 'denied')).toBe(true);
  });
});
