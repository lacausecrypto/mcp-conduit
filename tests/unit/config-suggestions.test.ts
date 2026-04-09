/**
 * Tests for unknown config key detection with "did you mean?" suggestions.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump as yamlDump } from 'js-yaml';

function writeTmp(obj: Record<string, unknown>): string {
  const path = join(tmpdir(), `conduit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`);
  writeFileSync(path, yamlDump(obj), 'utf-8');
  return path;
}

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

describe('Unknown config key warnings', () => {
  it('warns about "rate_limit" suggesting "rate_limits"', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmp({
      servers: [{ id: 'test', url: 'http://localhost:3000/mcp', cache: { default_ttl: 0 } }],
      rate_limit: { enabled: true },
    });
    tmpFiles.push(path);

    loadConfig(path);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('rate_limit'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('rate_limits'));
    spy.mockRestore();
  });

  it('warns about "server" suggesting "servers"', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmp({
      servers: [{ id: 'test', url: 'http://localhost:3000/mcp', cache: { default_ttl: 0 } }],
      server: [{}],
    });
    tmpFiles.push(path);

    loadConfig(path);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('server'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('servers'));
    spy.mockRestore();
  });

  it('warns about "caching" suggesting "cache"', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmp({
      servers: [{ id: 'test', url: 'http://localhost:3000/mcp', cache: { default_ttl: 0 } }],
      caching: { enabled: true },
    });
    tmpFiles.push(path);

    loadConfig(path);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('caching'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('cache'));
    spy.mockRestore();
  });

  it('warns about "guardrail" suggesting "guardrails"', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmp({
      servers: [{ id: 'test', url: 'http://localhost:3000/mcp', cache: { default_ttl: 0 } }],
      guardrail: { enabled: true },
    });
    tmpFiles.push(path);

    loadConfig(path);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('guardrail'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('guardrails'));
    spy.mockRestore();
  });

  it('warns about completely unknown key without suggestion', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmp({
      servers: [{ id: 'test', url: 'http://localhost:3000/mcp', cache: { default_ttl: 0 } }],
      zzzzzzzzz: true,
    });
    tmpFiles.push(path);

    loadConfig(path);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('zzzzzzzzz'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('ignored'));
    spy.mockRestore();
  });

  it('does NOT warn for known keys', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeTmp({
      servers: [{ id: 'test', url: 'http://localhost:3000/mcp', cache: { default_ttl: 0 } }],
      gateway: { port: 8080 },
      cache: { enabled: true },
    });
    tmpFiles.push(path);

    loadConfig(path);
    const unknownWarnings = spy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('unknown config key'),
    );
    expect(unknownWarnings).toHaveLength(0);
    spy.mockRestore();
  });
});
