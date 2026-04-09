/**
 * Redis-backed sliding window rate limiter.
 *
 * Uses Redis sorted sets for atomic sliding window enforcement across multiple
 * gateway instances. A Lua script performs the check-and-consume atomically.
 *
 * Data model per key:
 *   ZADD key score=timestamp member="timestamp-randomSuffix"
 *   ZREMRANGEBYSCORE key 0 (now - window_ms)   → evict expired entries
 *   ZCARD key                                    → current count
 *   PEXPIRE key window_ms                        → auto-cleanup
 */

import type { RateLimitResult, RateLimitBackend } from './types.js';

// Dynamic import so tests that mock redis can swap it out without importing
// the real module at module evaluation time.
type RedisClientType = Awaited<ReturnType<typeof import('redis').createClient>>;

/**
 * Lua script for atomic sliding window rate limiting.
 *
 * KEYS[1] = rate limit key
 * ARGV[1] = current timestamp (ms)
 * ARGV[2] = window size (ms)
 * ARGV[3] = limit
 *
 * Returns: [allowed (1/0), remaining, retry_after_ms]
 */
const SLIDING_WINDOW_LUA = `
local key     = KEYS[1]
local now     = tonumber(ARGV[1])
local window  = tonumber(ARGV[2])
local limit   = tonumber(ARGV[3])

-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- Count remaining
local count = redis.call('ZCARD', key)

if count < limit then
  -- Add this request (unique member = timestamp + random)
  local member = now .. '-' .. math.random(1000000)
  redis.call('ZADD', key, now, member)
  -- TTL for auto-cleanup
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
else
  -- Compute retry_after from oldest entry
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_after = 0
  if #oldest > 0 then
    retry_after = (tonumber(oldest[2]) + window) - now
    if retry_after < 0 then retry_after = 0 end
  end
  return {0, 0, retry_after}
end
`;

/**
 * Lua script for check-only (no consume) sliding window.
 *
 * Same as above but does not add a new entry.
 */
const CHECK_ONLY_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  return {1, limit - count, 0}
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_after = 0
  if #oldest > 0 then
    retry_after = (tonumber(oldest[2]) + window) - now
    if retry_after < 0 then retry_after = 0 end
  end
  return {0, 0, retry_after}
