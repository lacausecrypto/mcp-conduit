import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetDnsLookup,
  _setDnsLookup,
  validateServerUrl,
  validateServerUrlWithDns,
} from '../../src/utils/url-validator.js';

describe('url validator', () => {
  afterEach(() => {
    _resetDnsLookup();
  });

  it('blocks direct loopback IPv4 addresses by default', () => {
    const result = validateServerUrl('http://127.0.0.1:3000/mcp');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('loopback');
  });

  it('blocks localhost hostnames by default', () => {
    const result = validateServerUrl('http://localhost:3000/mcp');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('loopback hostname');
  });

  it('blocks hostnames that resolve to loopback addresses', async () => {
    _setDnsLookup(async () => [{ address: '127.0.0.1', family: 4 }]);

    const result = await validateServerUrlWithDns('https://descriptor.example.com/server.json');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('resolves to a blocked address');
  });

  it('allows private hosts only when explicitly opted in', async () => {
    _setDnsLookup(async () => [{ address: '127.0.0.1', family: 4 }]);

    const result = await validateServerUrlWithDns('http://localhost:3000/mcp', true);
    expect(result).toEqual({ valid: true });
  });

  // ── Audit Sprint 3 #1 — IPv4-mapped IPv6 SSRF ──────────────────────────────
  describe('IPv4-mapped IPv6 (audit Sprint 3 #1)', () => {
    it('blocks ::ffff:127.0.0.1 (loopback wrapped in IPv6)', () => {
      const result = validateServerUrl('http://[::ffff:127.0.0.1]:3000/mcp');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('IPv4-mapped');
    });

    it('blocks ::ffff:169.254.169.254 (cloud metadata wrapped in IPv6)', () => {
      const result = validateServerUrl('http://[::ffff:169.254.169.254]/');
      expect(result.valid).toBe(false);
      expect(result.error?.toLowerCase()).toMatch(/metadata|link-local/);
    });

    it('blocks ::ffff:10.0.0.5 (RFC 1918 class A wrapped)', () => {
      const result = validateServerUrl('http://[::ffff:10.0.0.5]:80/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('IPv4-mapped');
    });

    it('blocks the hex-only mapped form (::ffff:7f00:0001 == 127.0.0.1)', () => {
      const result = validateServerUrl('http://[::ffff:7f00:1]/');
      expect(result.valid).toBe(false);
    });

    it('blocks the IPv4-compatible IPv6 form (::a.b.c.d)', () => {
      const result = validateServerUrl('http://[::127.0.0.1]/');
      expect(result.valid).toBe(false);
    });

    it('blocks the IPv6 unspecified address ::', () => {
      const result = validateServerUrl('http://[::]/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('unspecified');
    });

    it('blocks IPv6 site-local fec0::/10 (deprecated but still routable)', () => {
      const result = validateServerUrl('http://[fec0::1]/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('site-local');
    });

    it('blocks IPv6 multicast ff02::1', () => {
      const result = validateServerUrl('http://[ff02::1]/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('multicast');
    });

    it('blocks 6to4 wrapping a private IPv4 (2002:0a00::/24)', () => {
      // 2002:0a01:0203:: → IPv4 10.1.2.3
      const result = validateServerUrl('http://[2002:0a01:0203::]/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('6to4');
    });

    it('blocks IPv4 multicast 224.0.0.1', () => {
      const result = validateServerUrl('http://224.0.0.1/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('multicast');
    });

    it('blocks reserved IPv4 240.0.0.1', () => {
      const result = validateServerUrl('http://240.0.0.1/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reserved');
    });

    it('still allows a public IPv6 (e.g. 2001:db8::1 is documentation, but treated as public)', () => {
      // 2001:db8::/32 is the documentation prefix — not in any of our denylists.
      const result = validateServerUrl('http://[2001:db8::1]/');
      expect(result.valid).toBe(true);
    });

    it('DNS-resolved IPv4-mapped IPv6 is also blocked', async () => {
      _setDnsLookup(async () => [{ address: '::ffff:127.0.0.1', family: 6 }]);
      const result = await validateServerUrlWithDns('https://hostile.example.com/');
      expect(result.valid).toBe(false);
    });
  });
});
