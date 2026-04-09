/**
 * Schéma de validation et valeurs par défaut de la configuration.
 * Fusionne la configuration partielle avec les valeurs par défaut.
 */

import { existsSync } from 'node:fs';
import type {
  ConduitGatewayConfig,
  GatewayConfig,
  RouterConfig,
  CacheConfig,
  TenantIsolationConfig,
  ObservabilityConfig,
  MetricsConfig,
  AdminConfig,
  ServerConfig,
  ServerCacheConfig,
  ConfigError,
} from './types.js';

/** Valeurs par défaut de la configuration */
export const DEFAULT_GATEWAY_CONFIG: ConduitGatewayConfig = {
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
      max_entries: 10000,
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
    redact_fields: ['ssn', 'password', 'api_key', 'apikey', 'token', 'secret', 'authorization', 'bearer', 'private_key', 'privatekey'],
    retention_days: 30,
    db_path: './conduit-logs.db',
  },
  metrics: {
    enabled: true,
    port: 9090,
  },
};

/**
 * Validates all configuration values and returns a list of errors.
 * Returns an empty array if the configuration is valid.
 * Does NOT throw — callers decide how to handle errors.
 */
export function validateConfig(config: ConduitGatewayConfig): ConfigError[] {
  const errors: ConfigError[] = [];
  const { gateway, router, cache, observability, metrics, servers } = config;

  // ── gateway.port ──────────────────────────────────────────────────────────
  if (!Number.isInteger(gateway.port) || gateway.port < 1 || gateway.port > 65535) {
    errors.push({
      path: 'gateway.port',
      message: 'must be between 1 and 65535',
      value: gateway.port,
    });
  }

  // ── gateway.tls ───────────────────────────────────────────────────────────
  if (gateway.tls?.enabled) {
    if (!gateway.tls.cert_path) {
      errors.push({ path: 'gateway.tls.cert_path', message: 'required when TLS is enabled' });
    } else if (!existsSync(gateway.tls.cert_path)) {
      errors.push({
        path: 'gateway.tls.cert_path',
        message: `file not found: ${gateway.tls.cert_path}`,
        value: gateway.tls.cert_path,
      });
    }
    if (!gateway.tls.key_path) {
      errors.push({ path: 'gateway.tls.key_path', message: 'required when TLS is enabled' });
    } else if (!existsSync(gateway.tls.key_path)) {
      errors.push({
        path: 'gateway.tls.key_path',
        message: `file not found: ${gateway.tls.key_path}`,
        value: gateway.tls.key_path,
      });
    }
  }

  // ── router.health_check ──────────────────────────────────────────────────
  if (router.health_check.interval_seconds <= 0) {
    errors.push({
      path: 'router.health_check.interval_seconds',
      message: 'must be greater than 0',
      value: router.health_check.interval_seconds,
    });
  }
  if (router.health_check.timeout_ms <= 0) {
    errors.push({
      path: 'router.health_check.timeout_ms',
      message: 'must be greater than 0',
      value: router.health_check.timeout_ms,
    });
  }
  if (router.health_check.unhealthy_threshold < 1) {
    errors.push({
      path: 'router.health_check.unhealthy_threshold',
      message: 'must be >= 1',
      value: router.health_check.unhealthy_threshold,
    });
  }

  // ── router.circuit_breaker ───────────────────────────────────────────────
  if (router.circuit_breaker?.enabled) {
    if (router.circuit_breaker.failure_threshold <= 0) {
      errors.push({
        path: 'router.circuit_breaker.failure_threshold',
        message: 'must be greater than 0',
        value: router.circuit_breaker.failure_threshold,
      });
    }
  }

  // ── cache.l1 ─────────────────────────────────────────────────────────────
  if (cache.l1.max_entries < 1) {
    errors.push({
      path: 'cache.l1.max_entries',
      message: 'must be greater than 0',
      value: cache.l1.max_entries,
    });
  }
  if (cache.l1.max_entry_size_kb < 1) {
    errors.push({
      path: 'cache.l1.max_entry_size_kb',
      message: 'must be greater than 0',
      value: cache.l1.max_entry_size_kb,
    });
  }

  // ── cache.l2 ─────────────────────────────────────────────────────────────
  if (cache.l2?.enabled) {
    if (!cache.l2.redis_url) {
      errors.push({ path: 'cache.l2.redis_url', message: 'required when L2 cache is enabled' });
    } else {
      try { new URL(cache.l2.redis_url); } catch {
        errors.push({ path: 'cache.l2.redis_url', message: 'must be a valid Redis URL', value: cache.l2.redis_url });
      }
    }
    if (cache.l2.default_ttl_multiplier !== undefined && cache.l2.default_ttl_multiplier < 1) {
      errors.push({ path: 'cache.l2.default_ttl_multiplier', message: 'must be >= 1', value: cache.l2.default_ttl_multiplier });
    }
  }

  // ── observability ─────────────────────────────────────────────────────────
  if (observability.retention_days < 1) {
    errors.push({
      path: 'observability.retention_days',
      message: 'must be >= 1',
      value: observability.retention_days,
    });
  }

  // ── metrics.port ──────────────────────────────────────────────────────────
  if (!Number.isInteger(metrics.port) || metrics.port < 1 || metrics.port > 65535) {
    errors.push({
      path: 'metrics.port',
      message: 'must be between 1 and 65535',
      value: metrics.port,
    });
  }
  if (
    metrics.enabled &&
    Number.isInteger(metrics.port) &&
    metrics.port === gateway.port
  ) {
    errors.push({
      path: 'metrics.port',
      message: `must be different from gateway.port (${gateway.port})`,
      value: metrics.port,
    });
  }

  // ── rate_limits ───────────────────────────────────────────────────────────
  const rl = config.rate_limits;
  if (rl?.enabled) {
    if (rl.global?.requests_per_minute !== undefined && rl.global.requests_per_minute <= 0) {
      errors.push({
        path: 'rate_limits.global.requests_per_minute',
        message: 'must be greater than 0',
        value: rl.global.requests_per_minute,
      });
    }
    if (rl.per_client?.requests_per_minute !== undefined && rl.per_client.requests_per_minute <= 0) {
      errors.push({
        path: 'rate_limits.per_client.requests_per_minute',
        message: 'must be greater than 0',
        value: rl.per_client.requests_per_minute,
      });
    }
    if (rl.backend === 'redis') {
      if (!rl.redis_url) {
        errors.push({
          path: 'rate_limits.redis_url',
          message: 'required when backend is "redis"',
        });
      } else {
        try {
          new URL(rl.redis_url);
        } catch {
          errors.push({
            path: 'rate_limits.redis_url',
            message: 'must be a valid URL',
            value: rl.redis_url,
          });
        }
      }
    }
    if (rl.queue?.max_wait_ms !== undefined && rl.queue.max_wait_ms < 0) {
      errors.push({
        path: 'rate_limits.queue.max_wait_ms',
        message: 'must be >= 0',
        value: rl.queue.max_wait_ms,
      });
    }
    if (rl.queue?.max_queue_size !== undefined && rl.queue.max_queue_size <= 0) {
      errors.push({
        path: 'rate_limits.queue.max_queue_size',
        message: 'must be greater than 0',
        value: rl.queue.max_queue_size,
      });
    }
  }

  // ── auth ──────────────────────────────────────────────────────────────────
  if (config.auth?.method === 'jwt' && !config.auth.jwks_url) {
    errors.push({
      path: 'auth.jwks_url',
      message: 'required when auth method is "jwt"',
    });
  }

  // ── acl ───────────────────────────────────────────────────────────────────
  if (config.acl?.enabled && config.acl.policies) {
    for (let i = 0; i < config.acl.policies.length; i++) {
      const policy = config.acl.policies[i];
      if (policy && (!policy.clients || policy.clients.length === 0)) {
        errors.push({
          path: `acl.policies[${i}].clients`,
          message: 'must be a non-empty array',
        });
      }
    }
  }

  // ── guardrails ────────────────────────────────────────────────────────────
  const gr = config.guardrails;
  if (gr?.enabled && gr.rules) {
    const validActions = ['block', 'alert', 'require_approval', 'transform'];
    const validOperators = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'matches', 'exists', 'not_exists'];
    const ruleNames = new Set<string>();

    for (let i = 0; i < gr.rules.length; i++) {
      const rule = gr.rules[i];
      if (!rule) continue;

      if (!rule.name || typeof rule.name !== 'string') {
        errors.push({ path: `guardrails.rules[${i}].name`, message: 'must be a non-empty string' });
      } else if (ruleNames.has(rule.name)) {
        errors.push({ path: `guardrails.rules[${i}].name`, message: `duplicate rule name "${rule.name}"`, value: rule.name });
      } else {
        ruleNames.add(rule.name);
      }

      if (!rule.action || !validActions.includes(rule.action)) {
        errors.push({
          path: `guardrails.rules[${i}].action`,
          message: `must be one of: ${validActions.join(', ')}`,
          value: rule.action,
        });
      }

      if (rule.conditions) {
        for (let j = 0; j < rule.conditions.length; j++) {
          const cond = rule.conditions[j];
          if (!cond) continue;
          if (!cond.field || typeof cond.field !== 'string') {
            errors.push({ path: `guardrails.rules[${i}].conditions[${j}].field`, message: 'must be a non-empty string' });
          }
          if (!cond.operator || !validOperators.includes(cond.operator)) {
            errors.push({
              path: `guardrails.rules[${i}].conditions[${j}].operator`,
              message: `must be one of: ${validOperators.join(', ')}`,
              value: cond.operator,
            });
          }
          // Validate regex patterns at config time to prevent ReDoS at request time
          if (cond.operator === 'matches' && typeof cond.value === 'string') {
            try {
              new RegExp(cond.value);
            } catch (regexErr) {
              errors.push({
                path: `guardrails.rules[${i}].conditions[${j}].value`,
                message: `invalid regex pattern: ${regexErr instanceof Error ? regexErr.message : String(regexErr)}`,
                value: cond.value,
              });
            }
          }
        }
      }
    }
  }

  // ── servers ───────────────────────────────────────────────────────────────
  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    if (!server) continue;

    if (!server.id) {
      errors.push({ path: `servers[${i}].id`, message: 'must be non-empty' });
    } else if (!/^[a-zA-Z0-9-]+$/.test(server.id)) {
      errors.push({
        path: `servers[${i}].id`,
        message: 'must be alphanumeric with dashes only',
        value: server.id,
      });
    }

    const transport = server.transport ?? 'http';

    if (transport === 'stdio') {
      // Validation spécifique au transport stdio
      if (!server.command) {
        errors.push({
          path: `servers[${i}].command`,
          message: 'required when transport is "stdio"',
        });
      }
      if (server.replicas && server.replicas.length > 0) {
        errors.push({
          path: `servers[${i}].replicas`,
          message: 'replicas are not supported with stdio transport',
        });
      }
    } else {
      // Validation HTTP standard
      if (!server.url) {
        errors.push({ path: `servers[${i}].url`, message: 'must be a valid URL (got empty string)', value: '' });
      } else {
        try {
          new URL(server.url);
        } catch {
          errors.push({
            path: `servers[${i}].url`,
            message: 'must be a valid URL',
            value: server.url,
          });
        }
      }
    }

    if (transport !== 'http' && transport !== 'stdio') {
      errors.push({
        path: `servers[${i}].transport`,
        message: 'must be "http" or "stdio"',
        value: transport,
      });
    }

    if (server.cache.default_ttl < 0) {
      errors.push({
        path: `servers[${i}].cache.default_ttl`,
        message: 'must be >= 0 (use 0 to disable caching)',
        value: server.cache.default_ttl,
      });
    }

    if (server.cache.overrides) {
      for (const [toolName, override] of Object.entries(server.cache.overrides)) {
        if (override.ttl !== undefined && override.ttl < 0) {
          errors.push({
            path: `servers[${i}].cache.overrides.${toolName}.ttl`,
            message: 'must be >= 0',
            value: override.ttl,
          });
        }
      }
    }

    if (server.replicas) {
      for (let j = 0; j < server.replicas.length; j++) {
        const replicaUrl = server.replicas[j];
        try {
          if (replicaUrl) new URL(replicaUrl);
        } catch {
          errors.push({
            path: `servers[${i}].replicas[${j}]`,
            message: 'must be a valid URL',
            value: replicaUrl,
          });
        }
      }
    }
  }

  return errors;
}

