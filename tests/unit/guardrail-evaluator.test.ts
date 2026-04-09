import { describe, it, expect } from 'vitest';
import { evaluateGuardrails, type GuardrailContext } from '../../src/guardrails/evaluator.js';
import type { GuardrailsConfig, GuardrailRule } from '../../src/guardrails/types.js';

function makeConfig(rules: GuardrailRule[], defaultAction: 'allow' | 'block' = 'allow'): GuardrailsConfig {
  return { enabled: true, default_action: defaultAction, rules };
}

function makeContext(overrides: Partial<GuardrailContext> = {}): GuardrailContext {
  return {
    clientId: 'agent-1',
    serverId: 'server-1',
    toolName: 'get_contact',
    toolArgs: {},
    ...overrides,
  };
}

describe('evaluateGuardrails', () => {
  // ─── Default action ─────────────────────────────────────────────────────────
  describe('default action', () => {
    it('returns allow when no rules and default_action is allow', () => {
      const decision = evaluateGuardrails(makeContext(), makeConfig([], 'allow'));
      expect(decision.action).toBe('allow');
      expect(decision.rule_name).toBe('');
    });

    it('returns block when no rules and default_action is block', () => {
      const decision = evaluateGuardrails(makeContext(), makeConfig([], 'block'));
      expect(decision.action).toBe('block');
      expect(decision.rule_name).toBe('');
    });
  });

  // ─── Tool pattern matching ──────────────────────────────────────────────────
  describe('tool pattern matching', () => {
    it('matches exact tool name', () => {
      const config = makeConfig([
        { name: 'r1', tools: ['delete_contact'], action: 'block', message: 'blocked' },
      ]);
      const decision = evaluateGuardrails(makeContext({ toolName: 'delete_contact' }), config);
      expect(decision.action).toBe('block');
      expect(decision.rule_name).toBe('r1');
    });

    it('matches wildcard prefix', () => {
      const config = makeConfig([
        { name: 'r1', tools: ['delete_*'], action: 'block', message: 'blocked' },
      ]);
      expect(evaluateGuardrails(makeContext({ toolName: 'delete_user' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolName: 'get_user' }), config).action).toBe('allow');
    });

    it('matches star wildcard', () => {
      const config = makeConfig([
        { name: 'r1', tools: ['*'], action: 'alert', message: 'all tools' },
      ]);
      expect(evaluateGuardrails(makeContext({ toolName: 'anything' }), config).action).toBe('alert');
    });

    it('skips rule when tool does not match', () => {
      const config = makeConfig([
        { name: 'r1', tools: ['delete_*'], action: 'block', message: 'blocked' },
      ]);
      const decision = evaluateGuardrails(makeContext({ toolName: 'get_contact' }), config);
      expect(decision.action).toBe('allow');
    });

    it('matches when tools is omitted (all tools)', () => {
      const config = makeConfig([
        { name: 'r1', action: 'alert', message: 'all' },
      ]);
      expect(evaluateGuardrails(makeContext(), config).action).toBe('alert');
    });
  });

  // ─── Client scoping ─────────────────────────────────────────────────────────
  describe('client scoping', () => {
    it('matches specific client', () => {
      const config = makeConfig([
        { name: 'r1', clients: ['agent-1'], tools: ['*'], action: 'block', message: 'blocked' },
      ]);
      expect(evaluateGuardrails(makeContext({ clientId: 'agent-1' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ clientId: 'agent-2' }), config).action).toBe('allow');
    });

    it('matches wildcard client pattern', () => {
      const config = makeConfig([
        { name: 'r1', clients: ['agent-*'], tools: ['*'], action: 'block', message: 'blocked' },
      ]);
      expect(evaluateGuardrails(makeContext({ clientId: 'agent-prod' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ clientId: 'admin-1' }), config).action).toBe('allow');
    });
  });

  // ─── Server scoping ─────────────────────────────────────────────────────────
  describe('server scoping', () => {
    it('matches specific server', () => {
      const config = makeConfig([
        { name: 'r1', servers: ['server-1'], tools: ['*'], action: 'block', message: 'blocked' },
      ]);
      expect(evaluateGuardrails(makeContext({ serverId: 'server-1' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ serverId: 'server-2' }), config).action).toBe('allow');
    });
  });

  // ─── Bypass ─────────────────────────────────────────────────────────────────
  describe('bypass', () => {
    it('allows everything for bypassed clients', () => {
      const config = makeConfig([
        { name: 'bypass', clients: ['admin-*'], bypass: true, action: 'block' },
        { name: 'block-all', tools: ['*'], action: 'block', message: 'blocked' },
      ]);
      expect(evaluateGuardrails(makeContext({ clientId: 'admin-1' }), config).action).toBe('allow');
      expect(evaluateGuardrails(makeContext({ clientId: 'admin-1' }), config).rule_name).toBe('bypass');
      expect(evaluateGuardrails(makeContext({ clientId: 'agent-1' }), config).action).toBe('block');
    });
  });

  // ─── Conditions ─────────────────────────────────────────────────────────────
  describe('conditions', () => {
    it('evaluates eq operator', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'status', operator: 'eq', value: 'active' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { status: 'active' } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { status: 'inactive' } }), config).action).toBe('allow');
    });

    it('evaluates neq operator', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'status', operator: 'neq', value: 'safe' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { status: 'danger' } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { status: 'safe' } }), config).action).toBe('allow');
    });

    it('evaluates gt operator', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'too many',
        conditions: [{ field: 'batch_size', operator: 'gt', value: 100 }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { batch_size: 200 } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { batch_size: 50 } }), config).action).toBe('allow');
      expect(evaluateGuardrails(makeContext({ toolArgs: { batch_size: 100 } }), config).action).toBe('allow');
    });

    it('evaluates gte operator', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'count', operator: 'gte', value: 10 }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { count: 10 } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { count: 9 } }), config).action).toBe('allow');
    });

    it('evaluates lt and lte operators', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'score', operator: 'lt', value: 0 }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { score: -1 } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { score: 0 } }), config).action).toBe('allow');
    });

    it('evaluates contains operator on strings', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'email', operator: 'contains', value: '@external.com' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { email: 'user@external.com' } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { email: 'user@company.com' } }), config).action).toBe('allow');
    });

    it('evaluates not_contains operator', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'to', operator: 'not_contains', value: '@company.com' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { to: 'user@gmail.com' } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { to: 'user@company.com' } }), config).action).toBe('allow');
    });

    it('evaluates matches (regex) operator', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'query', operator: 'matches', value: '^DROP\\s' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { query: 'DROP TABLE users' } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { query: 'SELECT * FROM users' } }), config).action).toBe('allow');
    });

    it('evaluates exists operator', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'dangerous_flag', operator: 'exists' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { dangerous_flag: true } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: {} }), config).action).toBe('allow');
    });

    it('evaluates not_exists operator', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'auth_token', operator: 'not_exists' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: {} }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { auth_token: 'abc' } }), config).action).toBe('allow');
    });

    it('resolves dot-path fields', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'options.limit', operator: 'gt', value: 1000 }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { options: { limit: 5000 } } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { options: { limit: 500 } } }), config).action).toBe('allow');
    });

    it('returns allow when field does not exist (non-exists operators)', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'missing.field', operator: 'gt', value: 0 }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: {} }), config).action).toBe('allow');
    });

    it('requires ALL conditions to match (AND logic)', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [
          { field: 'count', operator: 'gt', value: 10 },
          { field: 'force', operator: 'eq', value: true },
        ],
      }]);
      // Both match
      expect(evaluateGuardrails(makeContext({ toolArgs: { count: 20, force: true } }), config).action).toBe('block');
      // Only one matches
      expect(evaluateGuardrails(makeContext({ toolArgs: { count: 20, force: false } }), config).action).toBe('allow');
      expect(evaluateGuardrails(makeContext({ toolArgs: { count: 5, force: true } }), config).action).toBe('allow');
    });
  });

  // ─── First-match-wins ───────────────────────────────────────────────────────
  describe('first-match-wins ordering', () => {
    it('returns the first matching rule', () => {
      const config = makeConfig([
        { name: 'r1', tools: ['delete_*'], action: 'alert', message: 'alert' },
        { name: 'r2', tools: ['delete_*'], action: 'block', message: 'block' },
      ]);
      const decision = evaluateGuardrails(makeContext({ toolName: 'delete_user' }), config);
      expect(decision.action).toBe('alert');
      expect(decision.rule_name).toBe('r1');
    });
  });

  // ─── Severity and webhook ───────────────────────────────────────────────────
  describe('metadata passthrough', () => {
    it('includes severity and webhook in decision', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        severity: 'critical', webhook: 'https://hooks.example.com/alert',
      }]);
      const decision = evaluateGuardrails(makeContext(), config);
      expect(decision.severity).toBe('critical');
      expect(decision.webhook).toBe('https://hooks.example.com/alert');
    });

    it('does not include severity/webhook when not set', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
      }]);
      const decision = evaluateGuardrails(makeContext(), config);
      expect(decision.severity).toBeUndefined();
      expect(decision.webhook).toBeUndefined();
    });
  });

  // ─── Contains on arrays ─────────────────────────────────────────────────────
  describe('contains on arrays', () => {
    it('checks array membership', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'tags', operator: 'contains', value: 'admin' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { tags: ['user', 'admin'] } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { tags: ['user'] } }), config).action).toBe('allow');
    });

    it('not_contains on arrays', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'roles', operator: 'not_contains', value: 'admin' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { roles: ['user'] } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { roles: ['admin', 'user'] } }), config).action).toBe('allow');
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('handles empty conditions array (matches unconditionally)', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['delete_*'], action: 'block', message: 'blocked',
        conditions: [],
      }]);
      expect(evaluateGuardrails(makeContext({ toolName: 'delete_user' }), config).action).toBe('block');
    });

    it('handles empty tools array (treated as all tools — matches)', () => {
      const config = makeConfig([{
        name: 'r1', tools: [], action: 'block', message: 'blocked',
      }]);
      // Empty array = no filter = matches all (same as omitted)
      expect(evaluateGuardrails(makeContext(), config).action).toBe('block');
    });

    it('handles empty clients array (treated as all clients — matches)', () => {
      const config = makeConfig([{
        name: 'r1', clients: [], tools: ['*'], action: 'block', message: 'blocked',
      }]);
      expect(evaluateGuardrails(makeContext(), config).action).toBe('block');
    });

    it('handles empty servers array (treated as all servers — matches)', () => {
      const config = makeConfig([{
        name: 'r1', servers: [], tools: ['*'], action: 'block', message: 'blocked',
      }]);
      expect(evaluateGuardrails(makeContext(), config).action).toBe('block');
    });

    it('handles null-ish values in args gracefully', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'value', operator: 'eq', value: null }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { value: null } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { value: 'something' } }), config).action).toBe('allow');
    });

    it('handles deeply nested dot-path (3+ levels)', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'a.b.c.d', operator: 'eq', value: 42 }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { a: { b: { c: { d: 42 } } } } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { a: { b: { c: { d: 99 } } } } }), config).action).toBe('allow');
    });

    it('dot-path through null intermediate returns undefined (no crash)', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'a.b.c', operator: 'exists' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { a: null } }), config).action).toBe('allow');
      expect(evaluateGuardrails(makeContext({ toolArgs: { a: { b: null } } }), config).action).toBe('allow');
    });

    it('invalid regex in matches operator does not crash', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'query', operator: 'matches', value: '[invalid(' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { query: 'anything' } }), config).action).toBe('allow');
    });

    it('gt/lt with non-numeric values does not match', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'count', operator: 'gt', value: 10 }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { count: 'not-a-number' } }), config).action).toBe('allow');
    });

    it('contains with non-string/non-array actual returns false', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'data', operator: 'contains', value: 'x' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { data: 42 } }), config).action).toBe('allow');
      expect(evaluateGuardrails(makeContext({ toolArgs: { data: true } }), config).action).toBe('allow');
    });

    it('not_contains with non-string/non-array actual returns true', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'data', operator: 'not_contains', value: 'x' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { data: 42 } }), config).action).toBe('block');
    });

    it('lte boundary value', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'count', operator: 'lte', value: 5 }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { count: 5 } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { count: 4 } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { count: 6 } }), config).action).toBe('allow');
    });

    it('uses custom message from rule', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'Custom block reason',
      }]);
      expect(evaluateGuardrails(makeContext(), config).reason).toBe('Custom block reason');
    });

    it('uses generated message when rule has no message', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block',
      }]);
      const decision = evaluateGuardrails(makeContext(), config);
      expect(decision.reason).toContain('r1');
      expect(decision.reason).toContain('get_contact');
    });
  });

  // ─── Multiple patterns in one rule ──────────────────────────────────────────
  describe('multiple patterns', () => {
    it('matches any of multiple tool patterns', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['delete_*', 'drop_*', 'remove_*'], action: 'block', message: 'blocked',
      }]);
      expect(evaluateGuardrails(makeContext({ toolName: 'delete_user' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolName: 'drop_table' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolName: 'remove_item' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolName: 'get_user' }), config).action).toBe('allow');
    });

    it('matches any of multiple client patterns', () => {
      const config = makeConfig([{
        name: 'r1', clients: ['bot-*', 'script-*'], tools: ['*'], action: 'block', message: 'blocked',
      }]);
      expect(evaluateGuardrails(makeContext({ clientId: 'bot-1' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ clientId: 'script-daily' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ clientId: 'human-user' }), config).action).toBe('allow');
    });

    it('matches any of multiple server patterns', () => {
      const config = makeConfig([{
        name: 'r1', servers: ['prod-*', 'staging-*'], tools: ['*'], action: 'block', message: 'blocked',
      }]);
      expect(evaluateGuardrails(makeContext({ serverId: 'prod-db' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ serverId: 'staging-api' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ serverId: 'dev-local' }), config).action).toBe('allow');
    });
  });

  // ─── Complex rule combinations ──────────────────────────────────────────────
  describe('complex rule combinations', () => {
    it('bypass takes precedence even with later block-all rule', () => {
      const config = makeConfig([
        { name: 'bypass-admins', clients: ['admin-*'], bypass: true },
        { name: 'block-deletes', tools: ['delete_*'], action: 'block', message: 'blocked' },
        { name: 'block-all', tools: ['*'], action: 'block', message: 'blocked' },
      ]);
      expect(evaluateGuardrails(makeContext({ clientId: 'admin-1', toolName: 'delete_user' }), config).action).toBe('allow');
      expect(evaluateGuardrails(makeContext({ clientId: 'agent-1', toolName: 'delete_user' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ clientId: 'agent-1', toolName: 'delete_user' }), config).rule_name).toBe('block-deletes');
      expect(evaluateGuardrails(makeContext({ clientId: 'agent-1', toolName: 'get_user' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ clientId: 'agent-1', toolName: 'get_user' }), config).rule_name).toBe('block-all');
    });

    it('scoped rule does not affect other clients/servers', () => {
      const config = makeConfig([{
        name: 'block-prod-deletes',
        clients: ['agent-*'], servers: ['prod-*'], tools: ['delete_*'],
        action: 'block', message: 'No deletes on prod',
      }]);
      expect(evaluateGuardrails(makeContext({ clientId: 'agent-1', serverId: 'prod-db', toolName: 'delete_user' }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ clientId: 'agent-1', serverId: 'dev-db', toolName: 'delete_user' }), config).action).toBe('allow');
      expect(evaluateGuardrails(makeContext({ clientId: 'admin-1', serverId: 'prod-db', toolName: 'delete_user' }), config).action).toBe('allow');
    });

    it('condition + scope combined correctly', () => {
      const config = makeConfig([{
        name: 'token-limit', servers: ['openai-*'], tools: ['generate_*'],
        conditions: [{ field: 'max_tokens', operator: 'gt', value: 4000 }],
        action: 'block', message: 'Max tokens exceeded',
      }]);
      expect(evaluateGuardrails(makeContext({ serverId: 'openai-prod', toolName: 'generate_text', toolArgs: { max_tokens: 8000 } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ serverId: 'openai-prod', toolName: 'generate_text', toolArgs: { max_tokens: 2000 } }), config).action).toBe('allow');
      expect(evaluateGuardrails(makeContext({ serverId: 'local-llm', toolName: 'generate_text', toolArgs: { max_tokens: 8000 } }), config).action).toBe('allow');
    });

    it('first rule wins even if later rule would be more specific', () => {
      const config = makeConfig([
        { name: 'alert-all-deletes', tools: ['delete_*'], action: 'alert', message: 'alert' },
        { name: 'block-mass-deletes', tools: ['delete_*'], conditions: [{ field: 'batch', operator: 'gt', value: 10 }], action: 'block', message: 'block' },
      ]);
      const decision = evaluateGuardrails(makeContext({ toolName: 'delete_user', toolArgs: { batch: 100 } }), config);
      expect(decision.action).toBe('alert');
      expect(decision.rule_name).toBe('alert-all-deletes');
    });
  });

  // ─── Type strictness ────────────────────────────────────────────────────────
  describe('type strictness', () => {
    it('eq with boolean', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'force', operator: 'eq', value: true }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { force: true } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { force: false } }), config).action).toBe('allow');
    });

    it('eq with zero', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'code', operator: 'eq', value: 0 }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { code: 0 } }), config).action).toBe('block');
      expect(evaluateGuardrails(makeContext({ toolArgs: { code: 1 } }), config).action).toBe('allow');
    });

    it('eq uses strict comparison (no type coercion)', () => {
      const config = makeConfig([{
        name: 'r1', tools: ['*'], action: 'block', message: 'blocked',
        conditions: [{ field: 'count', operator: 'eq', value: '5' }],
      }]);
      expect(evaluateGuardrails(makeContext({ toolArgs: { count: 5 } }), config).action).toBe('allow');
      expect(evaluateGuardrails(makeContext({ toolArgs: { count: '5' } }), config).action).toBe('block');
    });
  });
});
