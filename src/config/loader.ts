/**
 * Chargement et validation de la configuration YAML de la passerelle.
 * Fusionne la configuration fichier avec les valeurs par défaut.
 *
 * Environment variables (override everything, including the config file):
 *
 *   CONDUIT_CONFIG        — path to the YAML config file (default: conduit.config.yml)
 *   CONDUIT_PORT          — gateway HTTP port (overrides gateway.port)
 *   CONDUIT_HOST          — gateway bind address (overrides gateway.host)
 *   CONDUIT_DB_PATH       — SQLite log database path (overrides observability.db_path)
 *   CONDUIT_METRICS_PORT  — Prometheus metrics port (overrides metrics.port)
 *   CONDUIT_ADMIN_KEY     — Admin API bearer token (overrides admin.key)
 *   CONDUIT_LOG_ARGS      — "false" to disable argument logging (overrides observability.log_args)
 *   CONDUIT_TLS_ENABLED   — "true"/"false" (overrides gateway.tls.enabled)
 *   CONDUIT_TLS_CERT      — path to TLS certificate PEM (overrides gateway.tls.cert_path)
 *   CONDUIT_TLS_KEY       — path to TLS private key PEM (overrides gateway.tls.key_path)
 *   CONDUIT_REDIS_URL     — Redis connection URL (overrides rate_limits.redis_url)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { mergeWithDefaults, validateConfig, formatConfigErrors } from './schema.js';
import type { ConduitGatewayConfig } from './types.js';

/**
 * Charge la configuration depuis un fichier YAML.
 *
 * @param configPath - Chemin vers le fichier de configuration YAML
 * @returns Configuration fusionnée avec les valeurs par défaut
 */
