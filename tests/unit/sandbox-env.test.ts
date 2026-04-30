/**
 * Audit Sprint 3 #6 — sandbox parent-env contamination.
 *
 * Even when the operator chose `sanitize_env: false` (inherit parent env),
 * a fixed denylist of high-risk variables must never leak into the child:
 * registry-credentials and CI tokens for npm/pip/cargo/cloud SDKs. This
 * file covers the strip helper independently of process spawning.
 */

import { describe, it, expect } from 'vitest';
import {
  stripSandboxLeakyEnv,
  buildManagedRuntimeLaunchSpec,
} from '../../src/runtime/managed.js';
import type { ServerConfig } from '../../src/config/types.js';

describe('stripSandboxLeakyEnv (audit Sprint 3 #6)', () => {
  it('removes every npm_config_* variable', () => {
    const result = stripSandboxLeakyEnv({
      PATH: '/usr/bin',
      npm_config_registry: 'https://hostile.example.com/',
      npm_config_cafile: '/etc/hostile.pem',
      npm_config_userconfig: '/home/ci/.npmrc',
      NPM_CONFIG_TOKEN: 'top-secret',
    });
    expect(result['PATH']).toBe('/usr/bin');
    expect(result['npm_config_registry']).toBeUndefined();
    expect(result['npm_config_cafile']).toBeUndefined();
    expect(result['npm_config_userconfig']).toBeUndefined();
    expect(result['NPM_CONFIG_TOKEN']).toBeUndefined();
  });

  it('removes pip_, pipx_, poetry_, uv_, cargo_ prefixes (case-insensitive)', () => {
    const result = stripSandboxLeakyEnv({
      PATH: '/usr/bin',
      PIP_INDEX_URL: 'https://hostile/',
      pipx_default_python: '/usr/bin/python',
      poetry_http_basic_pypi_username: 'ci',
      UV_INDEX_URL: 'https://hostile/',
      cargo_http_check_revoke: 'false',
    });
    expect(Object.keys(result)).toEqual(['PATH']);
  });

  it('removes well-known credential keys (NPM_TOKEN, GITHUB_TOKEN, AWS_*)', () => {
    const result = stripSandboxLeakyEnv({
      PATH: '/usr/bin',
      NPM_TOKEN: 'secret-1',
      NODE_AUTH_TOKEN: 'secret-2',
      GITHUB_TOKEN: 'secret-3',
      GH_TOKEN: 'secret-4',
      GITLAB_TOKEN: 'secret-5',
      NUGET_API_KEY: 'secret-6',
      AWS_ACCESS_KEY_ID: 'AKIA...',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'session',
      GOOGLE_APPLICATION_CREDENTIALS: '/etc/creds.json',
      CONDUIT_ADMIN_KEY: 'admin-key',
    });
    expect(Object.keys(result)).toEqual(['PATH']);
  });

  it('preserves everything else (PATH, HOME, locale, custom app vars)', () => {
    const result = stripSandboxLeakyEnv({
      PATH: '/usr/bin',
      HOME: '/home/conduit',
      LANG: 'en_US.UTF-8',
      MY_APP_FEATURE_FLAG: 'on',
      CUSTOM_VAR: 'value',
    });
    expect(result).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/conduit',
      LANG: 'en_US.UTF-8',
      MY_APP_FEATURE_FLAG: 'on',
      CUSTOM_VAR: 'value',
    });
  });

  it('drops undefined values without error', () => {
    const result = stripSandboxLeakyEnv({
      PATH: '/usr/bin',
      MAYBE_DEFINED: undefined,
    });
    expect(result['PATH']).toBe('/usr/bin');
    expect('MAYBE_DEFINED' in result).toBe(false);
  });

  it('case-insensitive matching catches Python uppercase variants', () => {
    const result = stripSandboxLeakyEnv({
      PIP_CONFIG_FILE: '/etc/pip.conf',
      Pip_Disable_Pip_Version_Check: '1',
      UV_CACHE_DIR: '/cache',
    });
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe('buildManagedRuntimeLaunchSpec env composition (audit Sprint 3 #6)', () => {
  // Helper: a minimal managed-runtime server config to exercise the launch
  // spec composition path without actually spawning a process.
  function makeManagedServer(opts: { sanitizeEnv: boolean }): ServerConfig {
    return {
      id: 'sb-test',
      url: 'stdio://noop',
      transport: 'stdio',
      cache: { default_ttl: 0 },
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      managed_runtime: {
        enabled: true,
        source_type: 'command',
        source_ref: 'noop',
        channel: 'stable',
        active_release_id: 'r1',
        sandbox: {
          enabled: true,
          // The strip is applied even when sanitize_env: false, so verify
          // the audit-mandated keys cannot leak through either mode.
          sanitize_env: opts.sanitizeEnv,
          root_dir: '/tmp/conduit-test-sandbox',
        },
        releases: [
          {
            id: 'r1',
            version: '1.0.0',
            channel: 'stable',
            command: 'node',
            args: ['-e', 'process.exit(0)'],
            created_at: new Date().toISOString(),
          },
        ],
      },
    };
  }

  // We cannot mutate global process.env reliably across tests, so we
  // monkey-patch only for the duration of a single launch-spec call.
  function withParentEnv<T>(
    extra: Record<string, string | undefined>,
    fn: () => T,
  ): T {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(extra)) saved[key] = process.env[key];
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { return fn(); }
    finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('does not leak npm_config_* into the launch spec when sanitize_env=false', () => {
    const server = makeManagedServer({ sanitizeEnv: false });
    const spec = withParentEnv(
      {
        npm_config_registry: 'https://hostile/',
        NPM_TOKEN: 'leak-me',
        PATH: '/usr/bin',
      },
      () => buildManagedRuntimeLaunchSpec(server),
    );
    expect(spec).not.toBeNull();
    expect(spec!.env['npm_config_registry']).toBeUndefined();
    expect(spec!.env['NPM_TOKEN']).toBeUndefined();
    // The gateway-controlled npm_config_cache is re-injected after the strip
    // and should be present (points inside the sandbox root).
    expect(spec!.env['npm_config_cache']).toContain('npm-cache');
  });

  it('does not leak credentials when sanitize_env=true (allowlist mode)', () => {
    const server = makeManagedServer({ sanitizeEnv: true });
    const spec = withParentEnv(
      {
        AWS_ACCESS_KEY_ID: 'AKIA-leak',
        GITHUB_TOKEN: 'gh-leak',
      },
      () => buildManagedRuntimeLaunchSpec(server),
    );
    expect(spec).not.toBeNull();
    expect(spec!.env['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(spec!.env['GITHUB_TOKEN']).toBeUndefined();
  });
});
