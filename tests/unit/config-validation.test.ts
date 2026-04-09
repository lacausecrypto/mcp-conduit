/**
 * Unit tests for validateConfig() and formatConfigErrors().
 *
 * validateConfig() returns ConfigError[] — never throws.
 * All errors are collected and returned together.
 */

import { describe, it, expect } from 'vitest';
import { validateConfig, formatConfigErrors } from '../../src/config/schema.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal valid config — used as baseline for targeted mutations */
function baseConfig(overrides: Partial<ConduitGatewayConfig> = {}): ConduitGatewayConfig {
  return {
    gateway: {
      port: 8080,
      host: '0.0.0.0',
    },
    router: {
      namespace_strategy: 'prefix',
      health_check: {
        enabled: true,
        interval_seconds: 30,
        timeout_ms: 5000,
        unhealthy_threshold: 3,
        healthy_threshold: 1,
      },
      load_balancing: 'round-robin',
    },
    servers: [],
    cache: {
      enabled: true,
      l1: {
        max_entries: 1000,
        max_entry_size_kb: 64,
      },
    },
    tenant_isolation: {
      enabled: false,
      header: 'Authorization',
    },
    observability: {
      log_args: true,
      log_responses: false,
      redact_fields: [],
      retention_days: 30,
      db_path: ':memory:',
    },
    metrics: {
      enabled: true,
      port: 9090,
    },
    ...overrides,
  };
}

function hasError(errors: ReturnType<typeof validateConfig>, path: string): boolean {
  return errors.some((e) => e.path === path);
}

// ─── Valid config ─────────────────────────────────────────────────────────────

