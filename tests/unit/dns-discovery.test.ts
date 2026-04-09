/**
 * Unit tests for DnsDiscoveryBackend.
 *
 * Mocks node:dns/promises to test SRV record parsing,
 * error handling, and server object construction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock resolveSrv before importing the module under test
vi.mock('node:dns/promises', () => ({
  resolveSrv: vi.fn(),
}));

import { resolveSrv } from 'node:dns/promises';
import { DnsDiscoveryBackend } from '../../src/discovery/dns-discovery.js';

const mockResolveSrv = vi.mocked(resolveSrv);

describe('DnsDiscoveryBackend', () => {
  beforeEach(() => {
    mockResolveSrv.mockReset();
    vi.restoreAllMocks();
  });

  // ─── Constructor and properties ─────────────────────────────────────

  describe('properties', () => {
    it('name property is "dns-srv"', () => {
      const backend = new DnsDiscoveryBackend('_mcp._tcp.example.com');
      expect(backend.name).toBe('dns-srv');
    });

    it('constructor stores domain', () => {
      const backend = new DnsDiscoveryBackend('_mcp._tcp.internal.example.com');
      // Domain is private, but we can verify by checking that poll() passes it to resolveSrv
      mockResolveSrv.mockResolvedValue([]);
      backend.poll();
      expect(mockResolveSrv).toHaveBeenCalledWith('_mcp._tcp.internal.example.com');
    });
  });

  // ─── poll() with records ────────────────────────────────────────────

  describe('poll() with records', () => {
    it('returns one server for a single SRV record', async () => {
      mockResolveSrv.mockResolvedValue([
        { name: 'mcp1.example.com', port: 3000, priority: 10, weight: 100 },
      ]);

      const backend = new DnsDiscoveryBackend('_mcp._tcp.example.com');
      const servers = await backend.poll();

      expect(servers).toHaveLength(1);
      expect(servers[0]).toEqual({
        id: 'dns-mcp1.example.com-3000',
        url: 'http://mcp1.example.com:3000/mcp',
        transport: 'http',
      });
    });

    it('returns all servers for multiple SRV records', async () => {
      mockResolveSrv.mockResolvedValue([
        { name: 'mcp1.example.com', port: 3000, priority: 10, weight: 100 },
        { name: 'mcp2.example.com', port: 3001, priority: 20, weight: 50 },
        { name: 'mcp3.example.com', port: 8080, priority: 30, weight: 25 },
      ]);

      const backend = new DnsDiscoveryBackend('_mcp._tcp.example.com');
      const servers = await backend.poll();

      expect(servers).toHaveLength(3);
      expect(servers[0]!.id).toBe('dns-mcp1.example.com-3000');
      expect(servers[1]!.id).toBe('dns-mcp2.example.com-3001');
      expect(servers[2]!.id).toBe('dns-mcp3.example.com-8080');
    });

    it('returns empty array for empty SRV response', async () => {
      mockResolveSrv.mockResolvedValue([]);

      const backend = new DnsDiscoveryBackend('_mcp._tcp.example.com');
      const servers = await backend.poll();

      expect(servers).toEqual([]);
    });
  });

  // ─── Server object format ──────────────────────────────────────────

  describe('server object format', () => {
    it('correct ID format: dns-{host}-{port}', async () => {
      mockResolveSrv.mockResolvedValue([
        { name: 'my-host.local', port: 9090, priority: 10, weight: 100 },
      ]);

      const backend = new DnsDiscoveryBackend('_mcp._tcp.local');
      const servers = await backend.poll();

      expect(servers[0]!.id).toBe('dns-my-host.local-9090');
    });

    it('correct URL format: http://{host}:{port}/mcp', async () => {
      mockResolveSrv.mockResolvedValue([
        { name: 'backend.internal', port: 4567, priority: 10, weight: 100 },
      ]);

      const backend = new DnsDiscoveryBackend('_mcp._tcp.internal');
      const servers = await backend.poll();

      expect(servers[0]!.url).toBe('http://backend.internal:4567/mcp');
    });

    it('transport is always "http"', async () => {
      mockResolveSrv.mockResolvedValue([
        { name: 'a.local', port: 80, priority: 10, weight: 100 },
        { name: 'b.local', port: 443, priority: 10, weight: 100 },
      ]);

      const backend = new DnsDiscoveryBackend('_mcp._tcp.local');
      const servers = await backend.poll();

      expect(servers[0]!.transport).toBe('http');
      expect(servers[1]!.transport).toBe('http');
    });
  });

  // ─── Error handling ─────────────────────────────────────────────────

  describe('error handling', () => {
    it('DNS failure returns empty array', async () => {
      mockResolveSrv.mockRejectedValue(new Error('DNS resolution failed'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const backend = new DnsDiscoveryBackend('_mcp._tcp.example.com');
      const servers = await backend.poll();

      expect(servers).toEqual([]);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toContain('DNS SRV lookup failed');

      warnSpy.mockRestore();
    });

    it('ENOTFOUND returns empty array', async () => {
      const err = new Error('queryA ENOTFOUND _mcp._tcp.nonexistent.example.com');
      (err as NodeJS.ErrnoException).code = 'ENOTFOUND';
      mockResolveSrv.mockRejectedValue(err);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const backend = new DnsDiscoveryBackend('_mcp._tcp.nonexistent.example.com');
      const servers = await backend.poll();

      expect(servers).toEqual([]);
      expect(warnSpy).toHaveBeenCalledOnce();

      warnSpy.mockRestore();
    });

    it('logs warning with domain name on failure', async () => {
      mockResolveSrv.mockRejectedValue(new Error('timeout'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const backend = new DnsDiscoveryBackend('_mcp._tcp.my-special-domain.com');
      await backend.poll();

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toContain('_mcp._tcp.my-special-domain.com');
      expect(warnSpy.mock.calls[0]![0]).toContain('timeout');

      warnSpy.mockRestore();
    });

    it('non-Error throwable is handled gracefully', async () => {
      mockResolveSrv.mockRejectedValue('plain string error');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const backend = new DnsDiscoveryBackend('_mcp._tcp.example.com');
      const servers = await backend.poll();

      expect(servers).toEqual([]);
      expect(warnSpy).toHaveBeenCalledOnce();

      warnSpy.mockRestore();
    });
  });

  // ─── Multiple polls ─────────────────────────────────────────────────

  describe('multiple polls', () => {
    it('poll() can be called multiple times with different results', async () => {
      mockResolveSrv
        .mockResolvedValueOnce([
          { name: 'v1.local', port: 3000, priority: 10, weight: 100 },
        ])
        .mockResolvedValueOnce([
          { name: 'v2.local', port: 3001, priority: 10, weight: 100 },
          { name: 'v3.local', port: 3002, priority: 10, weight: 100 },
        ]);

      const backend = new DnsDiscoveryBackend('_mcp._tcp.local');

      const first = await backend.poll();
      expect(first).toHaveLength(1);
      expect(first[0]!.id).toBe('dns-v1.local-3000');

      const second = await backend.poll();
      expect(second).toHaveLength(2);
      expect(second[0]!.id).toBe('dns-v2.local-3001');
      expect(second[1]!.id).toBe('dns-v3.local-3002');
    });

    it('poll() recovers after a failure', async () => {
      mockResolveSrv
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce([
          { name: 'recovered.local', port: 3000, priority: 10, weight: 100 },
        ]);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const backend = new DnsDiscoveryBackend('_mcp._tcp.local');

      const first = await backend.poll();
      expect(first).toEqual([]);

      const second = await backend.poll();
      expect(second).toHaveLength(1);
      expect(second[0]!.url).toBe('http://recovered.local:3000/mcp');

      warnSpy.mockRestore();
    });
  });
});
