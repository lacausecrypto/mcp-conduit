/**
 * URL validation utilities to prevent SSRF attacks.
 *
 * Blocks requests to:
 * - Private/internal IP ranges (RFC 1918, RFC 6598, loopback, link-local)
 * - Cloud metadata endpoints (169.254.169.254, fd00::, etc.)
 * - Non-HTTP(S) schemes (file://, javascript:, data:, etc.)
 * - Hostnames that resolve to private IPs (best-effort DNS rebinding protection)
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Private/internal CIDR ranges to block */
type LookupAddress = { address: string; family: number };
type LookupFn = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;

const DEFAULT_LOOKUP: LookupFn = (hostname, options) =>
  lookup(hostname, options) as Promise<LookupAddress[]>;

let dnsLookup: LookupFn = DEFAULT_LOOKUP;

/** Known dangerous hostnames */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google',
  'instance-data',
]);

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
  /**
   * IPs returned by DNS resolution at validation time. Set only by
   * validateServerUrlWithDns when the URL is a hostname (not an IP literal)
   * and resolution succeeded. Callers can pin subsequent fetches to one of
   * these addresses to prevent DNS rebinding TOCTOU between validation
   * and the actual network call.
   */
  resolvedIps?: Array<{ address: string; family: 4 | 6 }>;
}

export function _setDnsLookup(lookupFn: LookupFn): void {
  dnsLookup = lookupFn;
}

export function _resetDnsLookup(): void {
  dnsLookup = DEFAULT_LOOKUP;
}

/**
 * Validates a URL for safe use as an upstream server target.
 * Returns { valid: true } or { valid: false, error: "reason" }.
 *
 * @param url - The URL to validate
 * @param allowPrivate - If true, skip private IP checks (explicit opt-in)
 */
export function validateServerUrl(url: string, allowPrivate = false): UrlValidationResult {
  // 1. Parse URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: `Invalid URL format: ${url}` };
  }

  // 2. Check scheme — only http and https allowed
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // Exception for stdio:// which is an internal identifier, not a real URL
    if (parsed.protocol === 'stdio:') return { valid: true };
    return { valid: false, error: `Blocked scheme "${parsed.protocol}" — only http: and https: allowed` };
  }

  // 3. Check for credentials in URL
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'URLs must not contain embedded credentials' };
  }

  if (allowPrivate) return { valid: true };

  // 4. Check hostname against blocked list
  const hostname = parsed.hostname.toLowerCase();
  const normalizedHost = normalizeHost(hostname);

  if (BLOCKED_HOSTNAMES.has(normalizedHost) || normalizedHost.endsWith('.localhost')) {
    return { valid: false, error: `Blocked loopback hostname: ${normalizedHost}` };
  }

  // 5. Check direct IP literals synchronously.
  if (isIpLiteral(normalizedHost)) {
    const blocked = getBlockedIpReason(normalizedHost);
    if (blocked) {
      return { valid: false, error: blocked };
    }
  }

  return { valid: true };
}

/**
 * Async variant that additionally resolves hostnames and blocks those that
 * currently resolve to private or loopback addresses.
 */
export async function validateServerUrlWithDns(
  url: string,
  allowPrivate = false,
): Promise<UrlValidationResult> {
  const baseValidation = validateServerUrl(url, allowPrivate);
  if (!baseValidation.valid || allowPrivate) {
    return baseValidation;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: `Invalid URL format: ${url}` };
  }

  const hostname = normalizeHost(parsed.hostname.toLowerCase());
  if (isIpLiteral(hostname)) {
    return baseValidation;
  }

  try {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    const resolvedIps: Array<{ address: string; family: 4 | 6 }> = [];
    for (const record of addresses) {
      const blocked = getBlockedIpReason(normalizeHost(record.address));
      if (blocked) {
        return {
          valid: false,
          error: `Hostname "${hostname}" resolves to a blocked address: ${normalizeHost(record.address)}`,
        };
      }
      if (record.family === 4 || record.family === 6) {
        resolvedIps.push({ address: record.address, family: record.family });
      }
    }
    return resolvedIps.length > 0
      ? { valid: true, resolvedIps }
      : { valid: true };
  } catch {
    // Best effort only: unresolved hostnames are left to the caller/fetch path.
  }

  return { valid: true };
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').trim().toLowerCase();
}

function isIpLiteral(hostname: string): boolean {
  return isIP(normalizeHost(hostname)) !== 0;
}

function getBlockedIpReason(ip: string): string | null {
  const normalized = normalizeHost(ip);
  const family = isIP(normalized);
  if (family === 4) {
    return getBlockedIpv4Reason(normalized);
  }

  if (family === 6) {
    return getBlockedIpv6Reason(normalized);
  }

  return null;
}