describe('valid config', () => {
  it('returns no errors for a minimal valid config', () => {
    const errors = validateConfig(baseConfig());
    expect(errors).toEqual([]);
  });

  it('returns no errors for a config with servers', () => {
    const cfg = baseConfig({
      servers: [
        { id: 'my-server', url: 'http://localhost:3000', cache: { default_ttl: 60 } },
      ],
    });
    const errors = validateConfig(cfg);
    expect(errors).toEqual([]);
  });

  it('returns no errors with rate limits enabled (memory backend)', () => {
    const cfg = baseConfig({
      rate_limits: {
        enabled: true,
        global: { requests_per_minute: 100 },
        per_client: { requests_per_minute: 10 },
      },
    });
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('returns no errors with redis backend and valid redis_url', () => {
    const cfg = baseConfig({
      rate_limits: {
        enabled: true,
        backend: 'redis',
        redis_url: 'redis://localhost:6379',
      },
    });
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('returns no errors with circuit_breaker enabled and valid threshold', () => {
    const cfg = baseConfig({
      router: {
        ...baseConfig().router,
        circuit_breaker: {
          enabled: true,
          failure_threshold: 5,
          reset_timeout_ms: 10000,
          half_open_max_requests: 1,
          success_threshold: 2,
        },
      },
    });
    expect(validateConfig(cfg)).toEqual([]);
  });
});

// ─── gateway.port ─────────────────────────────────────────────────────────────

describe('gateway.port', () => {
  it('rejects port 0', () => {
    const errors = validateConfig(baseConfig({ gateway: { port: 0, host: '0.0.0.0' } }));
    expect(hasError(errors, 'gateway.port')).toBe(true);
  });

  it('rejects negative port', () => {
    const errors = validateConfig(baseConfig({ gateway: { port: -1, host: '0.0.0.0' } }));
    expect(hasError(errors, 'gateway.port')).toBe(true);
  });

  it('rejects port above 65535', () => {
    const errors = validateConfig(baseConfig({ gateway: { port: 99999, host: '0.0.0.0' } }));
    expect(hasError(errors, 'gateway.port')).toBe(true);
  });

  it('rejects non-integer port', () => {
    const errors = validateConfig(baseConfig({ gateway: { port: 80.5, host: '0.0.0.0' } }));
    expect(hasError(errors, 'gateway.port')).toBe(true);
  });

  it('accepts port 1', () => {
    const errors = validateConfig(baseConfig({ gateway: { port: 1, host: '0.0.0.0' } }));
    expect(hasError(errors, 'gateway.port')).toBe(false);
  });

  it('accepts port 65535', () => {
    const errors = validateConfig(baseConfig({ gateway: { port: 65535, host: '0.0.0.0' } }));
    expect(hasError(errors, 'gateway.port')).toBe(false);
  });
});

// ─── gateway.tls ─────────────────────────────────────────────────────────────

describe('gateway.tls', () => {
  it('rejects TLS enabled with missing cert file', () => {
    const cfg = baseConfig({
      gateway: {
        port: 8443,
        host: '0.0.0.0',
        tls: {
          enabled: true,
          cert_path: '/nonexistent/path/cert.pem',
          key_path: '/nonexistent/path/key.pem',
        },
      },
    });
    const errors = validateConfig(cfg);
    expect(hasError(errors, 'gateway.tls.cert_path')).toBe(true);
    expect(hasError(errors, 'gateway.tls.key_path')).toBe(true);
  });

  it('reports error value for missing TLS file', () => {
    const cfg = baseConfig({
      gateway: {
        port: 8443,
        host: '0.0.0.0',
        tls: {
          enabled: true,
          cert_path: '/no/such/cert.pem',
          key_path: '/no/such/key.pem',
        },
      },
    });
    const errors = validateConfig(cfg);
    const certErr = errors.find((e) => e.path === 'gateway.tls.cert_path');
    expect(certErr?.value).toBe('/no/such/cert.pem');
  });

  it('does not validate TLS when disabled', () => {
    // tls.enabled = false → no file existence checks
    const cfg = baseConfig({
      gateway: {
        port: 8080,
        host: '0.0.0.0',
        tls: {
          enabled: false,
          cert_path: '/nonexistent/cert.pem',
          key_path: '/nonexistent/key.pem',
        },
      },
    });
    const errors = validateConfig(cfg);
    expect(hasError(errors, 'gateway.tls.cert_path')).toBe(false);
    expect(hasError(errors, 'gateway.tls.key_path')).toBe(false);
  });
});

// ─── metrics.port ─────────────────────────────────────────────────────────────

describe('metrics.port', () => {
  it('rejects metrics.port same as gateway.port', () => {
    const cfg = baseConfig({
      gateway: { port: 8080, host: '0.0.0.0' },
      metrics: { enabled: true, port: 8080 },
    });
    const errors = validateConfig(cfg);
    expect(hasError(errors, 'metrics.port')).toBe(true);
  });

  it('accepts different ports', () => {
    const cfg = baseConfig({
      gateway: { port: 8080, host: '0.0.0.0' },
      metrics: { enabled: true, port: 9090 },
    });
    expect(hasError(validateConfig(cfg), 'metrics.port')).toBe(false);
  });

  it('rejects invalid metrics.port', () => {
    const cfg = baseConfig({ metrics: { enabled: true, port: 0 } });
    expect(hasError(validateConfig(cfg), 'metrics.port')).toBe(true);
  });
});

// ─── servers ─────────────────────────────────────────────────────────────────

describe('servers', () => {
  it('rejects server with empty id', () => {
    const cfg = baseConfig({
      servers: [{ id: '', url: 'http://localhost:3000', cache: { default_ttl: 0 } }],
    });
    const errors = validateConfig(cfg);
    expect(hasError(errors, 'servers[0].id')).toBe(true);
  });

  it('rejects server id with invalid characters', () => {
    const cfg = baseConfig({
      servers: [{ id: 'my server!', url: 'http://localhost:3000', cache: { default_ttl: 0 } }],
    });
    const errors = validateConfig(cfg);
    expect(hasError(errors, 'servers[0].id')).toBe(true);
  });

  it('accepts alphanumeric server id with dashes', () => {
    const cfg = baseConfig({
      servers: [{ id: 'my-server-1', url: 'http://localhost:3000', cache: { default_ttl: 0 } }],
    });
    expect(hasError(validateConfig(cfg), 'servers[0].id')).toBe(false);
  });

  it('rejects server with invalid url', () => {
    const cfg = baseConfig({
      servers: [{ id: 'srv', url: 'not-a-url', cache: { default_ttl: 0 } }],
    });
    const errors = validateConfig(cfg);
    expect(hasError(errors, 'servers[0].url')).toBe(true);
  });

  it('rejects server with empty url', () => {
    const cfg = baseConfig({
      servers: [{ id: 'srv', url: '', cache: { default_ttl: 0 } }],
    });
    const errors = validateConfig(cfg);
    expect(hasError(errors, 'servers[0].url')).toBe(true);
  });

  it('rejects negative cache.default_ttl', () => {
    const cfg = baseConfig({
      servers: [{ id: 'srv', url: 'http://localhost', cache: { default_ttl: -1 } }],
    });
    const errors = validateConfig(cfg);
    expect(hasError(errors, 'servers[0].cache.default_ttl')).toBe(true);
  });

  it('accepts zero default_ttl (cache disabled)', () => {
    const cfg = baseConfig({
      servers: [{ id: 'srv', url: 'http://localhost', cache: { default_ttl: 0 } }],
    });
    expect(hasError(validateConfig(cfg), 'servers[0].cache.default_ttl')).toBe(false);
  });

  it('rejects invalid replica URL', () => {
    const cfg = baseConfig({
      servers: [{
        id: 'srv',
        url: 'http://localhost:3000',
        cache: { default_ttl: 0 },
        replicas: ['http://replica1:3001', 'not-a-url'],
      }],
    });
    const errors = validateConfig(cfg);
    expect(hasError(errors, 'servers[0].replicas[1]')).toBe(true);
    expect(hasError(errors, 'servers[0].replicas[0]')).toBe(false);
  });

  it('validates multiple servers independently', () => {
    const cfg = baseConfig({
      servers: [
        { id: 'good', url: 'http://localhost:3000', cache: { default_ttl: 0 } },
        { id: 'bad server', url: 'not-a-url', cache: { default_ttl: -1 } },
      ],
    });
    const errors = validateConfig(cfg);
    expect(hasError(errors, 'servers[1].id')).toBe(true);
    expect(hasError(errors, 'servers[1].url')).toBe(true);
    expect(hasError(errors, 'servers[1].cache.default_ttl')).toBe(true);
    expect(hasError(errors, 'servers[0].id')).toBe(false);
  });
});

// ─── rate_limits ─────────────────────────────────────────────────────────────

describe('rate_limits', () => {
  it('rejects global.requests_per_minute <= 0', () => {
    const cfg = baseConfig({
      rate_limits: {
        enabled: true,
        global: { requests_per_minute: 0 },
      },
    });
    expect(hasError(validateConfig(cfg), 'rate_limits.global.requests_per_minute')).toBe(true);
  });

  it('rejects per_client.requests_per_minute <= 0', () => {
    const cfg = baseConfig({
      rate_limits: {
        enabled: true,
        per_client: { requests_per_minute: -5 },
      },
    });
    expect(hasError(validateConfig(cfg), 'rate_limits.per_client.requests_per_minute')).toBe(true);
  });

  it('rejects redis backend without redis_url', () => {
    const cfg = baseConfig({
      rate_limits: {
        enabled: true,
        backend: 'redis',
      },
    });
    expect(hasError(validateConfig(cfg), 'rate_limits.redis_url')).toBe(true);
  });

  it('rejects redis backend with invalid redis_url', () => {
    const cfg = baseConfig({
      rate_limits: {
        enabled: true,
        backend: 'redis',
        redis_url: 'not-a-url',
      },
    });
    expect(hasError(validateConfig(cfg), 'rate_limits.redis_url')).toBe(true);
  });

  it('accepts redis backend with valid redis_url', () => {
    const cfg = baseConfig({
      rate_limits: {
        enabled: true,
        backend: 'redis',
        redis_url: 'redis://user:pass@localhost:6380/0',
      },
    });
    expect(hasError(validateConfig(cfg), 'rate_limits.redis_url')).toBe(false);
  });

  it('skips rate_limits validation when disabled', () => {
    const cfg = baseConfig({
      rate_limits: {
        enabled: false,
        backend: 'redis',
        // no redis_url — but validation skipped because disabled
      },
    });
    expect(hasError(validateConfig(cfg), 'rate_limits.redis_url')).toBe(false);
  });

  it('rejects queue.max_wait_ms < 0', () => {
    const cfg = baseConfig({
      rate_limits: {
        enabled: true,
        queue: { enabled: true, max_wait_ms: -1, max_queue_size: 100 },
      },
    });
    expect(hasError(validateConfig(cfg), 'rate_limits.queue.max_wait_ms')).toBe(true);
  });

  it('rejects queue.max_queue_size <= 0', () => {
    const cfg = baseConfig({
      rate_limits: {
        enabled: true,
        queue: { enabled: true, max_wait_ms: 1000, max_queue_size: 0 },
      },
    });
    expect(hasError(validateConfig(cfg), 'rate_limits.queue.max_queue_size')).toBe(true);
  });
});

// ─── circuit_breaker ─────────────────────────────────────────────────────────

describe('router.circuit_breaker', () => {
  it('rejects failure_threshold <= 0 when enabled', () => {
    const cfg = baseConfig({
      router: {
        ...baseConfig().router,
        circuit_breaker: {
          enabled: true,
          failure_threshold: 0,
          reset_timeout_ms: 5000,
          half_open_max_requests: 1,
          success_threshold: 1,
        },
      },
    });
    expect(hasError(validateConfig(cfg), 'router.circuit_breaker.failure_threshold')).toBe(true);
  });

  it('skips circuit_breaker validation when disabled', () => {
    const cfg = baseConfig({
      router: {
        ...baseConfig().router,
        circuit_breaker: {
          enabled: false,
          failure_threshold: 0, // invalid — but ignored because disabled
          reset_timeout_ms: 5000,
          half_open_max_requests: 1,
          success_threshold: 1,
        },
      },
    });
    expect(hasError(validateConfig(cfg), 'router.circuit_breaker.failure_threshold')).toBe(false);
  });
});

// ─── auth ─────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('rejects jwt method without jwks_url', () => {
    const cfg = baseConfig({
      auth: { method: 'jwt' } as ConduitGatewayConfig['auth'],
    });
    expect(hasError(validateConfig(cfg), 'auth.jwks_url')).toBe(true);
  });

  it('accepts api-key method without jwks_url', () => {
    const cfg = baseConfig({
      auth: {
        method: 'api-key',
        api_keys: [{ key: 'test', client_id: 'c1' }],
      } as ConduitGatewayConfig['auth'],
    });
    expect(hasError(validateConfig(cfg), 'auth.jwks_url')).toBe(false);
  });
});

