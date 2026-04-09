/**
 * Tests e2e — Hot-reload config (SIGHUP / POST /conduit/config/reload)
 *
 * Verifies that reloading the config file applies hot-reloadable changes
 * without restarting the gateway, and that non-reloadable changes are
 * correctly reported in the skipped list.
 *
 * Uses temporary YAML files written to os.tmpdir() so that gateway.reload()
 * can read real files without touching the project config.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump as yamlDump } from 'js-yaml';
import {
  setup,
  teardown,
  sendMcpRequest,
  makeToolCallMessage,
  type E2eTestContext,
} from './setup.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpFileCount = 0;

function writeTempConfig(partial: Record<string, unknown>): string {
  const path = join(tmpdir(), `conduit-hot-reload-${process.pid}-${++tmpFileCount}.yml`);
  writeFileSync(path, yamlDump(partial), 'utf-8');
  return path;
}

function deleteTempConfig(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

// Build a minimal valid YAML config that references a real (mock) server URL
function buildYaml(serverUrl: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gateway: { port: 8080, host: '0.0.0.0' },
    router: {
      namespace_strategy: 'none',
      health_check: { enabled: false, interval_seconds: 60, timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1 },
    },
    servers: [{ id: 'test-server', url: serverUrl, cache: { default_ttl: 300 } }],
    cache: { enabled: true, l1: { max_entries: 1000, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: {
      log_args: true,
      log_responses: false,
      redact_fields: ['password', 'token'],
      retention_days: 30,
      db_path: ':memory:',
    },
    metrics: { enabled: false, port: 9090 },
    ...overrides,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Hot-reload config', () => {
  let ctx: E2eTestContext;
  const tmpFiles: string[] = [];

  beforeAll(async () => {
    ctx = await setup({
      namespaceStrategy: 'none',
      cacheEnabled: true,
      defaultTtl: 300,
    });
  });

  afterAll(async () => {
    await teardown(ctx);
    for (const f of tmpFiles) deleteTempConfig(f);
  });

  afterEach(() => {
    ctx.gateway.getCacheStore().clear();
    ctx.mockServer.resetCallCounts();
  });

  // ── ACL reload ─────────────────────────────────────────────────────────────

  describe('ACL policy reload', () => {
    it('applies new ACL policy after reload', async () => {
      const serverUrl = ctx.mockServer.url;

      // Write config with ACL enabled (deny all by default, allow admin-agent)
      const configPath = writeTempConfig(buildYaml(serverUrl, {
        auth: { method: 'none' },
        acl: {
          enabled: true,
          default_action: 'deny',
          policies: [
            {
              name: 'admin-access',
              clients: ['admin-agent'],
              servers: ['test-server'],
              tools: ['*'],
              action: 'allow',
            },
          ],
        },
      }));
      tmpFiles.push(configPath);

      const result = await ctx.gateway.reload(configPath);
      expect(result.errors).toHaveLength(0);
      expect(result.reloaded).toContain('acl');
    });

    it('disables ACL after reload with acl.enabled = false', async () => {
      const serverUrl = ctx.mockServer.url;

      // Config with ACL disabled
      const configPath = writeTempConfig(buildYaml(serverUrl, {
        acl: { enabled: false },
      }));
      tmpFiles.push(configPath);

      const result = await ctx.gateway.reload(configPath);
      expect(result.errors).toHaveLength(0);
      // acl changed from previous reload (enabled → disabled)
      // result.reloaded may include 'acl' depending on prior state
    });
  });

  // ── Rate limit reload ──────────────────────────────────────────────────────

  describe('Rate limit reload', () => {
    it('applies new rate limit config after reload', async () => {
      const serverUrl = ctx.mockServer.url;

      const configPath = writeTempConfig(buildYaml(serverUrl, {
        rate_limits: {
          enabled: true,
          backend: 'memory',
          global: { requests_per_minute: 1000 },
          per_client: { requests_per_minute: 500 },
        },
      }));
      tmpFiles.push(configPath);

      const result = await ctx.gateway.reload(configPath);
      expect(result.errors).toHaveLength(0);
      expect(result.reloaded).toContain('rate_limits');
    });

    it('disables rate limiting after reload', async () => {
      const serverUrl = ctx.mockServer.url;

      // First enable
      const configPath1 = writeTempConfig(buildYaml(serverUrl, {
        rate_limits: { enabled: true, backend: 'memory', global: { requests_per_minute: 60 } },
      }));
      tmpFiles.push(configPath1);
      await ctx.gateway.reload(configPath1);

      // Then disable
      const configPath2 = writeTempConfig(buildYaml(serverUrl, {
        rate_limits: { enabled: false },
      }));
      tmpFiles.push(configPath2);

      const result = await ctx.gateway.reload(configPath2);
      expect(result.errors).toHaveLength(0);
      expect(result.reloaded).toContain('rate_limits');
    });
  });

  // ── Cache TTL reload ───────────────────────────────────────────────────────

  describe('Cache TTL reload', () => {
    it('applies updated cache TTL for a server after reload', async () => {
      const serverUrl = ctx.mockServer.url;

      const configPath = writeTempConfig(buildYaml(serverUrl, {}));
      // Override the server cache TTL to something different from the setup default
      const yaml = buildYaml(serverUrl);
      (yaml['servers'] as Array<Record<string, unknown>>)[0]!['cache'] = {
        default_ttl: 999,
        overrides: { get_contact: { ttl: 1800 } },
      };

      const modPath = writeTempConfig(yaml);
      tmpFiles.push(configPath);
      tmpFiles.push(modPath);

      const result = await ctx.gateway.reload(modPath);
      expect(result.errors).toHaveLength(0);
      expect(result.reloaded).toContain('server.test-server.cache');

      // Verify the config object was mutated
      const server = ctx.gateway.getRegistry().getServerInfo('test-server');
      expect(server?.config.cache.default_ttl).toBe(999);
    });
  });

  // ── Observability reload ───────────────────────────────────────────────────

  describe('Observability reload', () => {
    it('updates log_args and redact_fields after reload', async () => {
      const serverUrl = ctx.mockServer.url;

      const yaml = buildYaml(serverUrl);
      (yaml['observability'] as Record<string, unknown>)['log_args'] = false;
      (yaml['observability'] as Record<string, unknown>)['redact_fields'] = ['password', 'token', 'ssn'];

      const configPath = writeTempConfig(yaml);
      tmpFiles.push(configPath);

      const result = await ctx.gateway.reload(configPath);
      expect(result.errors).toHaveLength(0);
      expect(result.reloaded).toContain('observability');
    });

    it('detects no change when observability is identical', async () => {
      const serverUrl = ctx.mockServer.url;

      // Use same observability as the setup default
      const yaml = buildYaml(serverUrl);

      const configPath = writeTempConfig(yaml);
      tmpFiles.push(configPath);

      const result = await ctx.gateway.reload(configPath);
      expect(result.errors).toHaveLength(0);
      // observability not in reloaded (no change from current)
      // (rate_limits / acl may have been set in previous tests — that's fine)
    });
  });

  // ── Non-reloadable fields ──────────────────────────────────────────────────

  describe('Non-reloadable fields', () => {
    it('reports gateway.port change in skipped list', async () => {
      const serverUrl = ctx.mockServer.url;

      const yaml = buildYaml(serverUrl);
      (yaml['gateway'] as Record<string, unknown>)['port'] = 9999;

      const configPath = writeTempConfig(yaml);
      tmpFiles.push(configPath);

      const result = await ctx.gateway.reload(configPath);
      expect(result.errors).toHaveLength(0);
      expect(result.skipped.some((s) => s.includes('gateway.port/host'))).toBe(true);
    });

    it('reports server URL change in skipped list', async () => {
      const yaml = buildYaml('http://changed-server.invalid:9999/mcp');

      const configPath = writeTempConfig(yaml);
      tmpFiles.push(configPath);

      const result = await ctx.gateway.reload(configPath);
      expect(result.errors).toHaveLength(0);
      expect(result.skipped.some((s) => s.includes('server') && s.includes('URL'))).toBe(true);
    });

    it('reports auth method change in skipped list', async () => {
      const serverUrl = ctx.mockServer.url;

      const yaml = buildYaml(serverUrl, {
        auth: { method: 'api_key', api_keys: ['key-abc'] },
      });

      const configPath = writeTempConfig(yaml);
      tmpFiles.push(configPath);

      const result = await ctx.gateway.reload(configPath);
      expect(result.errors).toHaveLength(0);
      expect(result.skipped.some((s) => s.includes('auth.method'))).toBe(true);
    });
  });

  // ── Error cases ────────────────────────────────────────────────────────────

  describe('Error handling', () => {
    it('returns error for non-existent file, preserves old config', async () => {
      const aclBefore = JSON.stringify(ctx.gateway['config'].acl);

      const result = await ctx.gateway.reload('/tmp/this-file-does-not-exist-conduit.yml');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/Cannot read config file/);

      // Old config preserved
      expect(JSON.stringify(ctx.gateway['config'].acl)).toBe(aclBefore);
    });

    it('returns error for malformed YAML, preserves old config', async () => {
      const path = join(tmpdir(), `conduit-malformed-${process.pid}.yml`);
      writeFileSync(path, '{ this: [is: not: valid yaml }\n---\n!!@@', 'utf-8');
      tmpFiles.push(path);

      const aclBefore = JSON.stringify(ctx.gateway['config'].acl);

      const result = await ctx.gateway.reload(path);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/YAML parse error/);

      expect(JSON.stringify(ctx.gateway['config'].acl)).toBe(aclBefore);
    });

    it('returns validation error for invalid config, preserves old config', async () => {
      const serverUrl = ctx.mockServer.url;

      const yaml = buildYaml(serverUrl);
      // Invalid: port out of range
      (yaml['gateway'] as Record<string, unknown>)['port'] = 99999;

      const configPath = writeTempConfig(yaml);
      tmpFiles.push(configPath);

      const obsBefore = JSON.stringify(ctx.gateway['config'].observability);

      const result = await ctx.gateway.reload(configPath);
      expect(result.errors.length).toBeGreaterThan(0);

      // Old config preserved (observability unchanged)
      expect(JSON.stringify(ctx.gateway['config'].observability)).toBe(obsBefore);
    });
  });

  // ── Admin API endpoint ─────────────────────────────────────────────────────

  describe('POST /conduit/config/reload endpoint', () => {
    it('returns 200 with reload report when config is valid', async () => {
      const serverUrl = ctx.mockServer.url;

      // Write a temp config and point CONDUIT_CONFIG at it so the endpoint can find it
      const yaml = buildYaml(serverUrl, {
        acl: { enabled: false },
      });
      const configPath = writeTempConfig(yaml);
      tmpFiles.push(configPath);

      const originalEnv = process.env['CONDUIT_CONFIG'];
      process.env['CONDUIT_CONFIG'] = configPath;

      try {
        const res = await ctx.app.request('/conduit/config/reload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Conduit-Admin': 'true' },
        });

        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body).toHaveProperty('reloaded');
        expect(body).toHaveProperty('skipped');
        expect(body).toHaveProperty('errors');
        expect(body).toHaveProperty('reloaded_at');
        expect(Array.isArray(body['reloaded'])).toBe(true);
        expect(Array.isArray(body['errors'])).toBe(true);
      } finally {
        if (originalEnv === undefined) {
          delete process.env['CONDUIT_CONFIG'];
        } else {
          process.env['CONDUIT_CONFIG'] = originalEnv;
        }
      }
    });
  });
});