/**
 * Formats a list of ConfigErrors into a human-readable string.
 */
export function formatConfigErrors(errors: ConfigError[]): string {
  const lines = ['[CONDUIT] Configuration errors:'];
  for (const err of errors) {
    const valuePart = err.value !== undefined ? ` (got: ${JSON.stringify(err.value)})` : '';
    lines.push(`  ✗ ${err.path}: ${err.message}${valuePart}`);
  }
  return lines.join('\n');
}

/**
 * Fusionne la configuration partielle avec les valeurs par défaut.
 * Effectue une fusion profonde pour les objets imbriqués.
 */
export function mergeWithDefaults(partial: Record<string, unknown>): ConduitGatewayConfig {
  const d = DEFAULT_GATEWAY_CONFIG;

  const gateway = mergeObject(d.gateway, partial['gateway'] as Partial<GatewayConfig> | undefined);
  const routerRaw = partial['router'] as Partial<RouterConfig & { health_check?: Record<string, unknown> }> | undefined;
  const router: RouterConfig = {
    namespace_strategy: routerRaw?.namespace_strategy ?? d.router.namespace_strategy,
    health_check: {
      ...d.router.health_check,
      ...(routerRaw?.health_check as Partial<RouterConfig['health_check']> | undefined ?? {}),
    },
    ...(routerRaw?.load_balancing !== undefined
      ? { load_balancing: routerRaw.load_balancing }
      : d.router.load_balancing !== undefined
        ? { load_balancing: d.router.load_balancing }
        : {}),
    ...(routerRaw?.circuit_breaker != null
      ? { circuit_breaker: routerRaw.circuit_breaker as RouterConfig['circuit_breaker'] & {} }
      : {}),
  };
  const cacheRaw = partial['cache'] as Partial<CacheConfig & { l1?: Record<string, unknown>; l2?: Record<string, unknown> }> | undefined;
  const cache: CacheConfig = {
    enabled: cacheRaw?.enabled ?? d.cache.enabled,
    l1: {
      ...d.cache.l1,
      ...(cacheRaw?.l1 as Partial<CacheConfig['l1']> | undefined ?? {}),
    },
    ...(cacheRaw?.l2 != null ? {
      l2: {
        enabled: (cacheRaw.l2 as Record<string, unknown>)['enabled'] !== false,
        redis_url: String((cacheRaw.l2 as Record<string, unknown>)['redis_url'] ?? ''),
        default_ttl_multiplier: Number((cacheRaw.l2 as Record<string, unknown>)['default_ttl_multiplier'] ?? 3),
        ...((cacheRaw.l2 as Record<string, unknown>)['key_prefix'] != null
          ? { key_prefix: String((cacheRaw.l2 as Record<string, unknown>)['key_prefix']) }
          : {}),
        ...((cacheRaw.l2 as Record<string, unknown>)['max_entry_size_kb'] != null
          ? { max_entry_size_kb: Number((cacheRaw.l2 as Record<string, unknown>)['max_entry_size_kb']) }
          : {}),
      },
    } : {}),
  };
  const tenantIsolation = mergeObject(
    d.tenant_isolation,
    partial['tenant_isolation'] as Partial<TenantIsolationConfig> | undefined,
  );
  const observability = mergeObject(
    d.observability,
    partial['observability'] as Partial<ObservabilityConfig> | undefined,
  );
  const metrics = mergeObject(d.metrics, partial['metrics'] as Partial<MetricsConfig> | undefined);

  // Normalisation des serveurs — ajout des valeurs par défaut du cache serveur
  const rawServers = partial['servers'];
  const servers: ServerConfig[] = Array.isArray(rawServers)
    ? (rawServers as Record<string, unknown>[]).map(normalizeServer)
    : d.servers;

  const authRaw = partial['auth'];
  const aclRaw = partial['acl'];
  const rateLimitsRaw = partial['rate_limits'];
  const adminRaw = partial['admin'];
  const guardrailsRaw = partial['guardrails'];

  return {
    gateway,
    router,
    servers,
    cache,
    tenant_isolation: tenantIsolation,
    observability,
    metrics,
    ...(authRaw !== undefined ? { auth: authRaw as ConduitGatewayConfig['auth'] & {} } : {}),
    ...(aclRaw !== undefined ? { acl: aclRaw as ConduitGatewayConfig['acl'] & {} } : {}),
    ...(rateLimitsRaw !== undefined ? { rate_limits: rateLimitsRaw as ConduitGatewayConfig['rate_limits'] & {} } : {}),
    ...(adminRaw !== undefined ? { admin: adminRaw as AdminConfig } : {}),
    ...(guardrailsRaw !== undefined ? { guardrails: guardrailsRaw as ConduitGatewayConfig['guardrails'] & {} } : {}),
  };
}