export function loadConfig(configPath: string): ConduitGatewayConfig {
  const absolutePath = resolve(configPath);

  let rawContent: string;
  try {
    rawContent = readFileSync(absolutePath, 'utf-8');
  } catch (error) {
    throw new Error(`Impossible de lire le fichier de configuration : ${absolutePath}\n${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = yamlLoad(rawContent);
  } catch (error) {
    // js-yaml includes line/column in the error message for malformed YAML
    throw new Error(`Erreur de parsing YAML dans ${absolutePath}\n${String(error)}`);
  }

  if (parsed === null || parsed === undefined) {
    // Empty file — use defaults
    parsed = {};
  }

  if (typeof parsed !== 'object') {
    throw new Error(`Le fichier de configuration doit être un objet YAML valide`);
  }

  warnUnknownKeys(parsed as Record<string, unknown>);
  const config = mergeWithDefaults(parsed as Record<string, unknown>);
  applyEnvOverrides(config);
  throwIfInvalid(config);
  return config;
}

/**
 * Charge la configuration depuis les variables d'environnement ou le fichier par défaut.
 * Si le fichier de configuration n'existe pas, démarre avec les valeurs par défaut
 * (utile pour les environnements conteneurisés où la config vient des env vars).
 */
export function loadConfigFromEnv(): ConduitGatewayConfig {
  const configPath = process.env['CONDUIT_CONFIG'] ?? 'conduit.config.yml';
  const absolutePath = resolve(configPath);

  // If no config file exists and no explicit CONDUIT_CONFIG is set, start with
  // all defaults so the gateway can run in a zero-config / env-vars-only mode.
  if (!existsSync(absolutePath) && !process.env['CONDUIT_CONFIG']) {
    console.warn(
      `[Conduit] No config file found at ${absolutePath} — starting with defaults. ` +
      'Set CONDUIT_CONFIG to specify a config file.',
    );
    const config = mergeWithDefaults({});
    applyEnvOverrides(config);
    throwIfInvalid(config);
    return config;
  }

  return loadConfig(configPath);
}

/**
 * Validates a config and exits the process with a formatted error list if invalid.
 * Prints ALL errors before exiting (not just the first one).
 */
function throwIfInvalid(config: ConduitGatewayConfig): void {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error(formatConfigErrors(errors));
    process.exit(1);
  }
}

/**
 * Applique les surcharges depuis les variables d'environnement.
 * Les env vars ont toujours priorité sur le fichier de configuration.
 */
function applyEnvOverrides(config: ConduitGatewayConfig): void {
  const port = process.env['CONDUIT_PORT'];
  if (port !== undefined) {
    const parsed = parseInt(port, 10);
    if (!isNaN(parsed)) config.gateway.port = parsed;
  }

  const host = process.env['CONDUIT_HOST'];
  if (host !== undefined) {
    config.gateway.host = host;
  }

  const dbPath = process.env['CONDUIT_DB_PATH'];
  if (dbPath !== undefined) {
    config.observability.db_path = dbPath;
  }

  const metricsPort = process.env['CONDUIT_METRICS_PORT'];
  if (metricsPort !== undefined) {
    const parsed = parseInt(metricsPort, 10);
    if (!isNaN(parsed)) config.metrics.port = parsed;
  }

  const adminKey = process.env['CONDUIT_ADMIN_KEY'];
  if (adminKey !== undefined) {
    config.admin = { ...config.admin, key: adminKey };
  }

  const logArgs = process.env['CONDUIT_LOG_ARGS'];
  if (logArgs !== undefined) {
    config.observability.log_args = logArgs.toLowerCase() !== 'false';
  }

  // ── TLS env overrides ────────────────────────────────────────────────────
  const tlsEnabled = process.env['CONDUIT_TLS_ENABLED'];
  if (tlsEnabled !== undefined) {
    if (!config.gateway.tls) {
      config.gateway.tls = { enabled: false, cert_path: '', key_path: '' };
    }
    config.gateway.tls.enabled = tlsEnabled.toLowerCase() === 'true';
  }

  const tlsCert = process.env['CONDUIT_TLS_CERT'];
  if (tlsCert !== undefined) {
    if (!config.gateway.tls) {
      config.gateway.tls = { enabled: false, cert_path: tlsCert, key_path: '' };
    } else {
      config.gateway.tls.cert_path = tlsCert;
    }
  }

  const tlsKey = process.env['CONDUIT_TLS_KEY'];
  if (tlsKey !== undefined) {
    if (!config.gateway.tls) {
      config.gateway.tls = { enabled: false, cert_path: '', key_path: tlsKey };
    } else {
      config.gateway.tls.key_path = tlsKey;
    }
  }

  // ── Redis env override ───────────────────────────────────────────────────
  const redisUrl = process.env['CONDUIT_REDIS_URL'];
  if (redisUrl !== undefined) {
    if (!config.rate_limits) {
      config.rate_limits = { enabled: true, backend: 'redis', redis_url: redisUrl };
    } else {
      config.rate_limits.redis_url = redisUrl;
    }
  }
}

// ─── Unknown key detection with "did you mean?" suggestions ──────────

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'gateway', 'router', 'servers', 'cache', 'auth', 'acl',
  'rate_limits', 'tenant_isolation', 'observability', 'metrics',
  'admin', 'guardrails', 'plugins', 'discovery',
]);

/**
 * Levenshtein distance between two strings (for fuzzy matching).
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,       // deletion
        dp[i]![j - 1]! + 1,       // insertion
        dp[i - 1]![j - 1]! + cost, // substitution
      );
    }
  }

  return dp[m]![n]!;
}

function findClosestKey(unknown: string, known: Set<string>): string | null {
  let best: string | null = null;
  let bestDist = Infinity;

  for (const k of known) {
    const dist = levenshtein(unknown.toLowerCase(), k.toLowerCase());
    if (dist < bestDist && dist <= 3) {
      bestDist = dist;
      best = k;
    }
  }

  return best;
}

/**
 * Warns about unknown top-level config keys with "did you mean?" suggestions.
 * Does NOT throw — just prints warnings.
 */
function warnUnknownKeys(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      const suggestion = findClosestKey(key, KNOWN_TOP_LEVEL_KEYS);
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
      console.warn(`[Conduit] Warning: unknown config key "${key}" — it will be ignored.${hint}`);
    }
  }
}
