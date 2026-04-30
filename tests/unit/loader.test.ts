/**
 * Tests for src/config/loader.ts
 * Covers: loadConfig, loadConfigFromEnv, applyEnvOverrides
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Environment variables used by the loader */
const LOADER_ENV_VARS = [
  'CONDUIT_CONFIG', 'CONDUIT_PORT', 'CONDUIT_HOST', 'CONDUIT_DB_PATH', 'CONDUIT_ADMIN_KEY',
  'CONDUIT_METRICS_PORT', 'CONDUIT_LOG_ARGS', 'CONDUIT_TLS_ENABLED', 'CONDUIT_TLS_CERT',
  'CONDUIT_TLS_KEY', 'CONDUIT_REDIS_URL',
];

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const v of LOADER_ENV_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('loadConfig', () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'conduit-loader-test-'));
    savedEnv = saveEnv();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
    restoreEnv(savedEnv);
    exitSpy.mockRestore();
  });

  it('loads a valid YAML config with custom gateway port', async () => {
    const { loadConfig } = await import('../../src/config/loader.js');
    const configPath = join(tmpDir, 'valid.yml');
    writeFileSync(configPath, `
gateway:
  port: 9000
  host: "127.0.0.1"
servers: []
`);
    const config = loadConfig(configPath);
    expect(config.gateway.port).toBe(9000);
    expect(config.gateway.host).toBe('127.0.0.1');
  });

  it('applies default values for missing fields', async () => {
    const { loadConfig } = await import('../../src/config/loader.js');
    const configPath = join(tmpDir, 'minimal.yml');
    writeFileSync(configPath, 'servers: []\n');
    const config = loadConfig(configPath);
    expect(config.cache.enabled).toBe(true);
    expect(config.router.namespace_strategy).toBe('prefix');
  });

  it('throws with clear message when config file does not exist', async () => {
    const { loadConfig } = await import('../../src/config/loader.js');
    expect(() => loadConfig('/nonexistent/path/to/config.yml'))
      .toThrow('Impossible de lire le fichier de configuration');
  });

  it('throws with YAML error message for malformed YAML', async () => {
    const { loadConfig } = await import('../../src/config/loader.js');
    const configPath = join(tmpDir, 'bad.yml');
    writeFileSync(configPath, 'key: {invalid: yaml: {{{{{');
    expect(() => loadConfig(configPath)).toThrow('Erreur de parsing YAML');
  });

  it('throws for non-object YAML root value', async () => {
    const { loadConfig } = await import('../../src/config/loader.js');
    const configPath = join(tmpDir, 'string.yml');
    writeFileSync(configPath, '"just a string"');
    expect(() => loadConfig(configPath)).toThrow('objet YAML valide');
  });

  it('uses defaults for completely empty YAML file', async () => {
    const { loadConfig } = await import('../../src/config/loader.js');
    const configPath = join(tmpDir, 'empty.yml');
    writeFileSync(configPath, '');
    const config = loadConfig(configPath);
    expect(config.gateway.port).toBe(8080);
  });

  it('applies CONDUIT_PORT env override when loading from file', async () => {
    const { loadConfig } = await import('../../src/config/loader.js');
    const configPath = join(tmpDir, 'base.yml');
    writeFileSync(configPath, 'servers: []\n');
    process.env['CONDUIT_PORT'] = '7777';
    const config = loadConfig(configPath);
    expect(config.gateway.port).toBe(7777);
  });

  it('ignores CONDUIT_PORT when value is not numeric', async () => {
    const { loadConfig } = await import('../../src/config/loader.js');
    const configPath = join(tmpDir, 'base2.yml');
    writeFileSync(configPath, 'gateway:\n  port: 9000\nservers: []\n');
    process.env['CONDUIT_PORT'] = 'not-a-number';
    const config = loadConfig(configPath);
    expect(config.gateway.port).toBe(9000);
  });
});

