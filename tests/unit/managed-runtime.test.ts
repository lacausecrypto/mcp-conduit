import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../src/config/types.js';
import {
  buildManagedRuntimeLaunchSpec,
  createManagedRuntimeForPackage,
  getActiveManagedRelease,
  rollbackManagedRuntime,
  rolloutManagedRuntime,
} from '../../src/runtime/managed.js';
import { assertSafeSystemPath } from '../../src/utils/path-guard.js';

function makeManagedServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const managed = createManagedRuntimeForPackage({
    serverId: 'pkg-server',
    sourceType: 'npm',
    sourceRef: '@example/pkg-server',
    version: '1.0.0',
    command: 'npx',
    args: ['-y', '@example/pkg-server@1.0.0'],
    env: { API_TOKEN: 'secret-1' },
  });

  return {
    id: 'pkg-server',
    url: 'stdio://npx/@example/pkg-server',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@example/pkg-server@1.0.0'],
    env: { API_TOKEN: 'secret-1' },
    cache: { default_ttl: 0 },
    managed_runtime: managed,
    ...overrides,
  };
}

describe('managed runtime', () => {
  it('builds an isolated spawn spec for stdio servers', () => {
    const server = makeManagedServer();

    const spec = buildManagedRuntimeLaunchSpec(server);

    expect(spec).not.toBeNull();
    expect(spec?.command).toBe('npx');
    expect(spec?.args).toEqual(['-y', '@example/pkg-server@1.0.0']);
    expect(spec?.cwd).toContain('.conduit/runtime/pkg-server');
    expect(spec?.env['HOME']).toContain('.conduit/runtime/pkg-server');
    expect(spec?.env['API_TOKEN']).toBe('secret-1');
    expect(spec?.env['CONDUIT_SANDBOX_ROOT']).toContain('.conduit/runtime/pkg-server');
  });

  it('creates a candidate release during rollout with a pinned version', () => {
    const server = makeManagedServer();

    const result = rolloutManagedRuntime(server, {
      version: '1.1.0',
      channel: 'canary',
      env: { API_TOKEN: 'secret-2' },
    });

    expect(result.release.version).toBe('1.1.0');
    expect(result.release.channel).toBe('canary');
    expect(result.server.command).toBe('npx');
    expect(result.server.args).toEqual(['-y', '@example/pkg-server@1.1.0']);
    expect(result.server.env).toEqual({ API_TOKEN: 'secret-2' });
    expect(getActiveManagedRelease(result.server)?.version).toBe('1.1.0');
  });

  it('rolls back to the last healthy release', () => {
    const server = makeManagedServer();
    const rollout = rolloutManagedRuntime(server, {
      version: '2.0.0',
      channel: 'beta',
    });

    const rolledBack = rollbackManagedRuntime(rollout.server);

    expect(getActiveManagedRelease(rolledBack)?.version).toBe('1.0.0');
    expect(rolledBack.args).toEqual(['-y', '@example/pkg-server@1.0.0']);
    expect(rolledBack.managed_runtime?.channel).toBe('stable');
  });
});

// ─── Audit 3.1#12 — sandbox path traversal pin ─────────────────────────────────
//
// `buildManagedRuntimeLaunchSpec` calls `assertSafeSystemPath` on the
// configured `sandbox.root_dir`. We assert that:
//   1. assertSafeSystemPath rejects sensitive system roots regardless of the
//      number of `..` segments used to reach them.
//   2. `buildManagedRuntimeLaunchSpec` propagates that rejection — i.e. the
//      managed runtime cannot be coerced into spawning with HOME=/etc.

describe('managed runtime — sandbox path traversal', () => {
  // Linux-style. On Windows the same code uses WINDOWS_BLOCKED_PREFIXES.
  const sensitivePaths = process.platform === 'win32'
    ? ['C:\\Windows\\System32', 'C:\\Program Files', 'c:/programdata']
    : ['/etc/passwd', '/etc', '/root', '/proc/self', '/sys/kernel', '/var/log/auth.log', '/dev/null', '/boot/initrd'];

  for (const path of sensitivePaths) {
    it(`assertSafeSystemPath rejects sensitive path "${path}"`, () => {
      expect(() => assertSafeSystemPath(path, 'managed_runtime.sandbox.root_dir')).toThrow(/restricted system directory/i);
    });
  }

  if (process.platform !== 'win32') {
    it('rejects path traversal sequences that resolve to a blocked root (../../../etc/passwd from /var)', () => {
      expect(() => assertSafeSystemPath('/var/data/../../../etc/passwd', 'managed_runtime.sandbox.root_dir'))
        .toThrow(/restricted system directory/i);
    });

    it('rejects relative paths that resolve via cwd into /etc (only when cwd happens to be /tmp etc.)', () => {
      // The function uses `resolve(path)` against the current cwd. Use a path
      // we know will land in /etc regardless: "//etc/foo" → resolves to /etc/foo.
      expect(() => assertSafeSystemPath('//etc/foo', 'sandbox')).toThrow(/restricted system directory/i);
    });
  }

  it('accepts a benign path under user home / temp', () => {
    // Resolve from cwd; landing under repo or user dir is safe.
    expect(() => assertSafeSystemPath('./.conduit/sandbox/srv', 'sandbox')).not.toThrow();
  });

  it('buildManagedRuntimeLaunchSpec rejects a server whose sandbox.root_dir is restricted', () => {
    // Build a managed server with sandbox.root_dir aimed at /etc.
    const server = makeManagedServer({
      managed_runtime: {
        ...createManagedRuntimeForPackage({
          serverId: 'evil',
          sourceType: 'npm',
          sourceRef: '@evil/pkg',
          version: '1.0.0',
          command: 'npx',
          args: ['-y', '@evil/pkg@1.0.0'],
        }),
        sandbox: {
          enabled: true,
          root_dir: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/conduit-sandbox',
          allow_network: true,
        },
      },
    });
    expect(() => buildManagedRuntimeLaunchSpec(server)).toThrow(/restricted system directory/i);
  });
});

