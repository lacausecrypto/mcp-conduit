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
  ConnectConfig,
  ConnectManagedRuntimeConfig,
  ConnectProfileConfig,
  ConnectRegistryConfig,
  IdentityConfig,
  IdentityWorkspaceConfig,
  GovernanceConfig,
  GovernanceRoleBindingConfig,
  GovernanceToolPolicyConfig,
  GovernanceRegistryPolicyConfig,
  GovernanceWorkspaceQuotaConfig,
  WorkspaceRole,
  UpstreamAuthConfig,
  ManagedRuntimeServerConfig,
} from './types.js';

/** Valeurs par défaut de la configuration */
export const DEFAULT_GATEWAY_CONFIG: ConduitGatewayConfig = {
  gateway: {
    port: 8080,
    host: '127.0.0.1',
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
  connect: {
    managed_runtime: {
      enabled: true,
      root_dir: './.conduit/runtime',
      default_channel: 'stable',
      sanitize_env: true,
      auto_rollback: true,
    },
  },
  identity: {
    enabled: false,
    db_path: './conduit-identity.db',
    default_workspace_id: 'default',
    workspaces: [],
  },
  governance: {
    enabled: false,
    db_path: './conduit-governance.db',
    registry_default_action: 'allow',
    role_bindings: [],
    tool_policies: [],
    registry_policies: [],
    quotas: {
      workspaces: [],
    },
    approvals: {
      enabled: true,
      ttl_seconds: 3600,
      required_roles: ['owner', 'admin', 'approver'],
      allow_self_approval: false,
    },
  },
};

/**
 * Returns true when the host string targets a loopback interface only.
 * Used by admin.key validation to decide whether unauthenticated admin API
 * exposure is acceptable (loopback) or unsafe (any other interface).
 */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase();
  if (normalized === '') return false;
  if (normalized === 'localhost') return true;
  if (normalized === '127.0.0.1') return true;
  if (normalized === '::1' || normalized === '[::1]') return true;
  if (normalized.startsWith('127.')) return true;
  return false;
}

/**
 * Validates all configuration values and returns a list of errors.
 * Returns an empty array if the configuration is valid.
 * Does NOT throw — callers decide how to handle errors.
 */
