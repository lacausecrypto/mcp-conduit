/**
 * Battle-test #3 — DNS-rebinding-resistant fetch.
 *
 * Validates that pinnedFetch:
 *   - dispatches to the pre-validated IP regardless of DNS state
 *   - preserves the original Host header so virtual hosts still work
 *   - times out via AbortSignal
 *   - returns a usable Web Response with body stream
 *
 * The descriptor fetcher already wires this in (see connect-descriptor.test.ts),
 * but unit-level coverage here pins the contract independently.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { pinnedFetch } from '../../src/utils/pinned-fetch.js';

interface Captured {
  hostHeader?: string;
  remoteAddress?: string;
  method?: string;
  url?: string;
}

describe('pinnedFetch (battle-test #3)', () => {
  let server: Server;
  let port: number;
  const captured: Captured[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      captured.push({
        hostHeader: req.headers['host'],
        remoteAddress: req.socket.remoteAddress ?? undefined,
        method: req.method,
        url: req.url,
      });
      if (req.url === '/slow') {
        // Never respond — let the test trigger AbortSignal.
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/redirected' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('dispatches to the pinned IP and preserves the original Host header', async () => {
    captured.length = 0;
    const url = new URL(`http://hostile.example.test:${port}/data`);
    const res = await pinnedFetch(url, {
      pinnedIp: '127.0.0.1',
      family: 4,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe('/data');

    const c = captured[0];
    expect(c?.hostHeader).toContain('hostile.example.test'); // original host preserved
    expect(c?.remoteAddress?.endsWith('127.0.0.1')).toBe(true);
  });

  it('returns redirect responses untouched (manual redirect mode)', async () => {
    const url = new URL(`http://anywhere.test:${port}/redirect`);
    const res = await pinnedFetch(url, {
      pinnedIp: '127.0.0.1',
      family: 4,
      init: { redirect: 'manual' },
    });
    // Even though the test server actually responds 302, pinnedFetch passes
    // it through — descriptor.ts handles redirects in user-space, validating
    // each hop separately.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/redirected');
  });

  it('honors AbortSignal (used by the descriptor timeout)', async () => {
    const url = new URL(`http://slow.test:${port}/slow`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await expect(
      pinnedFetch(url, {
        pinnedIp: '127.0.0.1',
        family: 4,
        init: { signal: controller.signal },
      }),
    ).rejects.toThrow();
  });

  it('rejects non-http(s) protocols at the call site', async () => {
    await expect(
      pinnedFetch('ftp://anywhere.test/data', { pinnedIp: '127.0.0.1', family: 4 }),
    ).rejects.toThrow(/only supports http/i);
  });

  it('does not perform a real DNS lookup — pinned IP wins even for nonsense hostnames', async () => {
    captured.length = 0;
    // The hostname here resolves to nothing; only the pinned IP matters.
    const url = new URL(`http://this-host-does-not-exist-anywhere.invalid:${port}/check`);
    const res = await pinnedFetch(url, { pinnedIp: '127.0.0.1', family: 4 });
    expect(res.status).toBe(200);
    expect(captured[0]?.hostHeader).toContain('this-host-does-not-exist-anywhere.invalid');
  });
});