// ─── Audit 3.1#13 — buildVersionedPackageIdentifier metachar pin ──────────────
//
// `buildVersionedPackageIdentifier` is private but exercised via
// `rolloutManagedRuntime`. We confirm that:
//   1. Shell metacharacters in the version are passed as a single argv token,
//      NOT shell-evaluated. Since spawn() is invoked with `shell: false` on
//      Unix and the metachar guard runs on Windows, no execution happens.
//   2. Existing version pinning in identifier (already `@x.y.z`) is preserved
//      and not double-suffixed.

describe('managed runtime — package identifier metachar resilience', () => {
  it('treats a shell-metachar version as opaque text in argv (no string concat into shell command)', () => {
    const server = makeManagedServer();
    const malicious = '1.0.0; rm -rf /tmp';
    const rollout = rolloutManagedRuntime(server, { version: malicious, channel: 'stable' });
    expect(rollout.server.args).toEqual(['-y', `@example/pkg-server@${malicious}`]);
    // Critical: the metachars are preserved as a single argv element. spawn()
    // with shell:false (Unix path) passes this verbatim to the binary.
    // On Windows, src/proxy/stdio-mcp-client.ts:368 runs assertNoShellMetacharacters
    // which would reject before spawn — that platform invariant is tested
    // elsewhere; here we just confirm argv shape.
  });

  it('preserves an already-pinned scoped package version (no double @)', () => {
    // Identifier already contains "@v" → not appended again.
    const server: ServerConfig = makeManagedServer({
      managed_runtime: createManagedRuntimeForPackage({
        serverId: 'pkg-server',
        sourceType: 'npm',
        sourceRef: '@example/pkg-server@1.0.0',
        version: '',
        command: 'npx',
        args: ['-y', '@example/pkg-server@1.0.0'],
      }),
    });
    const rollout = rolloutManagedRuntime(server, { version: '2.0.0' });
    // Source ref already pinned at @1.0.0 so version is ignored.
    expect(rollout.server.args).toEqual(['-y', '@example/pkg-server@1.0.0']);
  });

  it('handles an unpinned scoped package by appending @<version>', () => {
    const server: ServerConfig = makeManagedServer({
      managed_runtime: createManagedRuntimeForPackage({
        serverId: 'pkg-server',
        sourceType: 'npm',
        sourceRef: '@example/pkg-server',
        version: '1.0.0',
        command: 'npx',
        args: ['-y', '@example/pkg-server@1.0.0'],
      }),
    });
    const rollout = rolloutManagedRuntime(server, { version: '3.0.0' });
    expect(rollout.server.args).toEqual(['-y', '@example/pkg-server@3.0.0']);
  });

  it('handles an unscoped package (no leading @)', () => {
    const server: ServerConfig = {
      id: 'classic',
      url: 'stdio://npx/classic',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'classic@1.0.0'],
      cache: { default_ttl: 0 },
      managed_runtime: createManagedRuntimeForPackage({
        serverId: 'classic',
        sourceType: 'npm',
        sourceRef: 'classic',
        version: '1.0.0',
        command: 'npx',
        args: ['-y', 'classic@1.0.0'],
      }),
    };
    const rollout = rolloutManagedRuntime(server, { version: '2.0.0' });
    expect(rollout.server.args).toEqual(['-y', 'classic@2.0.0']);
  });

  it('does not allow version with embedded backticks/$() to escape argv (still single token)', () => {
    const server = makeManagedServer();
    const malicious = '1.0.0`whoami`$(touch /tmp/pwn)';
    const rollout = rolloutManagedRuntime(server, { version: malicious });
    expect(rollout.server.args).toHaveLength(2);
    // Single argv token — no splitting on backticks/$.
    expect(rollout.server.args[1]).toBe(`@example/pkg-server@${malicious}`);
  });
});
