/**
 * Orchestrateur principal de la passerelle Conduit.
 *
 * Responsabilités :
 * - Initialisation de tous les composants (registre, clients, cache, logs, auth, rate limit)
 * - Démarrage du serveur Hono via @hono/node-server (HTTP ou HTTPS natif)
 * - Délégation du traitement des requêtes au pipeline
 * - Arrêt propre
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { load as yamlLoad } from 'js-yaml';
import { mergeWithDefaults, validateConfig, formatConfigErrors } from '../config/schema.js';
import type { ConduitGatewayConfig } from '../config/types.js';
import type { JsonRpcMessage } from '../proxy/json-rpc.js';
import type { RequestContext, CoreResult } from '../proxy/transport.js';
import type { IMcpClient } from '../proxy/mcp-client-interface.js';
import { createMcpClient } from '../proxy/client-factory.js';
import { CacheStore } from '../cache/cache-store.js';
import { InflightTracker } from '../cache/inflight.js';
import { ServerRegistry } from '../router/registry.js';
import { ConduitRouter } from '../router/router.js';
import { RequestPipeline } from './pipeline.js';
import { ConduitLogger } from '../observability/logger.js';
import { LogStore } from '../observability/log-store.js';
import { getMetrics } from '../observability/metrics.js';
import { createTransport } from '../proxy/transport.js';
import { createAdminRouter } from '../admin/routes.js';
import { RateLimiter } from '../rate-limit/rate-limiter.js';
import { SlidingWindowLimiter } from '../rate-limit/limiter.js';
import { RedisLimiter } from '../rate-limit/redis-limiter.js';
import { RedisCacheStore } from '../cache/redis-cache.js';
import { redactUrl } from '../utils/url-validator.js';
import { PluginRegistry } from '../plugins/registry.js';
import { loadPlugins } from '../plugins/loader.js';
import { initOtel, shutdownOtel } from '../observability/otel.js';
import { DiscoveryManager } from '../discovery/manager.js';
import { HttpRegistryBackend } from '../discovery/http-registry.js';
import { DnsDiscoveryBackend } from '../discovery/dns-discovery.js';
import type { DiscoveryBackend } from '../discovery/types.js';

/**
 * Interface exposée au transport pour déléguer le traitement des requêtes.
 */
export interface GatewayCore {
  handleRequest(
    serverId: string,
    message: JsonRpcMessage,
    context: RequestContext,
  ): Promise<CoreResult>;

  getClient(serverId: string): IMcpClient | undefined;
}

export class ConduitGateway implements GatewayCore {
  private readonly config: ConduitGatewayConfig;
  private readonly clients: Map<string, IMcpClient>;
  private readonly cacheStore: CacheStore;
  private readonly inflightTracker: InflightTracker;
  private readonly registry: ServerRegistry;
  private readonly router: ConduitRouter;
  private readonly pipeline: RequestPipeline;
  private readonly logStore: LogStore;
  private readonly logger: ConduitLogger;
  private readonly rateLimiter: RateLimiter | null;
  private redisLimiter: RedisLimiter | null = null;
  private redisCacheStore: RedisCacheStore | null = null;
  private pluginRegistry: PluginRegistry | null = null;
  private discoveryManager: DiscoveryManager | null = null;
  private httpRegistryBackend: HttpRegistryBackend | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private server: ServerType | null = null;

