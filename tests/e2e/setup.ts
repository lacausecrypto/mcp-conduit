/**
 * Configuration partagée pour les tests e2e.
 *
 * Fournit des utilitaires pour :
 * - Démarrer un ou plusieurs serveurs MCP simulés
 * - Instancier une ConduitGateway configurée en mémoire
 * - Émettre des requêtes JSON-RPC vers la Hono app sans socket TCP
 * - Nettoyer proprement après chaque test
 */

import type { Hono } from 'hono';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import type { AuthConfig } from '../../src/auth/types.js';
import type { AclConfig } from '../../src/auth/types.js';
import type { RateLimitConfig } from '../../src/rate-limit/types.js';
import type { GuardrailsConfig } from '../../src/guardrails/types.js';
import { resetMetrics } from '../../src/observability/metrics.js';
import { startMockMcpServer, type MockMcpServer, type MockTool } from './mock-mcp-server.js';

/** Contexte complet d'une suite de tests e2e */
export interface E2eTestContext {
  gateway: ConduitGateway;
  app: Hono;
  mockServer: MockMcpServer;
}

/** Options de création du contexte e2e */
export interface E2eSetupOptions {
  /** Stratégie de namespace (défaut : 'none' pour simplifier les tests) */
  namespaceStrategy?: 'prefix' | 'none';
  /** TTL par défaut du cache serveur en secondes */
  defaultTtl?: number;
  /** Activer le cache (défaut : true) */
  cacheEnabled?: boolean;
  /** Outils personnalisés pour le serveur simulé */
  tools?: MockTool[];
  /** Config supplémentaire de surcharge par outil */
  toolOverrides?: Record<string, { ttl?: number; ignore_args?: string[]; invalidates?: string[] }>;
  /** Configuration d'authentification */
  auth?: AuthConfig;
  /** Configuration ACL */
  acl?: AclConfig;
  /** Configuration de rate limiting */
  rate_limits?: RateLimitConfig;
  /** Configuration des guardrails */
  guardrails?: GuardrailsConfig;
  /** Clé d'administration à injecter dans la config */
  adminKey?: string;
  /** Configuration connect optionnelle */
  connect?: ConduitGatewayConfig['connect'];
  /** Plan identité optionnel */
  identity?: ConduitGatewayConfig['identity'];
  /** Plan gouvernance optionnel */
  governance?: ConduitGatewayConfig['governance'];
}

/**
 * Crée un contexte e2e complet avec un serveur MCP simulé et une ConduitGateway.
 * Doit être suivi d'un appel à teardown() dans afterEach/afterAll.
 */
export async function setup(options: E2eSetupOptions = {}): Promise<E2eTestContext> {
  const {
    namespaceStrategy = 'none',
    defaultTtl = 300,
    cacheEnabled = true,
    tools,
    toolOverrides,
    auth,
    acl,
    rate_limits,
    guardrails,
    adminKey,
    connect,
    identity,
    governance,
  } = options;

  // Démarrage du serveur MCP simulé sur un port aléatoire
  const mockServer = await startMockMcpServer(0, tools);

  const baseConfig: ConduitGatewayConfig = {
    gateway: {
      port: 0,
      host: '127.0.0.1',
    },
    router: {
      namespace_strategy: namespaceStrategy,
      health_check: {
        enabled: false,
        interval_seconds: 60,
        timeout_ms: 1000,
        unhealthy_threshold: 3,
        healthy_threshold: 1,
      },
      load_balancing: 'round-robin',
    },
    servers: [
      {
        id: 'test-server',
        url: mockServer.url,
        cache: {
          default_ttl: defaultTtl,
          overrides: toolOverrides,
        },
      },
    ],
    cache: {
      enabled: cacheEnabled,
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
      redact_fields: ['password', 'token', 'secret'],
      retention_days: 30,
      db_path: ':memory:',
    },
    metrics: {
      enabled: false,
      port: 0,
    },
    admin: {
      allow_private_networks: true,
    },
  };

  // Sections optionnelles
  if (auth !== undefined) baseConfig.auth = auth;
  if (acl !== undefined) baseConfig.acl = acl;
  if (rate_limits !== undefined) baseConfig.rate_limits = rate_limits;
  if (guardrails !== undefined) baseConfig.guardrails = guardrails;
  if (adminKey !== undefined) baseConfig.admin = {
    ...baseConfig.admin,
    key: adminKey,
  };
  if (connect !== undefined) baseConfig.connect = connect;
  if (identity !== undefined) baseConfig.identity = identity;
  if (governance !== undefined) baseConfig.governance = governance;

  // Réinitialisation des métriques pour l'isolation entre tests
  resetMetrics();

  const gateway = new ConduitGateway(baseConfig);
  await gateway.initialize();

  const app = gateway.createApp();

  return { gateway, app, mockServer };
}