/** Fusion superficielle d'un objet avec ses valeurs par défaut */
function mergeObject<T extends object>(defaults: T, override: Partial<T> | undefined): T {
  if (!override) return { ...defaults };
  return { ...defaults, ...override };
}

/** Normalise la configuration d'un serveur depuis le YAML brut */
function normalizeServer(raw: Record<string, unknown>): ServerConfig {
  const cacheRaw = raw['cache'] as Record<string, unknown> | undefined;
  const rawOverrides = cacheRaw?.['overrides'] as ServerCacheConfig['overrides'] | undefined;
  const cache: ServerCacheConfig = {
    default_ttl: typeof cacheRaw?.['default_ttl'] === 'number' ? cacheRaw['default_ttl'] : 0,
    ...(rawOverrides !== undefined ? { overrides: rawOverrides } : {}),
  };

  const transport = raw['transport'] as string | undefined;

  const result: ServerConfig = {
    id: String(raw['id'] ?? ''),
    url: String(raw['url'] ?? ''),
    cache,
  };

  // Transport stdio fields
  if (transport === 'stdio') {
    result.transport = 'stdio';
    if (raw['command']) result.command = String(raw['command']);
    if (Array.isArray(raw['args'])) result.args = (raw['args'] as unknown[]).map(String);
    if (raw['env'] && typeof raw['env'] === 'object') {
      result.env = raw['env'] as Record<string, string>;
    }
    // Auto-generate URL identifier if missing
    if (!result.url && result.command) {
      result.url = `stdio://${result.command}`;
    }
  }

  if (raw['timeout_ms'] !== undefined) {
    result.timeout_ms = Number(raw['timeout_ms']);
  }

  const replicas = raw['replicas'];
  if (Array.isArray(replicas)) {
    result.replicas = replicas.map(String);
  }

  return result;
}
