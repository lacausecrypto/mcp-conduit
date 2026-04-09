/**
 * Unit tests for RedisLimiter and MockRedisLimiter.
 *
 * These tests do NOT require a real Redis server. They use:
 * 1. MockRedisLimiter — in-memory, same async interface, for logic verification
 * 2. RedisLimiter + RateLimiter integration via MockRedisLimiter
 *
 * Real Redis integration tests are skipped when Redis is unavailable.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MockRedisLimiter, RedisLimiter } from '../../src/rate-limit/redis-limiter.js';
import { RateLimiter } from '../../src/rate-limit/rate-limiter.js';
import type { RateLimitConfig } from '../../src/rate-limit/types.js';

// ─── MockRedisLimiter ────────────────────────────────────────────────────────

describe('MockRedisLimiter', () => {
  let limiter: MockRedisLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new MockRedisLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under the limit', async () => {
    const r = await limiter.consume('key1', 5, 60_000);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
    expect(r.limit).toBe(5);
  });

  it('blocks requests over the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.consume('key1', 5, 60_000);
    }
    const r = await limiter.consume('key1', 5, 60_000);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retry_after).toBeDefined();
    expect(r.retry_after).toBeGreaterThanOrEqual(1);
  });

  it('check does not consume a slot', async () => {
    for (let i = 0; i < 4; i++) {
      await limiter.consume('checkkey', 5, 60_000);
    }
    // check should say 1 remaining without consuming
    const check = await limiter.check('checkkey', 5, 60_000);
    expect(check.allowed).toBe(true);
    expect(check.remaining).toBe(1);

    // Still 1 remaining after check
    const consume = await limiter.consume('checkkey', 5, 60_000);
    expect(consume.allowed).toBe(true);
  });

  it('slots expire after the window', async () => {
    await limiter.consume('exp', 1, 1_000);
    expect((await limiter.consume('exp', 1, 1_000)).allowed).toBe(false);

    vi.advanceTimersByTime(1_001);
    expect((await limiter.consume('exp', 1, 1_000)).allowed).toBe(true);
  });

  it('reset() clears specific key', async () => {
    await limiter.consume('a', 1, 60_000);
    await limiter.consume('b', 1, 60_000);

    await limiter.reset('a');
    expect((await limiter.consume('a', 1, 60_000)).allowed).toBe(true);
    expect((await limiter.consume('b', 1, 60_000)).allowed).toBe(false);
  });

  it('resetAll() clears all keys', async () => {
    await limiter.consume('x', 1, 60_000);
    await limiter.consume('y', 1, 60_000);

    await limiter.resetAll();
    expect((await limiter.consume('x', 1, 60_000)).allowed).toBe(true);
    expect((await limiter.consume('y', 1, 60_000)).allowed).toBe(true);
  });

  it('getUsage() returns correct count', async () => {
    await limiter.consume('u', 10, 60_000);
    await limiter.consume('u', 10, 60_000);
    await limiter.consume('u', 10, 60_000);

    const usage = await limiter.getUsage('u', 60_000);
    expect(usage.count).toBe(3);
  });

  it('getUsage() returns 0 for unknown key', async () => {
    const usage = await limiter.getUsage('unknown-key', 60_000);
    expect(usage.count).toBe(0);
  });

  it('isolated by key — different keys do not share counters', async () => {
    for (let i = 0; i < 3; i++) await limiter.consume('key-a', 3, 60_000);
    expect((await limiter.consume('key-a', 3, 60_000)).allowed).toBe(false);
    expect((await limiter.consume('key-b', 3, 60_000)).allowed).toBe(true);
  });

  it('retry_after is positive when blocked', async () => {
    await limiter.consume('retry', 1, 60_000);
    const r = await limiter.consume('retry', 1, 60_000);
    expect(r.allowed).toBe(false);
    expect(r.retry_after).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(r.retry_after)).toBe(true);
  });
});

// ─── RateLimiter with MockRedisLimiter backend ──────────────────────────────

describe('RateLimiter + MockRedisLimiter backend', () => {
  let rl: RateLimiter;

  const config: RateLimitConfig = {
    enabled: true,
    backend: 'redis',
    redis_url: 'redis://localhost:6379',
    global: { requests_per_minute: 100 },
    per_client: { requests_per_minute: 3 },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    rl = new RateLimiter(config, new MockRedisLimiter());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enforces per_client limits with Redis backend', async () => {
    await rl.consumeClientLimits('user-1');
    await rl.consumeClientLimits('user-1');
    await rl.consumeClientLimits('user-1');

    const r = await rl.consumeClientLimits('user-1');
    expect(r.allowed).toBe(false);
    expect(r.blocked_by).toContain('client');
  });

  it('different clients do not share quotas', async () => {
    await rl.consumeClientLimits('user-a');
    await rl.consumeClientLimits('user-a');
    await rl.consumeClientLimits('user-a');

    expect((await rl.consumeClientLimits('user-b')).allowed).toBe(true);
  });

  it('getClientQuota returns async results', async () => {
    await rl.consumeClientLimits('quota-user');
    const quota = await rl.getClientQuota('quota-user');
    expect(quota.limits.length).toBeGreaterThan(0);
    // Find the per-client minute limit specifically (not global/minute)
    const minuteLimit = quota.limits.find((l) => l.label.includes('client') && l.label.includes('minute'));
    expect(minuteLimit).toBeDefined();
    expect(minuteLimit!.remaining).toBe(2); // 3 - 1
  });

  it('resetAll() works with mock backend', async () => {
    await rl.consumeClientLimits('reset-user');
    await rl.consumeClientLimits('reset-user');
    await rl.consumeClientLimits('reset-user');
    expect((await rl.consumeClientLimits('reset-user')).allowed).toBe(false);

    rl.resetAll();
    // Use microtask yield instead of setTimeout (works with fake timers)
    await Promise.resolve();
    expect((await rl.consumeClientLimits('reset-user')).allowed).toBe(true);
  });
});

// ─── RateLimitBackend interface compliance ───────────────────────────────────

describe('RateLimitBackend interface compliance', () => {
  it('MockRedisLimiter implements all required methods', () => {
    const m = new MockRedisLimiter();
    expect(typeof m.consume).toBe('function');
    expect(typeof m.check).toBe('function');
    expect(typeof m.reset).toBe('function');
    expect(typeof m.resetAll).toBe('function');
    expect(typeof m.getUsage).toBe('function');
  });

  it('RedisLimiter class exists and has correct interface', () => {
    // Just check the class is constructible (without connecting)
    const r = new RedisLimiter('redis://localhost:6379');
    expect(typeof r.consume).toBe('function');
    expect(typeof r.check).toBe('function');
    expect(typeof r.reset).toBe('function');
    expect(typeof r.resetAll).toBe('function');
    expect(typeof r.getUsage).toBe('function');
    expect(typeof r.connect).toBe('function');
    expect(typeof r.disconnect).toBe('function');
    expect(typeof r.ping).toBe('function');
  });

  it('MockRedisLimiter consume returns a Promise', async () => {
    const m = new MockRedisLimiter();
    const result = m.consume('test', 10, 60_000);
    expect(result).toBeInstanceOf(Promise);
    const r = await result;
    expect(r).toHaveProperty('allowed');
    expect(r).toHaveProperty('remaining');
    expect(r).toHaveProperty('limit');
    expect(r).toHaveProperty('reset_at');
  });
});

// ─── Real Redis integration (skipped when unavailable) ───────────────────────

describe('RedisLimiter — real Redis integration', () => {
  let limiter: RedisLimiter;
  let redisAvailable = false;

  // Check if Redis is available before running real tests
  const testRedis = process.env['CONDUIT_TEST_REDIS_URL'] ?? 'redis://localhost:6379';

  beforeEach(async () => {
    limiter = new RedisLimiter(testRedis);
    try {
      await limiter.connect();
      const pong = await limiter.ping();
      redisAvailable = pong;
    } catch {
      redisAvailable = false;
    }
  });

  afterEach(async () => {
    if (redisAvailable) {
      try {
        await limiter.resetAll();
        await limiter.disconnect();
      } catch { /* ignore */ }
    }
  });

  it.skipIf(!redisAvailable)('consume allows requests under limit', async () => {
    const r = await limiter.consume('test:unit:real', 5, 60_000);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
  });

  it.skipIf(!redisAvailable)('blocks when over limit', async () => {
    for (let i = 0; i < 3; i++) {
      await limiter.consume('test:unit:over', 3, 60_000);
    }
    const r = await limiter.consume('test:unit:over', 3, 60_000);
    expect(r.allowed).toBe(false);
    expect(r.retry_after).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!redisAvailable)('check does not consume slot', async () => {
    await limiter.consume('test:unit:check', 2, 60_000);
    const before = await limiter.check('test:unit:check', 2, 60_000);
    expect(before.remaining).toBe(1);
    const after = await limiter.check('test:unit:check', 2, 60_000);
    expect(after.remaining).toBe(1); // unchanged
  });

  it.skipIf(!redisAvailable)('reset clears key', async () => {
    await limiter.consume('test:unit:reset', 1, 60_000);
    expect((await limiter.consume('test:unit:reset', 1, 60_000)).allowed).toBe(false);

    await limiter.reset('test:unit:reset');
    expect((await limiter.consume('test:unit:reset', 1, 60_000)).allowed).toBe(true);
  });

  it.skipIf(!redisAvailable)('ping returns true when connected', async () => {
    const pong = await limiter.ping();
    expect(pong).toBe(true);
  });
});