export function validateConfig(config: ConduitGatewayConfig): ConfigError[] {
  const errors: ConfigError[] = [];
  const { gateway, router, cache, observability, metrics, servers } = config;
  const identity = config.identity;
  const governance = config.governance;

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

  // ── admin.key — required when bound to a non-loopback host ────────────────
  // The admin API mutates state (servers, configs, secrets). Allowing
  // unauthenticated access on an externally-reachable interface lets any
  // network peer reconfigure the gateway. Refuse to start unless the
  // operator explicitly opts in via admin.allow_unauthenticated = true.
  if (
    !config.admin?.key &&
    !isLoopbackHost(config.gateway.host) &&
    config.admin?.allow_unauthenticated !== true
  ) {
    errors.push({
      path: 'admin.key',
      message:
        `required when gateway.host is not loopback ("${config.gateway.host}"). ` +
        'Set admin.key (or CONDUIT_ADMIN_KEY) to a strong secret, or set ' +
        'admin.allow_unauthenticated=true to acknowledge an unauthenticated admin API.',
    });
  }

  // ── identity ──────────────────────────────────────────────────────────────
  if (identity?.enabled) {
    if (identity.db_path !== undefined && typeof identity.db_path !== 'string') {
      errors.push({
        path: 'identity.db_path',
        message: 'must be a string',
        value: identity.db_path,
      });
    }

    if (identity.default_workspace_id !== undefined && !/^[a-zA-Z0-9-]+$/.test(identity.default_workspace_id)) {
      errors.push({
        path: 'identity.default_workspace_id',
        message: 'must be alphanumeric with dashes only',
        value: identity.default_workspace_id,
      });
    }

    const workspaces = identity.workspaces ?? [];
    const workspaceIds = new Set<string>();
    const claimedTenants = new Set<string>();

    for (let i = 0; i < workspaces.length; i++) {
      const workspace = workspaces[i];
      if (!workspace) continue;

      if (!workspace.id || !/^[a-zA-Z0-9-]+$/.test(workspace.id)) {
        errors.push({
          path: `identity.workspaces[${i}].id`,
          message: 'must be alphanumeric with dashes only',
          value: workspace.id,
        });
      } else if (workspaceIds.has(workspace.id)) {
        errors.push({
          path: `identity.workspaces[${i}].id`,
          message: `duplicate workspace id "${workspace.id}"`,
          value: workspace.id,
        });
      } else {
        workspaceIds.add(workspace.id);
      }

      if (workspace.tenant_ids) {
        for (let j = 0; j < workspace.tenant_ids.length; j++) {
          const tenantId = workspace.tenant_ids[j];
          if (!tenantId || typeof tenantId !== 'string') {
            errors.push({
              path: `identity.workspaces[${i}].tenant_ids[${j}]`,
              message: 'must be a non-empty string',
              value: tenantId,
            });
            continue;
          }
          if (claimedTenants.has(tenantId)) {
            errors.push({
              path: `identity.workspaces[${i}].tenant_ids[${j}]`,
              message: `tenant "${tenantId}" is already mapped to another workspace`,
              value: tenantId,
            });
          } else {
            claimedTenants.add(tenantId);
          }
        }
      }
    }
  }

  // ── governance ────────────────────────────────────────────────────────────
  if (governance?.enabled) {
    const validRoles = ['owner', 'admin', 'approver', 'operator', 'developer', 'viewer'];
    const validPolicyEffects = ['allow', 'deny', 'require_approval'];
    const validRegistryEffects = ['allow', 'deny'];

    if (governance.db_path !== undefined && typeof governance.db_path !== 'string') {
      errors.push({
        path: 'governance.db_path',
        message: 'must be a string',
        value: governance.db_path,
      });
    }

    if (
      governance.registry_default_action !== undefined &&
      !['allow', 'deny'].includes(governance.registry_default_action)
    ) {
      errors.push({
        path: 'governance.registry_default_action',
        message: 'must be one of: allow, deny',
        value: governance.registry_default_action,
      });
    }

    const roleBindings = governance.role_bindings ?? [];
    for (let i = 0; i < roleBindings.length; i++) {
      const binding = roleBindings[i];
      if (!binding) continue;
      if (!binding.workspace_id || !/^[a-zA-Z0-9-]+$/.test(binding.workspace_id)) {
        errors.push({
          path: `governance.role_bindings[${i}].workspace_id`,
          message: 'must be alphanumeric with dashes only',
          value: binding.workspace_id,
        });
      }
      if (!validRoles.includes(binding.role)) {
        errors.push({
          path: `governance.role_bindings[${i}].role`,
          message: `must be one of: ${validRoles.join(', ')}`,
          value: binding.role,
        });
      }
      if (!binding.clients || binding.clients.length === 0) {
        errors.push({
          path: `governance.role_bindings[${i}].clients`,
          message: 'must be a non-empty array',
        });
      }
    }

    const toolPolicyNames = new Set<string>();
    const toolPolicies = governance.tool_policies ?? [];
    for (let i = 0; i < toolPolicies.length; i++) {
      const policy = toolPolicies[i];
      if (!policy) continue;
      if (!policy.name) {
        errors.push({ path: `governance.tool_policies[${i}].name`, message: 'must be a non-empty string' });
      } else if (toolPolicyNames.has(policy.name)) {
        errors.push({ path: `governance.tool_policies[${i}].name`, message: `duplicate policy name "${policy.name}"`, value: policy.name });
      } else {
        toolPolicyNames.add(policy.name);
      }
      if (!validPolicyEffects.includes(policy.effect)) {
        errors.push({
          path: `governance.tool_policies[${i}].effect`,
          message: `must be one of: ${validPolicyEffects.join(', ')}`,
          value: policy.effect,
        });
      }
      if (policy.roles?.some((role) => !validRoles.includes(role))) {
        errors.push({
          path: `governance.tool_policies[${i}].roles`,
          message: `must contain only: ${validRoles.join(', ')}`,
          value: policy.roles,
        });
      }
    }

    const registryPolicyNames = new Set<string>();
    const registryPolicies = governance.registry_policies ?? [];
    for (let i = 0; i < registryPolicies.length; i++) {
      const policy = registryPolicies[i];
      if (!policy) continue;
      if (!policy.name) {
        errors.push({ path: `governance.registry_policies[${i}].name`, message: 'must be a non-empty string' });
      } else if (registryPolicyNames.has(policy.name)) {
        errors.push({ path: `governance.registry_policies[${i}].name`, message: `duplicate policy name "${policy.name}"`, value: policy.name });
      } else {
        registryPolicyNames.add(policy.name);
      }
      if (!validRegistryEffects.includes(policy.effect)) {
        errors.push({
          path: `governance.registry_policies[${i}].effect`,
          message: `must be one of: ${validRegistryEffects.join(', ')}`,
          value: policy.effect,
        });
      }
      if (policy.roles?.some((role) => !validRoles.includes(role))) {
        errors.push({
          path: `governance.registry_policies[${i}].roles`,
          message: `must contain only: ${validRoles.join(', ')}`,
          value: policy.roles,
        });
      }
    }

    const workspaceQuotas = governance.quotas?.workspaces ?? [];
    for (let i = 0; i < workspaceQuotas.length; i++) {
      const quota = workspaceQuotas[i];
      if (!quota) continue;
      if (!quota.workspace_id || !/^[a-zA-Z0-9-]+$/.test(quota.workspace_id)) {
        errors.push({
          path: `governance.quotas.workspaces[${i}].workspace_id`,
          message: 'must be alphanumeric with dashes only',
          value: quota.workspace_id,
        });
      }
      for (const key of ['requests_per_minute', 'requests_per_hour', 'requests_per_day'] as const) {
        if (quota[key] !== undefined && quota[key]! <= 0) {
          errors.push({
            path: `governance.quotas.workspaces[${i}].${key}`,
            message: 'must be greater than 0',
            value: quota[key],
          });
        }
      }
    }

    const defaultQuota = governance.quotas?.default;
    if (defaultQuota) {
      for (const key of ['requests_per_minute', 'requests_per_hour', 'requests_per_day'] as const) {
        if (defaultQuota[key] !== undefined && defaultQuota[key]! <= 0) {
          errors.push({
            path: `governance.quotas.default.${key}`,
            message: 'must be greater than 0',
            value: defaultQuota[key],
          });
        }
      }
    }

    const approvals = governance.approvals;
    if (approvals?.ttl_seconds !== undefined && approvals.ttl_seconds <= 0) {
      errors.push({
        path: 'governance.approvals.ttl_seconds',
        message: 'must be greater than 0',
        value: approvals.ttl_seconds,
      });
    }
    if (approvals?.required_roles?.some((role) => !validRoles.includes(role))) {
      errors.push({
        path: 'governance.approvals.required_roles',
        message: `must contain only: ${validRoles.join(', ')}`,
        value: approvals?.required_roles,
      });
    }
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
      if (server.managed_runtime?.enabled) {
        if (!server.managed_runtime.source_ref) {
          errors.push({
            path: `servers[${i}].managed_runtime.source_ref`,
            message: 'required when managed_runtime is enabled',
          });
        }
        if (!server.managed_runtime.active_release_id) {
          errors.push({
            path: `servers[${i}].managed_runtime.active_release_id`,
            message: 'required when managed_runtime is enabled',
          });
        }
        if (!Array.isArray(server.managed_runtime.releases) || server.managed_runtime.releases.length === 0) {
          errors.push({
            path: `servers[${i}].managed_runtime.releases`,
            message: 'must contain at least one release when managed_runtime is enabled',
          });
        }
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

    if (server.headers) {
      for (const [headerName, headerValue] of Object.entries(server.headers)) {
        if (typeof headerName !== 'string' || headerName.trim().length === 0) {
          errors.push({
            path: `servers[${i}].headers`,
            message: 'header names must be non-empty strings',
            value: headerName,
          });
        }
        if (typeof headerValue !== 'string') {
          errors.push({
            path: `servers[${i}].headers.${headerName}`,
            message: 'header values must be strings',
            value: headerValue,
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

    if (server.managed_runtime && transport !== 'stdio') {
      errors.push({
        path: `servers[${i}].managed_runtime`,
        message: 'managed_runtime is only supported for stdio transport',
      });
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

    if (server.upstream_auth?.connected_account) {
      const connected = server.upstream_auth.connected_account;
      if (!connected.provider || typeof connected.provider !== 'string') {
        errors.push({
          path: `servers[${i}].upstream_auth.connected_account.provider`,
          message: 'must be a non-empty string',
          value: connected.provider,
        });
      }

      const validBindings = ['client', 'tenant', 'workspace', 'client-or-workspace'];
      if (connected.binding !== undefined && !validBindings.includes(connected.binding)) {
        errors.push({
          path: `servers[${i}].upstream_auth.connected_account.binding`,
          message: `must be one of: ${validBindings.join(', ')}`,
          value: connected.binding,
        });
      }
    }

    if (server.upstream_auth?.forward_identity) {
      const validModes = ['none', 'bearer', 'claims-header'];
      if (
        server.upstream_auth.forward_identity.mode !== undefined &&
        !validModes.includes(server.upstream_auth.forward_identity.mode)
      ) {
        errors.push({
          path: `servers[${i}].upstream_auth.forward_identity.mode`,
          message: `must be one of: ${validModes.join(', ')}`,
          value: server.upstream_auth.forward_identity.mode,
        });
      }
    }
  }

  // ── connect.profiles ──────────────────────────────────────────────────────
  const connectProfiles = config.connect?.profiles ?? [];
  const connectRegistry = config.connect?.registry;
  if (!Array.isArray(connectProfiles)) {
    errors.push({
      path: 'connect.profiles',
      message: 'must be an array',
      value: connectProfiles,
    });
  } else {
    const profileIds = new Set<string>();
    const knownServerIds = new Set(servers.map((server) => server.id));

    for (let i = 0; i < connectProfiles.length; i++) {
      const profile = connectProfiles[i];
      if (!profile) continue;

      if (!profile.id || typeof profile.id !== 'string') {
        errors.push({ path: `connect.profiles[${i}].id`, message: 'must be a non-empty string' });
      } else if (!/^[a-zA-Z0-9-]+$/.test(profile.id)) {
        errors.push({
          path: `connect.profiles[${i}].id`,
          message: 'must be alphanumeric with dashes only',
          value: profile.id,
        });
      } else if (profile.id === 'default') {
        errors.push({
          path: `connect.profiles[${i}].id`,
          message: '"default" is reserved for the built-in profile',
          value: profile.id,
        });
      } else if (profileIds.has(profile.id)) {
        errors.push({
          path: `connect.profiles[${i}].id`,
          message: `duplicate connect profile "${profile.id}"`,
          value: profile.id,
        });
      } else {
        profileIds.add(profile.id);
      }

      if (!Array.isArray(profile.server_ids) || profile.server_ids.length === 0) {
        errors.push({
          path: `connect.profiles[${i}].server_ids`,
          message: 'must be a non-empty array',
          value: profile.server_ids,
        });
      } else {
        for (let j = 0; j < profile.server_ids.length; j++) {
          const serverId = profile.server_ids[j];
          if (typeof serverId !== 'string' || serverId.length === 0) {
            errors.push({
              path: `connect.profiles[${i}].server_ids[${j}]`,
              message: 'must be a non-empty string',
              value: serverId,
            });
            continue;
          }

          if (!knownServerIds.has(serverId)) {
            errors.push({
              path: `connect.profiles[${i}].server_ids[${j}]`,
              message: `unknown server id "${serverId}"`,
              value: serverId,
            });
          }
        }
      }
    }
  }

  if (connectRegistry) {
    if (connectRegistry.base_url !== undefined) {
      try {
        const parsed = new URL(connectRegistry.base_url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push({
            path: 'connect.registry.base_url',
            message: 'must use http or https',
            value: connectRegistry.base_url,
          });
        }
      } catch {
        errors.push({
          path: 'connect.registry.base_url',
          message: 'must be a valid absolute URL',
          value: connectRegistry.base_url,
        });
      }
    }

    if (connectRegistry.cache_ttl_seconds !== undefined && connectRegistry.cache_ttl_seconds < 1) {
      errors.push({
        path: 'connect.registry.cache_ttl_seconds',
        message: 'must be greater than 0',
        value: connectRegistry.cache_ttl_seconds,
      });
    }

    if (connectRegistry.page_size !== undefined && (!Number.isInteger(connectRegistry.page_size) || connectRegistry.page_size < 1 || connectRegistry.page_size > 200)) {
      errors.push({
        path: 'connect.registry.page_size',
        message: 'must be an integer between 1 and 200',
        value: connectRegistry.page_size,
      });
    }

    if (connectRegistry.max_pages !== undefined && (!Number.isInteger(connectRegistry.max_pages) || connectRegistry.max_pages < 0 || connectRegistry.max_pages > 1000)) {
      errors.push({
        path: 'connect.registry.max_pages',
        message: 'must be an integer between 0 and 1000',
        value: connectRegistry.max_pages,
      });
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
  const connectRaw = partial['connect'];
  const identityRaw = partial['identity'];
  const governanceRaw = partial['governance'];
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
    ...(connectRaw !== undefined ? { connect: normalizeConnectConfig(connectRaw as Record<string, unknown>) } : {}),
    ...(identityRaw !== undefined ? { identity: normalizeIdentityConfig(identityRaw as Record<string, unknown>) } : d.identity ? { identity: { ...d.identity } } : {}),
    ...(governanceRaw !== undefined ? { governance: normalizeGovernanceConfig(governanceRaw as Record<string, unknown>) } : d.governance ? { governance: { ...d.governance } } : {}),
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

  if (raw['headers'] && typeof raw['headers'] === 'object' && !Array.isArray(raw['headers'])) {
    result.headers = Object.fromEntries(
      Object.entries(raw['headers'] as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    );
  }

  if (raw['timeout_ms'] !== undefined) {
    result.timeout_ms = Number(raw['timeout_ms']);
  }

  const replicas = raw['replicas'];
  if (Array.isArray(replicas)) {
    result.replicas = replicas.map(String);
  }

  const upstreamAuthRaw = raw['upstream_auth'];
  if (upstreamAuthRaw && typeof upstreamAuthRaw === 'object' && !Array.isArray(upstreamAuthRaw)) {
    result.upstream_auth = normalizeUpstreamAuth(upstreamAuthRaw as Record<string, unknown>);
  }

  if (raw['forward_authorization'] === true) {
    result.forward_authorization = true;
  }

  const managedRuntimeRaw = raw['managed_runtime'];
  if (managedRuntimeRaw && typeof managedRuntimeRaw === 'object' && !Array.isArray(managedRuntimeRaw)) {
    result.managed_runtime = normalizeManagedRuntimeServer(managedRuntimeRaw as Record<string, unknown>);
  }

  return result;
}

function normalizeConnectConfig(raw: Record<string, unknown>): ConnectConfig {
  const rawProfiles = raw['profiles'];
  const profiles = Array.isArray(rawProfiles)
    ? rawProfiles
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map(normalizeConnectProfile)
    : undefined;
  const rawRegistry = raw['registry'];
  const registry = rawRegistry && typeof rawRegistry === 'object' && !Array.isArray(rawRegistry)
    ? normalizeConnectRegistry(rawRegistry as Record<string, unknown>)
    : undefined;
  const rawManagedRuntime = raw['managed_runtime'];
  const managedRuntime = rawManagedRuntime && typeof rawManagedRuntime === 'object' && !Array.isArray(rawManagedRuntime)
    ? normalizeConnectManagedRuntime(rawManagedRuntime as Record<string, unknown>)
    : undefined;

  return {
    ...(profiles !== undefined ? { profiles } : {}),
    ...(registry !== undefined ? { registry } : {}),
    ...(managedRuntime !== undefined ? { managed_runtime: managedRuntime } : {}),
  };
}

function normalizeConnectProfile(raw: Record<string, unknown>): ConnectProfileConfig {
  const result: ConnectProfileConfig = {
    id: String(raw['id'] ?? ''),
    server_ids: Array.isArray(raw['server_ids']) ? raw['server_ids'].map(String) : [],
  };

  if (raw['label'] !== undefined) {
    result.label = String(raw['label']);
  }

  if (raw['description'] !== undefined) {
    result.description = String(raw['description']);
  }

  return result;
}

function normalizeConnectRegistry(raw: Record<string, unknown>): ConnectRegistryConfig {
  const result: ConnectRegistryConfig = {};

  if (raw['base_url'] !== undefined) {
    result.base_url = String(raw['base_url']);
  }

  if (raw['cache_ttl_seconds'] !== undefined) {
    result.cache_ttl_seconds = Number(raw['cache_ttl_seconds']);
  }

  if (raw['page_size'] !== undefined) {
    result.page_size = Number(raw['page_size']);
  }

  if (raw['max_pages'] !== undefined) {
    result.max_pages = Number(raw['max_pages']);
  }

  if (raw['latest_only'] !== undefined) {
    result.latest_only = raw['latest_only'] !== false;
  }

  return result;
}

function normalizeConnectManagedRuntime(raw: Record<string, unknown>): ConnectManagedRuntimeConfig {
  const result: ConnectManagedRuntimeConfig = {};

  if (raw['enabled'] !== undefined) {
    result.enabled = raw['enabled'] !== false;
  }

  if (raw['root_dir'] !== undefined) {
    result.root_dir = String(raw['root_dir']);
  }

  if (raw['default_channel'] !== undefined) {
    result.default_channel = String(raw['default_channel']) as NonNullable<ConnectManagedRuntimeConfig['default_channel']>;
  }

  if (raw['sanitize_env'] !== undefined) {
    result.sanitize_env = raw['sanitize_env'] !== false;
  }

  if (raw['auto_rollback'] !== undefined) {
    result.auto_rollback = raw['auto_rollback'] !== false;
  }

  return result;
}

function normalizeManagedRuntimeServer(raw: Record<string, unknown>): ManagedRuntimeServerConfig {
  const releasesRaw = Array.isArray(raw['releases']) ? raw['releases'] : [];
  const releases = releasesRaw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const release: ManagedRuntimeServerConfig['releases'][number] = {
        id: String(item['id'] ?? ''),
        version: String(item['version'] ?? ''),
        channel: String(item['channel'] ?? 'stable') as ManagedRuntimeServerConfig['channel'],
        command: String(item['command'] ?? ''),
        created_at: String(item['created_at'] ?? ''),
      };
      if (Array.isArray(item['args'])) release.args = item['args'].map(String);
      if (item['env'] && typeof item['env'] === 'object' && !Array.isArray(item['env'])) {
        release.env = Object.fromEntries(
          Object.entries(item['env'] as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
        );
      }
      if (item['status'] !== undefined) {
        release.status = String(item['status']) as NonNullable<ManagedRuntimeServerConfig['releases'][number]['status']>;
      }
      if (item['notes'] !== undefined) release.notes = String(item['notes']);
      return release;
    });

  const result: ManagedRuntimeServerConfig = {
    enabled: raw['enabled'] !== false,
    source_type: String(raw['source_type'] ?? 'command') as ManagedRuntimeServerConfig['source_type'],
    source_ref: String(raw['source_ref'] ?? ''),
    channel: String(raw['channel'] ?? 'stable') as ManagedRuntimeServerConfig['channel'],
    active_release_id: String(raw['active_release_id'] ?? ''),
    releases,
  };

  if (raw['last_healthy_release_id'] !== undefined) {
    result.last_healthy_release_id = String(raw['last_healthy_release_id']);
  }

  if (raw['last_rollout_at'] !== undefined) {
    result.last_rollout_at = String(raw['last_rollout_at']);
  }

  const sandboxRaw = raw['sandbox'];
  if (sandboxRaw && typeof sandboxRaw === 'object' && !Array.isArray(sandboxRaw)) {
    const sandbox = sandboxRaw as Record<string, unknown>;
    result.sandbox = {
      ...(sandbox['enabled'] !== undefined ? { enabled: sandbox['enabled'] !== false } : {}),
      ...(sandbox['root_dir'] !== undefined ? { root_dir: String(sandbox['root_dir']) } : {}),
      ...(sandbox['sanitize_env'] !== undefined ? { sanitize_env: sandbox['sanitize_env'] !== false } : {}),
      ...(sandbox['allow_network'] !== undefined ? { allow_network: sandbox['allow_network'] !== false } : {}),
    };
  }

  const healthGateRaw = raw['health_gate'];
  if (healthGateRaw && typeof healthGateRaw === 'object' && !Array.isArray(healthGateRaw)) {
    const healthGate = healthGateRaw as Record<string, unknown>;
    result.health_gate = {
      ...(healthGate['enabled'] !== undefined ? { enabled: healthGate['enabled'] !== false } : {}),
      ...(healthGate['auto_rollback'] !== undefined ? { auto_rollback: healthGate['auto_rollback'] !== false } : {}),
    };
  }

  return result;
}

function normalizeIdentityConfig(raw: Record<string, unknown>): IdentityConfig {
  const workspacesRaw = raw['workspaces'];
  const workspaces = Array.isArray(workspacesRaw)
    ? workspacesRaw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map(normalizeIdentityWorkspace)
    : [];

  const result: IdentityConfig = {
    enabled: raw['enabled'] !== false,
    workspaces,
  };

  if (raw['db_path'] !== undefined) {
    result.db_path = String(raw['db_path']);
  }

  if (raw['default_workspace_id'] !== undefined) {
    result.default_workspace_id = String(raw['default_workspace_id']);
  }

  return result;
}

function normalizeGovernanceConfig(raw: Record<string, unknown>): GovernanceConfig {
  const result: GovernanceConfig = {
    enabled: raw['enabled'] !== false,
  };

  if (raw['db_path'] !== undefined) {
    result.db_path = String(raw['db_path']);
  }
  if (raw['registry_default_action'] !== undefined) {
    const registryDefaultAction = String(raw['registry_default_action']);
    if (registryDefaultAction === 'allow' || registryDefaultAction === 'deny') {
      result.registry_default_action = registryDefaultAction;
    }
  }

  if (Array.isArray(raw['role_bindings'])) {
    result.role_bindings = raw['role_bindings']
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map(normalizeGovernanceRoleBinding);
  }

  if (Array.isArray(raw['tool_policies'])) {
    result.tool_policies = raw['tool_policies']
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map(normalizeGovernanceToolPolicy);
  }

  if (Array.isArray(raw['registry_policies'])) {
    result.registry_policies = raw['registry_policies']
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map(normalizeGovernanceRegistryPolicy);
  }

  const quotasRaw = raw['quotas'];
  if (quotasRaw && typeof quotasRaw === 'object' && !Array.isArray(quotasRaw)) {
    const quotas: NonNullable<GovernanceConfig['quotas']> = {};
    const defaultRaw = (quotasRaw as Record<string, unknown>)['default'];
    if (defaultRaw && typeof defaultRaw === 'object' && !Array.isArray(defaultRaw)) {
      quotas.default = normalizeToolRateLimit(defaultRaw as Record<string, unknown>);
    }
    const workspacesRaw = (quotasRaw as Record<string, unknown>)['workspaces'];
    if (Array.isArray(workspacesRaw)) {
      quotas.workspaces = workspacesRaw
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        .map(normalizeGovernanceWorkspaceQuota);
    }
    result.quotas = quotas;
  }

  const approvalsRaw = raw['approvals'];
  if (approvalsRaw && typeof approvalsRaw === 'object' && !Array.isArray(approvalsRaw)) {
    result.approvals = {
      ...((approvalsRaw as Record<string, unknown>)['enabled'] !== undefined
        ? { enabled: (approvalsRaw as Record<string, unknown>)['enabled'] !== false }
        : {}),
      ...((approvalsRaw as Record<string, unknown>)['ttl_seconds'] !== undefined
        ? { ttl_seconds: Number((approvalsRaw as Record<string, unknown>)['ttl_seconds']) }
        : {}),
      ...(Array.isArray((approvalsRaw as Record<string, unknown>)['required_roles'])
        ? { required_roles: ((approvalsRaw as Record<string, unknown>)['required_roles'] as unknown[]).map(String) as WorkspaceRole[] }
        : {}),
      ...((approvalsRaw as Record<string, unknown>)['allow_self_approval'] !== undefined
        ? { allow_self_approval: (approvalsRaw as Record<string, unknown>)['allow_self_approval'] === true }
        : {}),
    };
  }

  return result;
}

function normalizeGovernanceRoleBinding(raw: Record<string, unknown>): GovernanceRoleBindingConfig {
  return {
    workspace_id: String(raw['workspace_id'] ?? ''),
    role: String(raw['role'] ?? '') as GovernanceRoleBindingConfig['role'],
    clients: Array.isArray(raw['clients']) ? raw['clients'].map(String) : [],
  };
}

function normalizeGovernanceToolPolicy(raw: Record<string, unknown>): GovernanceToolPolicyConfig {
  const result: GovernanceToolPolicyConfig = {
    name: String(raw['name'] ?? ''),
    effect: String(raw['effect'] ?? 'deny') as GovernanceToolPolicyConfig['effect'],
  };
  if (Array.isArray(raw['workspace_ids'])) result.workspace_ids = raw['workspace_ids'].map(String);
  if (Array.isArray(raw['roles'])) result.roles = raw['roles'].map(String) as WorkspaceRole[];
  if (Array.isArray(raw['clients'])) result.clients = raw['clients'].map(String);
  if (Array.isArray(raw['servers'])) result.servers = raw['servers'].map(String);
  if (Array.isArray(raw['tools'])) result.tools = raw['tools'].map(String);
  if (raw['reason'] !== undefined) result.reason = String(raw['reason']);
  return result;
}

function normalizeGovernanceRegistryPolicy(raw: Record<string, unknown>): GovernanceRegistryPolicyConfig {
  const result: GovernanceRegistryPolicyConfig = {
    name: String(raw['name'] ?? ''),
    effect: String(raw['effect'] ?? 'deny') as GovernanceRegistryPolicyConfig['effect'],
  };
  if (Array.isArray(raw['workspace_ids'])) result.workspace_ids = raw['workspace_ids'].map(String);
  if (Array.isArray(raw['roles'])) result.roles = raw['roles'].map(String) as WorkspaceRole[];
  if (Array.isArray(raw['clients'])) result.clients = raw['clients'].map(String);
  if (Array.isArray(raw['server_names'])) result.server_names = raw['server_names'].map(String);
  if (Array.isArray(raw['package_types'])) result.package_types = raw['package_types'].map(String);
  if (Array.isArray(raw['install_modes'])) result.install_modes = raw['install_modes'].map(String);
  if (raw['reason'] !== undefined) result.reason = String(raw['reason']);
  return result;
}

function normalizeGovernanceWorkspaceQuota(raw: Record<string, unknown>): GovernanceWorkspaceQuotaConfig {
  return {
    workspace_id: String(raw['workspace_id'] ?? ''),
    ...normalizeToolRateLimit(raw),
  };
}

function normalizeToolRateLimit(raw: Record<string, unknown>): {
  requests_per_minute?: number;
  requests_per_hour?: number;
  requests_per_day?: number;
} {
  return {
    ...(raw['requests_per_minute'] !== undefined ? { requests_per_minute: Number(raw['requests_per_minute']) } : {}),
    ...(raw['requests_per_hour'] !== undefined ? { requests_per_hour: Number(raw['requests_per_hour']) } : {}),
    ...(raw['requests_per_day'] !== undefined ? { requests_per_day: Number(raw['requests_per_day']) } : {}),
  };
}

function normalizeIdentityWorkspace(raw: Record<string, unknown>): IdentityWorkspaceConfig {
  const result: IdentityWorkspaceConfig = {
    id: String(raw['id'] ?? ''),
  };

  if (raw['label'] !== undefined) {
    result.label = String(raw['label']);
  }

  if (Array.isArray(raw['tenant_ids'])) {
    result.tenant_ids = raw['tenant_ids'].map(String);
  }

  return result;
}

function normalizeUpstreamAuth(raw: Record<string, unknown>): UpstreamAuthConfig {
  const result: UpstreamAuthConfig = {};

  const connectedRaw = raw['connected_account'];
  if (connectedRaw && typeof connectedRaw === 'object' && !Array.isArray(connectedRaw)) {
    const headers = (connectedRaw as Record<string, unknown>)['headers'];
    const connectedAccount: NonNullable<UpstreamAuthConfig['connected_account']> = {
      provider: String((connectedRaw as Record<string, unknown>)['provider'] ?? ''),
    };
    if ((connectedRaw as Record<string, unknown>)['binding'] !== undefined) {
      connectedAccount.binding = (
        String((connectedRaw as Record<string, unknown>)['binding'])
      ) as NonNullable<NonNullable<UpstreamAuthConfig['connected_account']>['binding']>;
    }
    if ((connectedRaw as Record<string, unknown>)['required'] !== undefined) {
      connectedAccount.required = (connectedRaw as Record<string, unknown>)['required'] !== false;
    }
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
      connectedAccount.headers = Object.fromEntries(
        Object.entries(headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
      );
    }
    result.connected_account = connectedAccount;
  }

  const forwardRaw = raw['forward_identity'];
  if (forwardRaw && typeof forwardRaw === 'object' && !Array.isArray(forwardRaw)) {
    const forwardIdentity: NonNullable<UpstreamAuthConfig['forward_identity']> = {};
    if ((forwardRaw as Record<string, unknown>)['mode'] !== undefined) {
      forwardIdentity.mode = (
        String((forwardRaw as Record<string, unknown>)['mode'])
      ) as NonNullable<NonNullable<UpstreamAuthConfig['forward_identity']>['mode']>;
    }
    if ((forwardRaw as Record<string, unknown>)['header_name'] !== undefined) {
      forwardIdentity.header_name = String((forwardRaw as Record<string, unknown>)['header_name']);
    }
    result.forward_identity = forwardIdentity;
  }

  return result;
}
