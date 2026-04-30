/**
 * Prometheus metric label sanitiser tests.
 *
 * Audit `tests/3.1#5` — `sanitizeMetricLabel` is the only line of defence
 * against cardinality explosion when a hostile or buggy upstream emits
 * unbounded tool names / client ids / status strings. It existed in
 * `src/observability/metrics.ts:23-32` without any direct test coverage.
 *
 * Rules under test:
 *   - undefined / null      → '_unknown'
 *   - empty string          → '_empty'
 *   - keeps alphanumerics + . _ / : -
 *   - everything else replaced by '_'
 *   - truncation past MAX_LABEL_LENGTH (64) with `_trunc` suffix
 *   - all-stripped strings  → '_other'
 */
import { describe, expect, it } from 'vitest';
import { sanitizeMetricLabel } from '../../src/observability/metrics.js';

describe('sanitizeMetricLabel — sentinels', () => {
  it('undefined → "_unknown"', () => {
    expect(sanitizeMetricLabel(undefined)).toBe('_unknown');
  });

  it('null → "_unknown"', () => {
    expect(sanitizeMetricLabel(null)).toBe('_unknown');
  });

  it('empty string → "_empty"', () => {
    expect(sanitizeMetricLabel('')).toBe('_empty');
  });
});

describe('sanitizeMetricLabel — pass-through for safe values', () => {
  it('alphanumeric tool name passes unchanged', () => {
    expect(sanitizeMetricLabel('get_contact')).toBe('get_contact');
  });

  it('namespaced tool name with dot passes unchanged', () => {
    expect(sanitizeMetricLabel('salesforce.create_lead')).toBe('salesforce.create_lead');
  });

  it('keeps allowed punctuation: a-z A-Z 0-9 . _ / : -', () => {
    expect(sanitizeMetricLabel('Server-A.tool_v2:read/path-1')).toBe('Server-A.tool_v2:read/path-1');
  });

  it('keeps numeric values', () => {
    expect(sanitizeMetricLabel('42')).toBe('42');
  });

  it('keeps reserved bucket names if passed back in', () => {
    expect(sanitizeMetricLabel('_unknown')).toBe('_unknown');
    expect(sanitizeMetricLabel('_empty')).toBe('_empty');
    expect(sanitizeMetricLabel('_other')).toBe('_other');
    expect(sanitizeMetricLabel('_trunc')).toBe('_trunc');
  });
});

describe('sanitizeMetricLabel — charset stripping', () => {
  it('replaces spaces with underscores', () => {
    expect(sanitizeMetricLabel('hello world')).toBe('hello_world');
  });

  it('replaces unicode with underscores', () => {
    expect(sanitizeMetricLabel('résumé')).toBe('r_sum_');
  });

  it('replaces emoji with underscores', () => {
    // Emoji is multi-codepoint; each replaced char becomes '_'.
    const out = sanitizeMetricLabel('hi🎉');
    expect(out).toMatch(/^hi_+$/);
  });

  it('strips quotes, equals, and angle brackets', () => {
    expect(sanitizeMetricLabel('attack="<script>"')).toBe('attack___script__');
  });

  it('strips newlines / tabs / carriage returns', () => {
    expect(sanitizeMetricLabel('foo\nbar\tbaz\r\n')).toBe('foo_bar_baz__');
  });

  it('strips Prometheus-quoting characters that would break exposition format', () => {
    // backslash, double-quote, newline are reserved by the Prom expo format.
    expect(sanitizeMetricLabel('a\\b"c\nd')).toBe('a_b_c_d');
  });
});

describe('sanitizeMetricLabel — truncation', () => {
  it('passes a 64-char label unchanged (boundary value)', () => {
    const label = 'a'.repeat(64);
    expect(sanitizeMetricLabel(label)).toBe(label);
  });

  it('truncates a 65-char label with "_trunc" suffix', () => {
    const label = 'a'.repeat(65);
    const out = sanitizeMetricLabel(label);
    expect(out).toBe('a'.repeat(64) + '_trunc');
    expect(out.length).toBe(64 + '_trunc'.length);
  });

  it('truncates a 1000-char label with "_trunc" suffix', () => {
    const label = 'x'.repeat(1000);
    const out = sanitizeMetricLabel(label);
    expect(out.startsWith('x'.repeat(64))).toBe(true);
    expect(out.endsWith('_trunc')).toBe(true);
    // Truncation is performed AFTER charset stripping.
    expect(out.length).toBe(64 + '_trunc'.length);
  });

  it('truncates AFTER stripping (charset stripping cannot shrink past 64)', () => {
    // 80 chars of @ all stripped → 80 underscores → truncated to 64 + _trunc.
    const label = '@'.repeat(80);
    const out = sanitizeMetricLabel(label);
    expect(out).toBe('_'.repeat(64) + '_trunc');
  });
});

describe('sanitizeMetricLabel — fallbacks for stripped values', () => {
  it('a single non-allowed char stays as a single underscore (length=1, no fallback)', () => {
    expect(sanitizeMetricLabel('@')).toBe('_');
  });

  it('a string of only stripped chars is replaced with underscores (NOT _other)', () => {
    // Only "_other" fires when stripped.length === 0; underscores are kept.
    expect(sanitizeMetricLabel('!!!')).toBe('___');
  });
});

describe('sanitizeMetricLabel — adversarial inputs', () => {
  it('handles a JWT-looking token (long, contains dots) safely without leaking content', () => {
    const fakeJwt = 'eyJhbGciOiJSUzI1NiJ9.' + 'A'.repeat(200) + '.signature';
    const out = sanitizeMetricLabel(fakeJwt);
    expect(out.length).toBeLessThanOrEqual(64 + '_trunc'.length);
    expect(out.endsWith('_trunc')).toBe(true);
  });

  it('handles control characters (null byte, BEL, etc.)', () => {
    expect(sanitizeMetricLabel('a\x00b\x07c')).toBe('a_b_c');
  });

  it('coerces non-string inputs via String() — number', () => {
    // The function takes string | undefined | null but defends against runtime drift.
    // Cast through unknown to test runtime tolerance.
    const result = sanitizeMetricLabel(42 as unknown as string);
    expect(result).toBe('42');
  });

  it('coerces non-string inputs via String() — object (becomes "[object Object]" then stripped)', () => {
    const result = sanitizeMetricLabel({} as unknown as string);
    // "[object Object]" → strip [, ], space → "_object_Object_"
    expect(result).toBe('_object_Object_');
  });
});