describe('loadConfigFromEnv - zero-config mode', () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;
  let savedCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'conduit-zeroconfig-'));
    savedEnv = saveEnv();
    savedCwd = process.cwd();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // Change to empty tmpDir so no default config file exists
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(tmpDir, { recursive: true });
    restoreEnv(savedEnv);
    exitSpy.mockRestore();
  });

  it('starts with defaults when no config file exists and CONDUIT_CONFIG not set', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    const config = loadConfigFromEnv();
    expect(config.gateway.port).toBe(8080);
    expect(config.gateway.host).toBe('127.0.0.1');
  });

  it('applies CONDUIT_PORT override in zero-config mode', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    process.env['CONDUIT_PORT'] = '9001';
    const config = loadConfigFromEnv();
    expect(config.gateway.port).toBe(9001);
  });

  it('applies CONDUIT_HOST override in zero-config mode', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    process.env['CONDUIT_HOST'] = '192.168.1.100';
    const config = loadConfigFromEnv();
    expect(config.gateway.host).toBe('192.168.1.100');
  });

  it('applies CONDUIT_DB_PATH override in zero-config mode', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    process.env['CONDUIT_DB_PATH'] = '/tmp/conduit-test.db';
    const config = loadConfigFromEnv();
    expect(config.observability.db_path).toBe('/tmp/conduit-test.db');
  });

  it('applies CONDUIT_ADMIN_KEY override in zero-config mode', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    process.env['CONDUIT_ADMIN_KEY'] = 'super-secret-key';
    const config = loadConfigFromEnv();
    expect(config.admin?.key).toBe('super-secret-key');
  });

  it('applies CONDUIT_METRICS_PORT override in zero-config mode', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    process.env['CONDUIT_METRICS_PORT'] = '9999';
    const config = loadConfigFromEnv();
    expect(config.metrics.port).toBe(9999);
  });

  it('applies CONDUIT_LOG_ARGS=false override', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    process.env['CONDUIT_LOG_ARGS'] = 'false';
    const config = loadConfigFromEnv();
    expect(config.observability.log_args).toBe(false);
  });

  it('applies CONDUIT_LOG_ARGS=true override', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    process.env['CONDUIT_LOG_ARGS'] = 'true';
    const config = loadConfigFromEnv();
    expect(config.observability.log_args).toBe(true);
  });

  it('applies CONDUIT_LOG_ARGS=FALSE (case insensitive)', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    process.env['CONDUIT_LOG_ARGS'] = 'FALSE';
    const config = loadConfigFromEnv();
    expect(config.observability.log_args).toBe(false);
  });

  it('applies CONDUIT_TLS_ENABLED=true override with cert/key files', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    // Create fake cert/key files so validation passes
    const fakeCert = join(tmpDir, 'cert.pem');
    const fakeKey = join(tmpDir, 'key.pem');
    writeFileSync(fakeCert, 'fake-cert');
    writeFileSync(fakeKey, 'fake-key');

    process.env['CONDUIT_TLS_ENABLED'] = 'true';
    process.env['CONDUIT_TLS_CERT'] = fakeCert;
    process.env['CONDUIT_TLS_KEY'] = fakeKey;

    const config = loadConfigFromEnv();
    expect(config.gateway.tls?.enabled).toBe(true);
    expect(config.gateway.tls?.cert_path).toBe(fakeCert);
    expect(config.gateway.tls?.key_path).toBe(fakeKey);
  });

  it('applies CONDUIT_TLS_CERT and CONDUIT_TLS_KEY without CONDUIT_TLS_ENABLED', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    const fakeCert = join(tmpDir, 'cert2.pem');
    const fakeKey = join(tmpDir, 'key2.pem');
    writeFileSync(fakeCert, 'fake');
    writeFileSync(fakeKey, 'fake');

    process.env['CONDUIT_TLS_CERT'] = fakeCert;
    process.env['CONDUIT_TLS_KEY'] = fakeKey;

    const config = loadConfigFromEnv();
    expect(config.gateway.tls?.cert_path).toBe(fakeCert);
    expect(config.gateway.tls?.key_path).toBe(fakeKey);
  });

  it('applies CONDUIT_REDIS_URL override', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    process.env['CONDUIT_REDIS_URL'] = 'redis://myhost:6380/2';
    const config = loadConfigFromEnv();
    expect(config.rate_limits?.redis_url).toBe('redis://myhost:6380/2');
  });

  it('loads from CONDUIT_CONFIG when set to existing file', async () => {
    const { loadConfigFromEnv } = await import('../../src/config/loader.js');
    const configPath = join(tmpDir, 'custom.yml');
    writeFileSync(configPath, 'gateway:\n  port: 6543\nservers: []\n');
    process.env['CONDUIT_CONFIG'] = configPath;
    const config = loadConfigFromEnv();
    expect(config.gateway.port).toBe(6543);
  });
});