/**
 * Contexte e2e avec deux serveurs MCP simulés (pour les tests multi-backend).
 */
export interface E2eMultiServerContext {
  gateway: ConduitGateway;
  app: Hono;
  mockServer1: MockMcpServer;
  mockServer2: MockMcpServer;
}

/**
 * Crée un contexte e2e avec deux serveurs MCP simulés distincts.
 */
export async function setupMultiServer(options: {
  namespaceStrategy?: 'prefix' | 'none';
  tools1?: MockTool[];
  tools2?: MockTool[];
  auth?: AuthConfig;
  acl?: AclConfig;
  rate_limits?: RateLimitConfig;
} = {}): Promise<E2eMultiServerContext> {
  const { namespaceStrategy = 'prefix', tools1, tools2, auth, acl, rate_limits } = options;

  const [mockServer1, mockServer2] = await Promise.all([
    startMockMcpServer(0, tools1),
    startMockMcpServer(0, tools2),
  ]);

  const baseConfig: ConduitGatewayConfig = {
    gateway: { port: 0, host: '127.0.0.1' },
    router: {
      namespace_strategy: namespaceStrategy,
      health_check: {
        enabled: false,
        interval_seconds: 60,
        timeout_ms: 1000,
        unhealthy_threshold: 3,
        healthy_threshold: 1,
      },
      load_balancing: 'round-robin',
    },
    servers: [
      {
        id: 'server-a',
        url: mockServer1.url,
        cache: { default_ttl: 300 },
      },
      {
        id: 'server-b',
        url: mockServer2.url,
        cache: { default_ttl: 60 },
      },
    ],
    cache: {
      enabled: true,
      l1: { max_entries: 1000, max_entry_size_kb: 64 },
    },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: {
      log_args: true,
      log_responses: false,
      redact_fields: ['password'],
      retention_days: 30,
      db_path: ':memory:',
    },
    metrics: { enabled: false, port: 0 },
  };

  if (auth !== undefined) baseConfig.auth = auth;
  if (acl !== undefined) baseConfig.acl = acl;
  if (rate_limits !== undefined) baseConfig.rate_limits = rate_limits;

  resetMetrics();

  const gateway = new ConduitGateway(baseConfig);
  await gateway.initialize();

  return { gateway, app: gateway.createApp(), mockServer1, mockServer2 };
}

/**
 * Nettoie proprement un contexte e2e simple.
 */
export async function teardown(ctx: E2eTestContext): Promise<void> {
  ctx.gateway.stop();
  await ctx.mockServer.close();
}

/**
 * Nettoie proprement un contexte e2e multi-serveur.
 */
export async function teardownMultiServer(ctx: E2eMultiServerContext): Promise<void> {
  ctx.gateway.stop();
  await Promise.all([ctx.mockServer1.close(), ctx.mockServer2.close()]);
}

/**
 * Envoie une requête JSON-RPC vers une route MCP de la Hono app.
 * Utilise app.request() pour éviter la création d'un socket TCP réel.
 */
export async function sendMcpRequest(
  app: Hono,
  serverId: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request(`/mcp/${serverId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Envoie une requête JSON-RPC et retourne le corps parsé.
 */
export async function sendMcpRequestJson<T = unknown>(
  app: Hono,
  serverId: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await sendMcpRequest(app, serverId, body, headers);
  return res.json() as Promise<T>;
}

/** Construit un message JSON-RPC tools/call */
export function makeToolCallMessage(
  toolName: string,
  args: Record<string, unknown> = {},
  id: number | string = 1,
) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };
}

/** Construit un message JSON-RPC tools/list */
export function makeToolsListMessage(id: number | string = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

/** Construit un message JSON-RPC initialize */
export function makeInitializeMessage(id: number | string = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  };
}
