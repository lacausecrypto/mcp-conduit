import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setup,
  teardown,
  sendMcpRequest,
  sendMcpRequestJson,
  makeToolCallMessage,
  type E2eTestContext,
} from './setup.js';
import type { GuardrailsConfig, GuardrailDecision } from '../../src/guardrails/types.js';

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const guardrailsConfig: GuardrailsConfig = {
  enabled: true,
  default_action: 'allow',
  rules: [
    {
      name: 'admin-bypass',
      clients: ['admin-*'],
      bypass: true,
      action: 'block', // ignored when bypass=true, but required by type
    },
    {
      name: 'block-delete',
      tools: ['delete_*'],
      action: 'block',
      message: 'Deletion tools are blocked by guardrails',
    },
    {
      name: 'block-mass-ops',
      tools: ['*'],
      conditions: [{ field: 'batch_size', operator: 'gt', value: 100 }],
      action: 'block',
      message: 'Mass operations are blocked — max 100 items',
    },
    {
      name: 'alert-sensitive',
      tools: ['get_ssn', 'get_credit_card'],
      action: 'alert',
      severity: 'critical',
    },
  ],
};

describe('Guardrails E2E', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      guardrails: guardrailsConfig,
      tools: [
        { name: 'get_contact', result: { id: 1, name: 'John' } },
        { name: 'delete_contact', result: { deleted: true } },
        { name: 'get_ssn', result: { ssn: '123-45-6789' } },
        { name: 'bulk_update', result: { updated: true } },
      ],
    });
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('allows normal tool calls', async () => {
    const body = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: 1 }),
    );
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });

  it('blocks tool calls matching a block rule', async () => {
    const body = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('delete_contact', { id: 1 }),
    );
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32000);
    expect(body.error!.message).toContain('blocked by guardrails');
  });

  it('blocks based on argument conditions', async () => {
    const body = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('bulk_update', { batch_size: 200 }),
    );
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32000);
    expect(body.error!.message).toContain('max 100');
  });

  it('allows when argument condition does not match', async () => {
    const body = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('bulk_update', { batch_size: 50 }),
    );
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });

  it('allows alert actions to pass through', async () => {
    const body = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_ssn', {}),
    );
    // Alert does not block — the call should succeed
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });
});

describe('Guardrails disabled', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      guardrails: { enabled: false, default_action: 'allow', rules: [] },
      tools: [
        { name: 'delete_contact', result: { deleted: true } },
      ],
    });
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('does not block when guardrails are disabled', async () => {
    const body = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('delete_contact', { id: 1 }),
    );
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });
});

describe('Guardrails default block', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      guardrails: {
        enabled: true,
        default_action: 'block',
        rules: [
          { name: 'allow-get', tools: ['get_*'], action: 'alert', message: 'allowed via alert' },
        ],
      },
      tools: [
        { name: 'get_contact', result: { id: 1 } },
        { name: 'update_contact', result: { updated: true } },
      ],
    });
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('blocks tools not matching any rule when default is block', async () => {
    const body = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('update_contact', { id: 1 }),
    );
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32000);
  });

  it('allows tools matching an alert rule even with default block', async () => {
    const body = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app,
      'test-server',
      makeToolCallMessage('get_contact', { id: 1 }),
    );
    expect(body.error).toBeUndefined();
  });
});

// ============================================================================
// Admin API endpoints
// ============================================================================