  constructor(config: ConduitGatewayConfig) {
    this.config = config;
    const metrics = getMetrics();

    // Initialisation des clients MCP pour chaque serveur configuré
    this.clients = new Map();
    for (const serverConfig of config.servers) {
      this.clients.set(serverConfig.id, createMcpClient(serverConfig));
    }

    // Cache et déduplication
    this.cacheStore = new CacheStore(config.cache.l1);
    this.inflightTracker = new InflightTracker();

    // Log store SQLite
    this.logStore = new LogStore(
      config.observability.db_path,
      config.observability.retention_days,
    );

    // Logger structuré
    this.logger = new ConduitLogger(this.logStore, metrics, {
      logArgs: config.observability.log_args,
      logResponses: config.observability.log_responses,
      redactFields: config.observability.redact_fields,
    });

    // Registre et routeur
    this.registry = new ServerRegistry(config, this.clients, metrics);
    this.router = new ConduitRouter(this.registry, this.clients, config);

    // Rate Limiter (si activé) — backend sélectionné dans initialize()
    this.rateLimiter = config.rate_limits?.enabled
      ? new RateLimiter(config.rate_limits, new SlidingWindowLimiter())
      : null;

    // Pipeline de traitement
    this.pipeline = new RequestPipeline(
      this.router,
      this.registry,
      this.cacheStore,
      this.inflightTracker,
      this.logger,
      metrics,
      config,
      this.rateLimiter ?? undefined,
    );
  }

  /**
   * Initialise la passerelle (récupération des outils, démarrage des checks de santé).
   * Connecte Redis si configuré — falls back to memory on connection failure.
   * Doit être appelé avant de démarrer le serveur HTTP.
   */
  async initialize(): Promise<void> {
    // Initialize OpenTelemetry if configured (must be first)
    const otelConfig = this.config.observability.opentelemetry;
    if (otelConfig?.enabled) {
      initOtel(otelConfig);
    }

    // Connect Redis rate limit backend if configured
    const rlConfig = this.config.rate_limits;
    if (rlConfig?.enabled && rlConfig.backend === 'redis' && rlConfig.redis_url) {
      try {
        const redisBacked = new RedisLimiter(rlConfig.redis_url);
        await redisBacked.connect();
        this.redisLimiter = redisBacked;

        // Swap the backend in the existing rate limiter
        if (this.rateLimiter) {
          (this.rateLimiter as unknown as { limiter: RedisLimiter }).limiter = redisBacked;
        }

        console.log('[Conduit] Rate limiting: Redis backend connected');
      } catch (error) {
        console.warn(
          `[Conduit] Redis rate limit backend unavailable — falling back to memory: ${error instanceof Error ? error.message : 'connection failed'}`,
        );
      }
    }

    // Connect Redis L2 cache if configured
    const l2Config = this.config.cache.l2;
    if (l2Config?.enabled && l2Config.redis_url) {
      try {
        const l2 = new RedisCacheStore(
          l2Config.redis_url,
          l2Config.key_prefix ?? 'conduit:cache:',
          l2Config.max_entry_size_kb ?? 512,
        );
        await l2.connect();
        this.redisCacheStore = l2;
        this.pipeline.setL2Cache(l2, l2Config.default_ttl_multiplier ?? 3);
        console.log('[Conduit] Cache L2: Redis backend connected');
      } catch (error) {
        console.warn(
          `[Conduit] Redis L2 cache unavailable — L1 only: ${error instanceof Error ? error.message : 'connection failed'}`,
        );
      }
    }

    // Load plugins if configured
    if (this.config.plugins && this.config.plugins.length > 0) {
      const pluginRegistry = new PluginRegistry();
      const plugins = await loadPlugins(this.config.plugins);
      for (const plugin of plugins) {
        pluginRegistry.register(plugin);
      }
      await pluginRegistry.initializeAll();
      this.pluginRegistry = pluginRegistry;
      this.pipeline.setPluginRegistry(pluginRegistry);
      console.log(`[Conduit] Plugins: ${pluginRegistry.size} loaded (${pluginRegistry.getPluginNames().join(', ')})`);
    }

    await this.registry.initialize();

    // Initialize service discovery if configured
    const discoveryConfig = this.config.discovery;
    if (discoveryConfig?.enabled && discoveryConfig.backends.length > 0) {
      const backends: DiscoveryBackend[] = [];

      for (const backendConfig of discoveryConfig.backends) {
        switch (backendConfig.type) {
          case 'http': {
            const httpBackend = new HttpRegistryBackend(discoveryConfig.stale_timeout_seconds);
            this.httpRegistryBackend = httpBackend;
            backends.push(httpBackend);
            break;
          }
          case 'dns': {
            if (backendConfig.domain) {
              backends.push(new DnsDiscoveryBackend(backendConfig.domain));
            }
            break;
          }
          case 'consul': {
            console.warn('[Conduit/Discovery] Consul backend not yet implemented');
            break;
          }
        }
      }

      if (backends.length > 0) {
        this.discoveryManager = new DiscoveryManager(
          discoveryConfig,
          backends,
          this.registry,
          this.clients,
          this.config.servers,
        );
        await this.discoveryManager.start();
        console.log(`[Conduit] Service discovery: ${backends.map((b) => b.name).join(', ')} active`);
      }
    }

    this.purgeTimer = this.logStore.startPeriodicPurge();
  }

