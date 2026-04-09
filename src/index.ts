#!/usr/bin/env node
/**
 * Point d'entrée principal de MCP Conduit.
 * Charge la configuration, initialise la passerelle, et démarre les serveurs HTTP.
 */

import { loadConfigFromEnv } from './config/loader.js';
import { ConduitGateway } from './gateway/gateway.js';
import { getMetrics, resetMetrics } from './observability/metrics.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

// Global handlers — must be registered before any async work so that bugs
// in initialisation code (e.g. a rejected promise without a .catch()) are
// captured and the process exits with a non-zero code rather than printing
// a deprecation warning and continuing in an inconsistent state.
process.on('uncaughtException', (err: Error) => {
  console.error('[Conduit] Uncaught exception — shutting down:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[Conduit] Unhandled promise rejection — shutting down:', reason);
  process.exit(1);
});

// ─── CLI routing ────────────────────────────────────────────────────────
const command = process.argv[2];

if (command === 'init') {
  import('./cli/init.js').then((m) => m.runInit()).catch((err) => {
    console.error('Init failed:', err);
    process.exit(1);
  });
  // Don't run main() — init is a separate flow
} else if (command === '--help' || command === '-h') {
  console.log(`
  MCP Conduit — Production MCP Gateway

  Usage:
    conduit              Start the gateway (reads conduit.config.yml)
    conduit init         Interactive config wizard
    conduit --help       Show this help

  Environment:
    CONDUIT_CONFIG       Path to config file (default: conduit.config.yml)
    CONDUIT_PORT         Override gateway port
    CONDUIT_ADMIN_KEY    Admin API key
    CONDUIT_REDIS_URL    Redis URL for rate limiting / L2 cache

  Docs: https://github.com/lacausecrypto/mcp-conduit
`);
  process.exit(0);
} else {
  main().catch((err) => {
    console.error('[Conduit] Fatal error:', err);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  console.log('[Conduit] Starting MCP Conduit...');

  // Chargement de la configuration
  let config;
  try {
    config = loadConfigFromEnv();
  } catch (error) {
    console.error('[Conduit] Erreur de chargement de la configuration :', error);
    process.exit(1);
  }

  // Réinitialisation des métriques (évite les conflits lors des redémarrages)
  resetMetrics();

  // Création et initialisation de la passerelle
  const gateway = new ConduitGateway(config);

  try {
    await gateway.initialize();
  } catch (error) {
    console.error('[Conduit] Erreur lors de l\'initialisation :', error);
    process.exit(1);
  }

  // Démarrage du serveur principal
  await gateway.start();

  // Démarrage du serveur de métriques Prometheus (port séparé)
  if (config.metrics.enabled) {
    const metrics = getMetrics();
    const metricsApp = new Hono();

    metricsApp.get('/', async (c) => {
      try {
        const metricsText = await metrics.getMetrics();
        return c.text(metricsText, 200, {
          'Content-Type': 'text/plain; version=0.0.4',
        });
      } catch {
        return c.json({ error: 'Erreur lors de la collecte des métriques' }, 500);
      }
    });

    serve({
      fetch: metricsApp.fetch,
      port: config.metrics.port,
    }, (info) => {
      console.log(`[Conduit] Métriques Prometheus exposées sur le port ${info.port}`);
    });
  }

  // Graceful shutdown — SIGTERM is sent by Kubernetes / Docker before SIGKILL.
  // We drain in-flight requests before exiting so logs are written and
  // responses are returned to clients.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Conduit] Signal ${signal} reçu — arrêt en cours...`);
    gateway.stop().then(() => {
      console.log('[Conduit] Arrêt propre terminé');
      process.exit(0);
    }).catch((err: unknown) => {
      console.error('[Conduit] Erreur lors de l\'arrêt :', err);
      process.exit(1);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Hot-reload on SIGHUP — re-reads the config file and applies changes that
  // do not require a restart (ACL, rate limits, cache TTLs, observability).
  process.on('SIGHUP', () => {
    console.log('[Conduit] SIGHUP received, reloading config...');
    gateway.reload().then((result) => {
      if (result.reloaded.length > 0) {
        console.log(`[Conduit] Reloaded: ${result.reloaded.join(', ')}`);
      } else {
        console.log('[Conduit] Reload complete — no hot-reloadable changes detected');
      }
      if (result.skipped.length > 0) {
        console.log(`[Conduit] Skipped (restart required): ${result.skipped.join(', ')}`);
      }
      if (result.errors.length > 0) {
        console.error(`[Conduit] Reload errors (config unchanged): ${result.errors.join('; ')}`);
      }
    }).catch((err: unknown) => {
      console.error('[Conduit] Unexpected error during reload:', err);
    });
  });

  // ── Startup summary ──────────────────────────────────────────────────────
  const authMethod = config.auth?.method ?? 'none';
  const adminKeySet = !!config.admin?.key;
  console.log('[Conduit] ─────────────────────────────────────────');
  console.log(`[Conduit] Auth:          ${authMethod}`);
  console.log(`[Conduit] Cache:         ${config.cache.enabled ? `enabled (L1 ${config.cache.l1.max_entries} entries)` : 'disabled'}`);
  console.log(`[Conduit] Rate limiting: ${config.rate_limits?.enabled ? 'enabled' : 'disabled'}`);
  console.log(`[Conduit] ACL:           ${config.acl?.enabled ? 'enabled' : 'disabled'}`);
  console.log(`[Conduit] Admin API:     /conduit/* (key: ${adminKeySet ? 'set ✓' : 'NOT SET ⚠'})`);
  console.log(`[Conduit] Log DB:        ${config.observability.db_path}`);
  console.log('[Conduit] ─────────────────────────────────────────');

  if (authMethod === 'none') {
    console.warn('[Conduit] ⚠️  AUTH DISABLED — anyone can access this gateway.');
    console.warn('[Conduit]    Set auth.method in config for production (api_key or jwt).');
  }

  if (!adminKeySet) {
    console.warn('[Conduit] ⚠️  ADMIN API UNPROTECTED — set admin.key in config or CONDUIT_ADMIN_KEY env var.');
  }

  if (!config.rate_limits?.enabled) {
    console.warn('[Conduit] ⚠️  RATE LIMITING DISABLED — backend servers have no protection against abuse.');
  }

  const serverCount = config.servers?.length ?? 0;
  if (serverCount === 0) {
    console.warn('[Conduit] ⚠️  NO SERVERS CONFIGURED — the gateway will not route any requests.');
    console.warn('[Conduit]    Add at least one entry under "servers:" in your config file.');
  }

  console.log('[Conduit] Prêt à traiter les requêtes MCP');
}

// main() is called from the CLI routing block above