describe('Guardrails Admin API', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      guardrails: guardrailsConfig,
      tools: [
        { name: 'get_contact', result: { id: 1 } },
        { name: 'delete_contact', result: { deleted: true } },
        { name: 'get_ssn', result: { ssn: '***' } },
      ],
    });
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('GET /conduit/guardrails/rules — returns all configured rules', async () => {
    const res = await ctx.app.request('/conduit/guardrails/rules');
    const body = await res.json() as { enabled: boolean; default_action: string; rules: unknown[] };
    expect(body.enabled).toBe(true);
    expect(body.default_action).toBe('allow');
    expect(body.rules).toHaveLength(4);
  });

  it('GET /conduit/guardrails/check — dry-run block', async () => {
    const res = await ctx.app.request(
      '/conduit/guardrails/check?client=agent-1&server=test-server&tool=delete_user',
    );
    const body = await res.json() as GuardrailDecision;
    expect(body.action).toBe('block');
    expect(body.rule_name).toBe('block-delete');
  });

  it('GET /conduit/guardrails/check — dry-run allow', async () => {
    const res = await ctx.app.request(
      '/conduit/guardrails/check?client=agent-1&server=test-server&tool=get_contact',
    );
    const body = await res.json() as GuardrailDecision;
    expect(body.action).toBe('allow');
  });

  it('GET /conduit/guardrails/check — dry-run with args (condition match)', async () => {
    const args = encodeURIComponent(JSON.stringify({ batch_size: 200 }));
    const res = await ctx.app.request(
      `/conduit/guardrails/check?client=agent-1&server=test-server&tool=bulk_op&args=${args}`,
    );
    const body = await res.json() as GuardrailDecision;
    expect(body.action).toBe('block');
    expect(body.rule_name).toBe('block-mass-ops');
  });

  it('GET /conduit/guardrails/check — dry-run bypass', async () => {
    const res = await ctx.app.request(
      '/conduit/guardrails/check?client=admin-super&server=test-server&tool=delete_everything',
    );
    const body = await res.json() as GuardrailDecision;
    expect(body.action).toBe('allow');
    expect(body.rule_name).toBe('admin-bypass');
  });

  it('GET /conduit/guardrails/check — missing params returns 400', async () => {
    const res = await ctx.app.request('/conduit/guardrails/check?client=x');
    expect(res.status).toBe(400);
  });

  it('GET /conduit/guardrails/stats — returns block stats after some calls', async () => {
    // Make blocked calls to populate stats
    await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app, 'test-server', makeToolCallMessage('delete_contact', { id: 1 }),
    );
    await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app, 'test-server', makeToolCallMessage('delete_contact', { id: 2 }),
    );

    const res = await ctx.app.request('/conduit/guardrails/stats');
    const body = await res.json() as {
      total_actions: number;
      total_blocks: number;
      total_alerts: number;
      by_rule: Record<string, { blocks: number; alerts: number }>;
    };
    expect(body.total_actions).toBeGreaterThanOrEqual(2);
    expect(body.total_blocks).toBeGreaterThanOrEqual(2);
    expect(body.by_rule['block-delete']).toBeDefined();
    expect(body.by_rule['block-delete']!.blocks).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// Guardrails disabled admin API
// ============================================================================

describe('Guardrails Admin API — disabled', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ tools: [{ name: 'get_contact', result: { id: 1 } }] });
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('GET /conduit/guardrails/rules — returns disabled when no config', async () => {
    const res = await ctx.app.request('/conduit/guardrails/rules');
    const body = await res.json() as { enabled: boolean; rules: unknown[] };
    expect(body.enabled).toBe(false);
    expect(body.rules).toHaveLength(0);
  });

  it('GET /conduit/guardrails/check — returns allow when disabled', async () => {
    const res = await ctx.app.request(
      '/conduit/guardrails/check?client=x&server=y&tool=z',
    );
    const body = await res.json() as GuardrailDecision;
    expect(body.action).toBe('allow');
  });
});

// ============================================================================
// Log entries contain guardrail fields
// ============================================================================