  /**
   * Délègue le traitement d'une requête JSON-RPC au pipeline.
   */
  async handleRequest(
    serverId: string,
    message: JsonRpcMessage,
    context: RequestContext,
  ): Promise<CoreResult> {
    return this.pipeline.handle(serverId, message, context);
  }

  /**
   * Retourne le client MCP pour un serveur donné.
   */
  getClient(serverId: string): IMcpClient | undefined {
    return this.clients.get(serverId);
  }

  /**
   * Reloads hot-reloadable config fields from the config file without restarting.
   * Non-reloadable fields (port, host, TLS, server URLs, auth method) are listed
   * in the returned `skipped` array. Parse/validation errors are returned in `errors`
   * and the running config is left unchanged.
   *
   * @param configPathOverride  Optional path override (used in tests).
   */
  async reload(configPathOverride?: string): Promise<{ reloaded: string[]; skipped: string[]; errors: string[] }> {
    const reloaded: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    const configPath = resolvePath(configPathOverride ?? process.env['CONDUIT_CONFIG'] ?? 'conduit.config.yml');

    // ── 1. Read file ────────────────────────────────────────────────────────
    let rawContent: string;
    try {
      rawContent = readFileSync(configPath, 'utf-8');
    } catch (err) {
      errors.push(`Cannot read config file: ${String(err)}`);
      return { reloaded, skipped, errors };
    }

    // ── 2. Parse YAML ───────────────────────────────────────────────────────
    let parsed: unknown;
    try {
      parsed = yamlLoad(rawContent);
    } catch (err) {
      errors.push(`YAML parse error: ${String(err)}`);
      return { reloaded, skipped, errors };
    }

    if (parsed === null || parsed === undefined) parsed = {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('Config must be a YAML object');
      return { reloaded, skipped, errors };
    }

    // ── 3. Merge with defaults + validate ───────────────────────────────────
    const newConfig = mergeWithDefaults(parsed as Record<string, unknown>);
    const validationErrors = validateConfig(newConfig);
    if (validationErrors.length > 0) {
      errors.push(formatConfigErrors(validationErrors));
      return { reloaded, skipped, errors };
    }

    // ── 4. Flag non-reloadable changes ──────────────────────────────────────
    if (newConfig.gateway.port !== this.config.gateway.port ||
        newConfig.gateway.host !== this.config.gateway.host) {
      skipped.push('gateway.port/host (restart required)');
    }
    if (JSON.stringify(newConfig.gateway.tls) !== JSON.stringify(this.config.gateway.tls)) {
      skipped.push('gateway.tls (restart required)');
    }
    // ── 4b. Dynamic server changes (add/remove/update) ─────────────────────
    const currentIds = new Set(this.config.servers.map((s) => s.id));
    const newIds = new Set(newConfig.servers.map((s) => s.id));

    // Added servers
    for (const newServer of newConfig.servers) {
      if (!currentIds.has(newServer.id)) {
        try {
          const client = createMcpClient(newServer);
          this.clients.set(newServer.id, client);
          await this.registry.addServer(newServer, client);
          this.config.servers.push(newServer);
          reloaded.push(`server.${newServer.id} (added)`);
        } catch (err) {
          errors.push(`Failed to add server "${newServer.id}": ${String(err)}`);
        }
      }
    }

    // Removed servers
    for (const curServer of this.config.servers) {
      if (!newIds.has(curServer.id)) {
        this.registry.removeServer(curServer.id);
        this.clients.delete(curServer.id);
        this.cacheStore.deleteByServer(curServer.id);
        reloaded.push(`server.${curServer.id} (removed)`);
      }
    }
    // Update config.servers array
    this.config.servers = this.config.servers.filter((s) => newIds.has(s.id));

    // URL changes for existing servers
    for (const newServer of newConfig.servers) {
      const cur = this.config.servers.find((s) => s.id === newServer.id);
      if (cur && cur.url !== newServer.url) {
        skipped.push(`server.${newServer.id}.url (URL change requires restart)`);
      }
    }
    if (newConfig.auth?.method !== this.config.auth?.method) {
      skipped.push('auth.method (restart required)');
    }

    // ── 5. Apply hot-reloadable changes ─────────────────────────────────────

    // ACL policies
    if (JSON.stringify(newConfig.acl) !== JSON.stringify(this.config.acl)) {
      if (newConfig.acl !== undefined) {
        this.config.acl = newConfig.acl;
      } else {
        delete this.config.acl;
      }
      reloaded.push('acl');
    }

    // Guardrails configuration
    if (JSON.stringify(newConfig.guardrails) !== JSON.stringify(this.config.guardrails)) {
      if (newConfig.guardrails !== undefined) {
        this.config.guardrails = newConfig.guardrails;
      } else {
        delete this.config.guardrails;
      }
      reloaded.push('guardrails');
    }

    // Rate limit configuration
    if (JSON.stringify(newConfig.rate_limits) !== JSON.stringify(this.config.rate_limits)) {
      if (newConfig.rate_limits !== undefined) {
        this.config.rate_limits = newConfig.rate_limits;
      } else {
        delete this.config.rate_limits;
      }
      reloaded.push('rate_limits');
    }

    // Observability settings
    const obs = this.config.observability;
    const nobs = newConfig.observability;
    if (
      nobs.log_args !== obs.log_args ||
      nobs.log_responses !== obs.log_responses ||
      JSON.stringify(nobs.redact_fields) !== JSON.stringify(obs.redact_fields)
    ) {
      obs.log_args = nobs.log_args;
      obs.log_responses = nobs.log_responses;
      obs.redact_fields = nobs.redact_fields;
      this.logger.updateObservabilityConfig(nobs.log_args, nobs.log_responses, nobs.redact_fields);
      reloaded.push('observability');
    }

    // Server cache overrides (per-server TTL changes)
    for (const newServer of newConfig.servers) {
      const cur = this.config.servers.find((s) => s.id === newServer.id);
      if (cur && JSON.stringify(newServer.cache) !== JSON.stringify(cur.cache)) {
        cur.cache = newServer.cache;
        reloaded.push(`server.${newServer.id}.cache`);
      }
    }

    return { reloaded, skipped, errors };
  }

