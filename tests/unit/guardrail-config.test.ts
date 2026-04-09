import { describe, it, expect } from 'vitest';
import { validateConfig, mergeWithDefaults } from '../../src/config/schema.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';

function baseConfig(overrides: Partial<ConduitGatewayConfig> = {}): ConduitGatewayConfig {
  return {
    gateway: { port: 8080, host: '0.0.0.0' },
    router: {
      namespace_strategy: 'prefix',
      health_check: { enabled: true, interval_seconds: 30, timeout_ms: 5000, unhealthy_threshold: 3, healthy_threshold: 1 },
      load_balancing: 'round-robin',
    },
    servers: [],
    cache: { enabled: true, l1: { max_entries: 1000, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: { log_args: true, log_responses: false, redact_fields: [], retention_days: 30, db_path: ':memory:' },
    metrics: { enabled: false, port: 9090 },
    ...overrides,
  };
}

describe('guardrails config validation', () => {
  it('accepts valid guardrails config', () => {
    const config = baseConfig({
      guardrails: {
        enabled: true,
        default_action: 'allow',
        rules: [
          { name: 'r1', tools: ['delete_*'], action: 'block', message: 'blocked' },
          { name: 'r2', tools: ['*'], action: 'alert', severity: 'high' },
        ],
      },
    });
    const errors = validateConfig(config);
    const grErrors = errors.filter((e) => e.path.startsWith('guardrails'));
    expect(grErrors).toHaveLength(0);
  });

  it('rejects rule with empty name', () => {
    const config = baseConfig({
      guardrails: {
        enabled: true,
        default_action: 'allow',
        rules: [{ name: '', tools: ['*'], action: 'block' }],
      },
    });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === 'guardrails.rules[0].name')).toBe(true);
  });

  it('rejects rule with invalid action', () => {
    const config = baseConfig({
      guardrails: {
        enabled: true,
        default_action: 'allow',
        rules: [{ name: 'r1', tools: ['*'], action: 'invalid' as 'block' }],
      },
    });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === 'guardrails.rules[0].action')).toBe(true);
  });

  it('rejects duplicate rule names', () => {
    const config = baseConfig({
      guardrails: {
        enabled: true,
        default_action: 'allow',
        rules: [
          { name: 'same-name', tools: ['delete_*'], action: 'block' },
          { name: 'same-name', tools: ['get_*'], action: 'alert' },
        ],
      },
    });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === 'guardrails.rules[1].name' && e.message.includes('duplicate'))).toBe(true);
  });

  it('rejects condition with empty field', () => {
    const config = baseConfig({
      guardrails: {
        enabled: true,
        default_action: 'allow',
        rules: [{
          name: 'r1', tools: ['*'], action: 'block',
          conditions: [{ field: '', operator: 'eq', value: 1 }],
        }],
      },
    });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === 'guardrails.rules[0].conditions[0].field')).toBe(true);
  });

  it('rejects condition with invalid operator', () => {
    const config = baseConfig({
      guardrails: {
        enabled: true,
        default_action: 'allow',
        rules: [{
          name: 'r1', tools: ['*'], action: 'block',
          conditions: [{ field: 'x', operator: 'invalid' as 'eq', value: 1 }],
        }],
      },
    });
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === 'guardrails.rules[0].conditions[0].operator')).toBe(true);
  });

  it('does not validate rules when guardrails is disabled', () => {
    const config = baseConfig({
      guardrails: {
        enabled: false,
        default_action: 'allow',
        rules: [{ name: '', tools: ['*'], action: 'invalid' as 'block' }],
      },
    });
    const errors = validateConfig(config);
    const grErrors = errors.filter((e) => e.path.startsWith('guardrails'));
    expect(grErrors).toHaveLength(0);
  });
});

describe('guardrails mergeWithDefaults', () => {
  it('passes through guardrails config from YAML', () => {
    const merged = mergeWithDefaults({
      servers: [],
      guardrails: {
        enabled: true,
        default_action: 'block',
        rules: [{ name: 'r1', tools: ['*'], action: 'block' }],
      },
    });
    expect(merged.guardrails).toBeDefined();
    expect(merged.guardrails!.enabled).toBe(true);
    expect(merged.guardrails!.default_action).toBe('block');
    expect(merged.guardrails!.rules).toHaveLength(1);
  });

  it('omits guardrails when not specified in YAML', () => {
    const merged = mergeWithDefaults({ servers: [] });
    expect(merged.guardrails).toBeUndefined();
  });
});