// ─── acl ─────────────────────────────────────────────────────────────────────

describe('acl', () => {
  it('rejects policy with empty clients array', () => {
    const cfg = baseConfig({
      acl: {
        enabled: true,
        default_action: 'deny',
        policies: [
          { clients: [], action: 'allow', servers: ['*'] },
        ],
      } as ConduitGatewayConfig['acl'],
    });
    const errors = validateConfig(cfg);
    expect(hasError(errors, 'acl.policies[0].clients')).toBe(true);
  });

  it('accepts policy with non-empty clients array', () => {
    const cfg = baseConfig({
      acl: {
        enabled: true,
        default_action: 'deny',
        policies: [
          { clients: ['client-a'], action: 'allow', servers: ['*'] },
        ],
      } as ConduitGatewayConfig['acl'],
    });
    expect(hasError(validateConfig(cfg), 'acl.policies[0].clients')).toBe(false);
  });
});

// ─── observability ───────────────────────────────────────────────────────────

describe('observability', () => {
  it('rejects retention_days < 1', () => {
    const cfg = baseConfig({
      observability: { ...baseConfig().observability, retention_days: 0 },
    });
    expect(hasError(validateConfig(cfg), 'observability.retention_days')).toBe(true);
  });

  it('accepts retention_days = 1', () => {
    const cfg = baseConfig({
      observability: { ...baseConfig().observability, retention_days: 1 },
    });
    expect(hasError(validateConfig(cfg), 'observability.retention_days')).toBe(false);
  });
});