  /**
   * Démarre le serveur HTTP (ou HTTPS si TLS est configuré).
   * @returns L'URL de base du serveur démarré
   */
  async start(): Promise<string> {
    const app = this.createApp();

    const port = this.config.gateway.port;
    const host = this.config.gateway.host;
    const tlsConfig = this.config.gateway.tls;

    return new Promise((resolve, reject) => {
      try {
        if (tlsConfig?.enabled) {
          // Read TLS cert and key files — errors here are fatal
          let cert: Buffer;
          let key: Buffer;
          try {
            cert = readFileSync(tlsConfig.cert_path);
            key = readFileSync(tlsConfig.key_path);
          } catch (err) {
            reject(new Error(`[Conduit] Failed to read TLS files: ${String(err)}`));
            return;
          }

          const serverOptions: Record<string, unknown> = { cert, key };

          if (tlsConfig.ca_path) {
            try {
              serverOptions['ca'] = readFileSync(tlsConfig.ca_path);
            } catch (err) {
              reject(new Error(`[Conduit] Failed to read TLS CA file: ${String(err)}`));
              return;
            }
          }

          if (tlsConfig.min_version) {
            serverOptions['minVersion'] = tlsConfig.min_version;
          }

          this.server = serve({
            fetch: app.fetch,
            port,
            hostname: host,
            createServer: createHttpsServer,
            serverOptions,
          } as Parameters<typeof serve>[0], (info) => {
            const url = `https://${host === '0.0.0.0' ? 'localhost' : host}:${info.port}`;
            console.log(`[Conduit] Passerelle MCP démarrée (HTTPS/TLS) sur ${url}`);
            console.log(`[Conduit] ${this.config.servers.length} serveur(s) configuré(s)`);
            resolve(url);
          });
        } else {
          this.server = serve({
            fetch: app.fetch,
            port,
            hostname: host,
          }, (info) => {
            const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${info.port}`;
            console.log(`[Conduit] Passerelle MCP démarrée sur ${url}`);
            console.log(`[Conduit] ${this.config.servers.length} serveur(s) configuré(s)`);
            resolve(url);
          });
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Retourne l'application Hono pour les tests (sans démarrer un serveur TCP).
   */
  createApp(): Hono {
    const app = new Hono();

    const transport = createTransport(this.config, this);
    app.route('/', transport);

    const adminRouter = createAdminRouter(
      this.cacheStore,
      this.inflightTracker,
      this.logStore,
      this.registry,
      getMetrics(),
      this.config,
      this.rateLimiter ?? undefined,
      this.redisLimiter ?? undefined,
      (configPath?: string) => this.reload(configPath),
      this.redisCacheStore ?? undefined,
      this.httpRegistryBackend ?? undefined,
    );
    app.route('/conduit', adminRouter);

    return app;
  }

  /**
   * Arrête proprement la passerelle.
   * Attend que le serveur HTTP ferme ses connexions actives (drain),
   * puis libère toutes les ressources (Redis, SQLite, timers).
   *
   * @param drainTimeoutMs - Délai maximum pour le drain (défaut: 10 s)
   */
  async stop(drainTimeoutMs = 10_000): Promise<void> {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }

    // Stop health-check timers and rate-limit queue timers first so they
    // do not create new work while we are draining.
    this.registry.stop();
    this.rateLimiter?.stop();

    // Stop discovery
    if (this.discoveryManager) {
      this.discoveryManager.stop();
      this.discoveryManager = null;
    }

    // Shutdown OpenTelemetry
    await shutdownOtel();

    // Shutdown plugins
    if (this.pluginRegistry) {
      await this.pluginRegistry.shutdownAll();
      this.pluginRegistry = null;
    }

    // Disconnect Redis if connected
    if (this.redisLimiter) {
      try {
        await this.redisLimiter.disconnect();
      } catch (err) {
        console.warn('[Conduit] Error disconnecting Redis rate limiter:', err);
      }
      this.redisLimiter = null;
    }
    if (this.redisCacheStore) {
      try {
        await this.redisCacheStore.disconnect();
      } catch (err) {
        console.warn('[Conduit] Error disconnecting Redis L2 cache:', err);
      }
      this.redisCacheStore = null;
    }

    // Drain the HTTP server: stop accepting new connections and wait for
    // existing ones to finish (up to drainTimeoutMs).
    if (this.server) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('[Conduit] Drain timeout reached — forcing shutdown');
          resolve();
        }, drainTimeoutMs);

        this.server!.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.server = null;
    }

    // Flush any pending SQLite writes and close the connection.
    this.logStore.close();
  }

  /** Accesseurs pour les tests et l'administration */
  getCacheStore(): CacheStore {
    return this.cacheStore;
  }

  getInflightTracker(): InflightTracker {
    return this.inflightTracker;
  }

  getRegistry(): ServerRegistry {
    return this.registry;
  }

  getLogStore(): LogStore {
    return this.logStore;
  }

  getRateLimiter(): RateLimiter | null {
    return this.rateLimiter;
  }
}
