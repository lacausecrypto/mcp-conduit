/**
 * Setup pour les tests d'intégration.
 * Crée un gateway complet avec de vrais backends.
 */

import { resolve } from 'node:path';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import { mergeWithDefaults } from '../../src/config/schema.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { startMockMcpServer, type MockMcpServer } from '../e2e/mock-mcp-server.js';
import { resetMetrics } from '../../src/observability/metrics.js';

const MOCK_STDIO_SERVER = resolve(import.meta.dirname, '../e2e/mock-stdio-server.ts');

export interface IntegrationContext {
  gateway: ConduitGateway;
  app: ReturnType<ConduitGateway['createApp']>;
  httpMock: MockMcpServer;
}

export async function setupIntegration(options?: {
  redisUrl?: string;
  withL2?: boolean;
  withStdio?: boolean;
}): Promise<IntegrationContext> {
  resetMetrics();

  const httpMock = await startMockMcpServer(0);

  const servers: ConduitGatewayConfig['servers'] = [
    {
      id: 'http-backend',
      url: httpMock.url,
      cache: { default_ttl: 60 },
    },
  ];

  if (options?.withStdio) {
    servers.push({
      id: 'stdio-backend',
      url: 'stdio://tsx',
      transport: 'stdio',
      command: 'npx',
      args: ['tsx', MOCK_STDIO_SERVER],
      cache: { default_ttl: 30 },
    });
  }

  const partial: Record<string, unknown> = {
    gateway: { port: 0, host: '127.0.0.1' },
    servers,
    router: { namespace_strategy: 'prefix' },
    observability: { db_path: ':memory:', retention_days: 1 },
    admin: { allow_private_networks: true },
  };

  if (options?.withL2 && options.redisUrl) {
    partial['cache'] = {
      enabled: true,
      l1: { max_entries: 1000, max_entry_size_kb: 64 },
      l2: {
        enabled: true,
        redis_url: options.redisUrl,
        default_ttl_multiplier: 2,
      },
    };
  }

  const config = mergeWithDefaults(partial);
  const gateway = new ConduitGateway(config);
  await gateway.initialize();
  const app = gateway.createApp();

  return { gateway, app, httpMock };
}

export async function teardownIntegration(ctx: IntegrationContext): Promise<void> {
  await ctx.gateway.stop(1000);
  await ctx.httpMock.close();
}