function getBlockedIpv4Reason(ip: string): string | null {
  const octets = ip.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return 'Invalid IPv4 address';
  }

  const a = octets[0]!;
  const b = octets[1]!;
  if (a === 0) return `Blocked private IP (current network): ${ip}`;
  if (a === 10) return `Blocked private IP (RFC 1918 class A): ${ip}`;
  if (a === 127) return `Blocked loopback IP: ${ip}`;
  if (a === 169 && b === 254) return `Blocked link-local / metadata IP: ${ip}`;
  if (a === 172 && b >= 16 && b <= 31) return `Blocked private IP (RFC 1918 class B): ${ip}`;
  if (a === 192 && b === 168) return `Blocked private IP (RFC 1918 class C): ${ip}`;
  if (a === 100 && b >= 64 && b <= 127) return `Blocked private IP (RFC 6598 carrier-grade NAT): ${ip}`;
  // 224.0.0.0/4 and 240.0.0.0/4 are multicast / future-use — never valid for
  // an upstream MCP target and historically abused for amplification.
  if (a >= 224 && a <= 239) return `Blocked multicast IP: ${ip}`;
  if (a >= 240 && a <= 255) return `Blocked reserved IP: ${ip}`;
  return null;
}

/**
 * IPv6 address parser focused on classification, not full RFC compliance.
 * We only need:
 *   - exact-match loopback (::1)
 *   - unique-local (fc00::/7)
 *   - link-local (fe80::/10)
 *   - site-local deprecated (fec0::/10)
 *   - IPv4-mapped (::ffff:a.b.c.d) — must be re-checked against the IPv4
 *     denylist or an attacker can smuggle 127.0.0.1 / 169.254.169.254 / 10.x
 *     past the SSRF guard by encoding it as ::ffff:7f00:0001 etc.
 *   - IPv4-compatible deprecated (::a.b.c.d)
 *   - 6to4 (2002::/16) — rare, but historically abused; treat liberally.
 *   - unspecified (::)
 */
function getBlockedIpv6Reason(ip: string): string | null {
  const lower = ip.toLowerCase();

  // Unspecified address — never a valid upstream target.
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') {
    return `Blocked IPv6 unspecified address: ${ip}`;
  }
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') {
    return `Blocked IPv6 loopback address: ${ip}`;
  }

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) — the trailing
  // 32 bits encode an IPv4 address. Re-classify against the IPv4 denylist.
  const mappedV4 = extractMappedIpv4(lower);
  if (mappedV4) {
    const ipv4Reason = getBlockedIpv4Reason(mappedV4);
    if (ipv4Reason) {
      return `Blocked IPv4-mapped IPv6 address (${ip} → ${mappedV4}): ${ipv4Reason}`;
    }
  }

  // 6to4 prefix 2002::/16 wraps an IPv4 address in bytes 2-5. If the wrapped
  // IPv4 is private/loopback, the tunnel is not safe to traverse.
  const sixToFour = extractSixToFourIpv4(lower);
  if (sixToFour) {
    const ipv4Reason = getBlockedIpv4Reason(sixToFour);
    if (ipv4Reason) {
      return `Blocked 6to4 wrapping a private IPv4 (${ip} → ${sixToFour}): ${ipv4Reason}`;
    }
  }

  // Unique-local addresses (fc00::/7 — fc00:: through fdff::).
  if (/^f[cd]/.test(lower)) {
    return `Blocked IPv6 unique local address: ${ip}`;
  }
  // Link-local fe80::/10 covers fe80–febf.
  if (/^fe[89ab]/.test(lower)) {
    return `Blocked IPv6 link-local address: ${ip}`;
  }
  // Site-local fec0::/10 — deprecated by RFC 3879 but still routable in some
  // legacy networks; we treat it as private.
  if (/^fe[cdef]/.test(lower)) {
    return `Blocked IPv6 site-local (deprecated) address: ${ip}`;
  }
  // IPv6 multicast ff00::/8.
  if (lower.startsWith('ff')) {
    return `Blocked IPv6 multicast address: ${ip}`;
  }

  return null;
}

function extractMappedIpv4(lower: string): string | null {
  // Forms: "::ffff:a.b.c.d", "::ffff:hh:hh", "::a.b.c.d" (compat), "::hh:hh".
  const dotted = lower.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1] ?? null;

  const hex = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex && hex[1] !== undefined && hex[2] !== undefined) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    if (high <= 0xffff && low <= 0xffff) {
      const a = (high >> 8) & 0xff;
      const b = high & 0xff;
      const c = (low >> 8) & 0xff;
      const d = low & 0xff;
      return `${a}.${b}.${c}.${d}`;
    }
  }
  return null;
}

function extractSixToFourIpv4(lower: string): string | null {
  // 2002:WWXX:YYZZ:: form — the IPv4 is in bytes 2-5.
  const match = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  const high = parseInt(match[1], 16);
  const low = parseInt(match[2], 16);
  if (high > 0xffff || low > 0xffff) return null;
  const a = (high >> 8) & 0xff;
  const b = high & 0xff;
  const c = (low >> 8) & 0xff;
  const d = low & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

/**
 * Redacts credentials from a URL string for safe logging.
 * redis://user:password@host:6379 → redis://***@host:6379
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password || parsed.username) {
      parsed.username = '***';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return url.replace(/:\/\/[^@]+@/, '://***@');
  }
}