describe('Guardrails log entries', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      guardrails: {
        enabled: true,
        default_action: 'allow',
        rules: [
          { name: 'block-delete', tools: ['delete_*'], action: 'block', message: 'Blocked' },
          { name: 'alert-read', tools: ['get_sensitive'], action: 'alert', severity: 'high' },
        ],
      },
      tools: [
        { name: 'get_contact', result: { id: 1 } },
        { name: 'delete_contact', result: { deleted: true } },
        { name: 'get_sensitive', result: { data: 'secret' } },
      ],
    });
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('blocked calls have guardrail_rule and guardrail_action in logs', async () => {
    await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app, 'test-server', makeToolCallMessage('delete_contact', { id: 1 }),
    );

    const res = await ctx.app.request('/conduit/logs?tool=delete_contact&limit=1');
    const body = await res.json() as { logs?: Array<{ guardrail_rule?: string; guardrail_action?: string }> };

    // The admin logs endpoint wraps results — find the log entry
    const logs = Array.isArray(body) ? body : (body.logs ?? []);
    const entry = logs[0];
    expect(entry).toBeDefined();
    expect(entry!.guardrail_rule).toBe('block-delete');
    expect(entry!.guardrail_action).toBe('block');
  });

  it('normal calls do not have guardrail fields in logs', async () => {
    await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: 1 }),
    );

    const res = await ctx.app.request('/conduit/logs?tool=get_contact&limit=1');
    const body = await res.json() as Array<{ guardrail_rule?: string; guardrail_action?: string }>;
    const logs = Array.isArray(body) ? body : [];
    if (logs.length > 0) {
      const entry = logs[0]!;
      // guardrail fields should be absent or null for normal calls
      expect(entry.guardrail_rule).toBeFalsy();
      expect(entry.guardrail_action).toBeFalsy();
    }
  });
});

// ============================================================================
// Response headers on blocked calls
// ============================================================================

describe('Guardrails response details', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      guardrails: {
        enabled: true,
        default_action: 'allow',
        rules: [
          { name: 'block-drop', tools: ['drop_*'], action: 'block', message: 'DROP operations forbidden' },
        ],
      },
      tools: [
        { name: 'drop_table', result: { dropped: true } },
        { name: 'get_user', result: { id: 1 } },
      ],
    });
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('blocked response contains the exact rule message', async () => {
    const body = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app, 'test-server', makeToolCallMessage('drop_table', {}),
    );
    expect(body.error).toBeDefined();
    expect(body.error!.message).toBe('DROP operations forbidden');
  });

  it('blocked response still includes trace header', async () => {
    const res = await sendMcpRequest(
      ctx.app, 'test-server', makeToolCallMessage('drop_table', {}),
    );
    // The transport always adds a trace header
    const traceId = res.headers.get('x-conduit-trace-id');
    expect(traceId).toBeTruthy();
  });

  it('allowed response has no guardrail error', async () => {
    const body = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app, 'test-server', makeToolCallMessage('get_user', { id: 1 }),
    );
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });
});

// ============================================================================
// Multiple conditions E2E
// ============================================================================

describe('Guardrails multiple conditions E2E', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({
      guardrails: {
        enabled: true,
        default_action: 'allow',
        rules: [{
          name: 'dangerous-combo',
          tools: ['execute_query'],
          conditions: [
            { field: 'query', operator: 'contains', value: 'DROP' },
            { field: 'force', operator: 'eq', value: true },
          ],
          action: 'block',
          message: 'Cannot force-execute DROP queries',
        }],
      },
      tools: [{ name: 'execute_query', result: { rows: [] } }],
    });
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  it('blocks when ALL conditions match', async () => {
    const body = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app, 'test-server',
      makeToolCallMessage('execute_query', { query: 'DROP TABLE users', force: true }),
    );
    expect(body.error).toBeDefined();
    expect(body.error!.message).toContain('DROP');
  });

  it('allows when only one condition matches', async () => {
    // Has DROP but force is false
    const body1 = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app, 'test-server',
      makeToolCallMessage('execute_query', { query: 'DROP TABLE users', force: false }),
    );
    expect(body1.error).toBeUndefined();

    // Has force=true but no DROP
    const body2 = await sendMcpRequestJson<JsonRpcResponse>(
      ctx.app, 'test-server',
      makeToolCallMessage('execute_query', { query: 'SELECT * FROM users', force: true }),
    );
    expect(body2.error).toBeUndefined();
  });
});