// ─── Multiple errors at once ──────────────────────────────────────────────────

describe('multiple errors collected', () => {
  it('reports all errors simultaneously — not just the first', () => {
    const cfg = baseConfig({
      gateway: { port: 0, host: '0.0.0.0' },
      metrics: { enabled: true, port: 0 },
      servers: [
        { id: '', url: 'bad-url', cache: { default_ttl: -99 } },
      ],
      observability: { ...baseConfig().observability, retention_days: 0 },
    });

    const errors = validateConfig(cfg);
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(hasError(errors, 'gateway.port')).toBe(true);
    expect(hasError(errors, 'metrics.port')).toBe(true);
    expect(hasError(errors, 'servers[0].id')).toBe(true);
    expect(hasError(errors, 'servers[0].url')).toBe(true);
  });

  it('returns empty array for completely valid config', () => {
    expect(validateConfig(baseConfig())).toHaveLength(0);
  });
});

// ─── formatConfigErrors ───────────────────────────────────────────────────────

describe('formatConfigErrors()', () => {
  it('returns a formatted string with error paths', () => {
    const cfg = baseConfig({ gateway: { port: 0, host: '0.0.0.0' } });
    const errors = validateConfig(cfg);
    const formatted = formatConfigErrors(errors);
    expect(formatted).toContain('[CONDUIT] Configuration errors:');
    expect(formatted).toContain('gateway.port');
    expect(formatted).toContain('0');
  });

  it('includes "got: ..." for errors with values', () => {
    const cfg = baseConfig({ gateway: { port: 99999, host: '0.0.0.0' } });
    const errors = validateConfig(cfg);
    const formatted = formatConfigErrors(errors);
    expect(formatted).toContain('got:');
  });

  it('formats multiple errors on separate lines', () => {
    const cfg = baseConfig({
      gateway: { port: 0, host: '0.0.0.0' },
      metrics: { enabled: true, port: 0 },
    });
    const errors = validateConfig(cfg);
    const lines = formatConfigErrors(errors).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});
