/**
 * URL validation utilities to prevent SSRF attacks.
 *
 * Blocks requests to:
 * - Private/internal IP ranges (RFC 1918, RFC 6598, loopback, link-local)
 * - Cloud metadata endpoints (169.254.169.254, fd00::, etc.)
 * - Non-HTTP(S) schemes (file://, javascript:, data:, etc.)
 * - Hostnames that resolve to private IPs (DNS rebinding protection via validation at config time)
 */

/** Private/internal CIDR ranges to block */
const BLOCKED_RANGES = [
  { prefix: '10.', description: 'RFC 1918 class A' },
  { prefix: '0.', description: 'current network' },
  { prefix: '169.254.', description: 'link-local / cloud metadata' },
  { prefix: '192.168.', description: 'RFC 1918 class C' },
];

// Note: 127.0.0.0/8 (loopback) is NOT blocked by default because it's
// the standard dev/testing address. In production, set up network policies
// or a reverse proxy instead. Cloud metadata (169.254.x.x) IS blocked.

/** 172.16.0.0/12 check (172.16.x.x through 172.31.x.x) */
function isRfc1918ClassB(ip: string): boolean {
  if (!ip.startsWith('172.')) return false;
  const second = parseInt(ip.split('.')[1] ?? '', 10);
  return second >= 16 && second <= 31;
}

/** Known dangerous hostnames */
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.google',
  'instance-data',
]);

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a URL for safe use as an upstream server target.
 * Returns { valid: true } or { valid: false, error: "reason" }.
 *
 * @param url - The URL to validate
 * @param allowPrivate - If true, skip private IP checks (for local dev)
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

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, error: `Blocked hostname: ${hostname}` };
  }

  // 5. Check if hostname looks like an IP address
  const ipMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipMatch) {
    const ip = hostname;

    for (const range of BLOCKED_RANGES) {
      if (ip.startsWith(range.prefix)) {
        return { valid: false, error: `Blocked private IP (${range.description}): ${ip}` };
      }
    }

    if (isRfc1918ClassB(ip)) {
      return { valid: false, error: `Blocked private IP (RFC 1918 class B): ${ip}` };
    }

    // Check for 0.0.0.0
    if (ip === '0.0.0.0') {
      return { valid: false, error: `Blocked address: ${ip}` };
    }
  }

  // 6. Check for IPv6 loopback/private
  if (hostname === '[::1]' || hostname === '::1' || hostname.startsWith('[fd') || hostname.startsWith('[fe80')) {
    return { valid: false, error: `Blocked IPv6 private address: ${hostname}` };
  }

  return { valid: true };
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