end
`;

export class RedisLimiter implements RateLimitBackend {
  private client: RedisClientType | null = null;
  private readonly redisUrl: string;
  private connected = false;
  /** Namespace prefix for all Redis keys — prevents collisions with other apps. */
  readonly keyPrefix: string;

  constructor(redisUrl: string, keyPrefix = 'conduit:rl:') {
    this.redisUrl = redisUrl;
    this.keyPrefix = keyPrefix;
  }

  private prefix(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /** Connect to Redis. Must be called before any rate limit operations. */
  async connect(): Promise<void> {
    const { createClient } = await import('redis');
    this.client = createClient({ url: this.redisUrl });

    this.client.on('error', (err: unknown) => {
      console.error('[Conduit/Redis] Rate limit Redis error:', err);
    });

    await this.client.connect();
    this.connected = true;
  }

  /** Disconnect from Redis. */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.disconnect();
      this.connected = false;
    }
  }

  /** Health check — returns true if Redis responds to PING. */
  async ping(): Promise<boolean> {
    try {
      if (!this.client || !this.connected) return false;
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  /** Check AND consume a rate limit slot (atomic via Lua). */
  async consume(key: string, limit: number, window_ms: number): Promise<RateLimitResult> {
    return this.executeLua(SLIDING_WINDOW_LUA, this.prefix(key), limit, window_ms);
  }

  /** Check rate limit WITHOUT consuming a slot (atomic via Lua). */
  async check(key: string, limit: number, window_ms: number): Promise<RateLimitResult> {
    return this.executeLua(CHECK_ONLY_LUA, this.prefix(key), limit, window_ms);
  }

  /** Reset all rate limit entries for a specific key. */
  async reset(key: string): Promise<void> {
    if (!this.client) throw new Error('RedisLimiter not connected');
    await this.scanAndDelete(`${this.prefix(key)}*`);
  }

  /** Reset ALL rate limit keys managed by this gateway instance. */
  async resetAll(): Promise<void> {
    if (!this.client) throw new Error('RedisLimiter not connected');
    await this.scanAndDelete(`${this.keyPrefix}*`);
  }

  /** Get current usage count for a key within the window. */
  async getUsage(key: string, window_ms: number): Promise<{ count: number }> {
    if (!this.client) throw new Error('RedisLimiter not connected');
    const now = Date.now();
    const prefixedKey = this.prefix(key);
    await this.client.zRemRangeByScore(prefixedKey, 0, now - window_ms);
    const count = await this.client.zCard(prefixedKey);
    return { count };
  }

  /**
   * Deletes all Redis keys matching a pattern using SCAN (non-blocking).
   * Safe to use on large keyspaces — never blocks Redis with KEYS *.
   *
   * redis v5 scanIterator yields string[] batches per iteration.
   * Each batch is deleted in parallel with individual DEL calls to stay
   * compatible with the v5 typed client (management path, not hot path).
   */
  private async scanAndDelete(pattern: string): Promise<void> {
    if (!this.client) throw new Error('RedisLimiter not connected');
    for await (const keys of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      if (keys.length > 0) {
        await Promise.all(keys.map((key) => this.client!.del(key)));
      }
    }
  }

  private async executeLua(
    script: string,
    key: string,
    limit: number,
    window_ms: number,
  ): Promise<RateLimitResult> {
    if (!this.client) throw new Error('RedisLimiter not connected');

    const now = Date.now();
    const result = await this.client.eval(script, {
      keys: [key],
      arguments: [String(now), String(window_ms), String(limit)],
    }) as number[];

    const [allowed, remaining, retryAfterMs] = result;
    const isAllowed = allowed === 1;
    const retryAfterSec = retryAfterMs !== undefined && retryAfterMs > 0
      ? Math.ceil(retryAfterMs / 1000)
      : undefined;

    return {
      allowed: isAllowed,
      remaining: remaining ?? 0,
      limit,
      reset_at: now + window_ms,
      ...(retryAfterSec !== undefined ? { retry_after: retryAfterSec } : {}),
    };
  }
}

/**
 * In-memory mock of RedisLimiter for unit tests.
 * Implements the same async interface without requiring a real Redis.
 * The sliding window logic mirrors the Lua script semantics.
 */
export class MockRedisLimiter implements RateLimitBackend {
  /** Map: key → sorted timestamps */
  private readonly store = new Map<string, number[]>();

  async consume(key: string, limit: number, window_ms: number): Promise<RateLimitResult> {
    const now = Date.now();
    const valid = this.prune(key, now, window_ms);
    const count = valid.length;

    if (count < limit) {
      valid.push(now);
      this.store.set(key, valid);
      return {
        allowed: true,
        remaining: limit - valid.length,
        limit,
        reset_at: now + window_ms,
      };
    }

    const oldest = valid[0] ?? now;
    const retryMs = (oldest + window_ms) - now;
    return {
      allowed: false,
      remaining: 0,
      limit,
      reset_at: now + window_ms,
      retry_after: Math.max(1, Math.ceil(retryMs / 1000)),
    };
  }

  async check(key: string, limit: number, window_ms: number): Promise<RateLimitResult> {
    const now = Date.now();
    const valid = this.prune(key, now, window_ms);
    const count = valid.length;
    const allowed = count < limit;

    if (allowed) {
      return { allowed: true, remaining: limit - count, limit, reset_at: now + window_ms };
    }

    const oldest = valid[0] ?? now;
    const retryMs = (oldest + window_ms) - now;
    return {
      allowed: false,
      remaining: 0,
      limit,
      reset_at: now + window_ms,
      retry_after: Math.max(1, Math.ceil(retryMs / 1000)),
    };
  }

  async reset(key: string): Promise<void> {
    for (const k of this.store.keys()) {
      if (k === key || k.startsWith(`${key}:`)) {
        this.store.delete(k);
      }
    }
  }

  async resetAll(): Promise<void> {
    this.store.clear();
  }

  async getUsage(key: string, window_ms: number): Promise<{ count: number }> {
    const now = Date.now();
    const valid = this.prune(key, now, window_ms);
    return { count: valid.length };
  }

  private prune(key: string, now: number, window_ms: number): number[] {
    const cutoff = now - window_ms;
    const all = this.store.get(key) ?? [];
    const valid = all.filter((t) => t >= cutoff);
    this.store.set(key, valid);
    return valid;
  }
}
