import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RedisCacheStore } from '../../src/cache/redis-cache.js';
import type { CacheEntry } from '../../src/cache/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    result: { content: 'test data' },
    createdAt: Date.now(),
    ttl: 300,
    toolName: 'get_contact',
    serverId: 'server-1',
    ...overrides,
  };
}

/** Create a RedisCacheStore and inject a mock Redis client via private fields. */
function createConnectedStore(
  opts: { keyPrefix?: string; maxEntrySizeKb?: number } = {},
): { store: RedisCacheStore; mockClient: Record<string, ReturnType<typeof vi.fn>> } {
  const store = new RedisCacheStore(
    'redis://localhost:6379',
    opts.keyPrefix ?? 'conduit:cache:',
    opts.maxEntrySizeKb ?? 512,
  );

  const mockClient: Record<string, ReturnType<typeof vi.fn>> = {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ping: vi.fn().mockResolvedValue('PONG'),
    scanIterator: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };

  // Inject private fields to simulate a connected state
  (store as any).client = mockClient;
  (store as any).connected = true;

  return { store, mockClient };
}

function createDisconnectedStore(): RedisCacheStore {
  return new RedisCacheStore('redis://localhost:6379');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedisCacheStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constructor ─────────────────────────────────────────────────────────
  describe('constructor', () => {
    it('uses default keyPrefix and maxEntrySizeKb when omitted', () => {
      const store = new RedisCacheStore('redis://localhost:6379');
      expect((store as any).keyPrefix).toBe('conduit:cache:');
      expect((store as any).maxEntrySizeBytes).toBe(512 * 1024);
    });

    it('accepts custom keyPrefix', () => {
      const store = new RedisCacheStore('redis://localhost:6379', 'custom:');
      expect((store as any).keyPrefix).toBe('custom:');
    });

    it('accepts custom maxEntrySizeKb and converts to bytes', () => {
      const store = new RedisCacheStore('redis://localhost:6379', 'p:', 128);
      expect((store as any).maxEntrySizeBytes).toBe(128 * 1024);
    });

    it('stores the redisUrl', () => {
      const url = 'redis://myhost:1234';
      const store = new RedisCacheStore(url);
      expect((store as any).redisUrl).toBe(url);
    });

    it('starts in disconnected state', () => {
      const store = new RedisCacheStore('redis://localhost:6379');
      expect((store as any).connected).toBe(false);
      expect((store as any).client).toBeNull();
    });

    it('initialises all counters to zero', () => {
      const store = new RedisCacheStore('redis://localhost:6379');
      const stats = store.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.writes).toBe(0);
      expect(stats.errors).toBe(0);
    });
  });

  // ── get() ───────────────────────────────────────────────────────────────
  describe('get()', () => {
    it('returns undefined when not connected', async () => {
      const store = createDisconnectedStore();
      const result = await store.get('any-key');
      expect(result).toBeUndefined();
    });

    it('returns undefined when client is null', async () => {
      const store = new RedisCacheStore('redis://localhost:6379');
      (store as any).connected = true; // connected but no client
      const result = await store.get('key');
      expect(result).toBeUndefined();
    });

    it('returns undefined and increments misses when key not found', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.get.mockResolvedValue(null);
      const result = await store.get('missing');
      expect(result).toBeUndefined();
      expect(store.getStats().misses).toBe(1);
    });

    it('applies key prefix when calling redis get', async () => {
      const { store, mockClient } = createConnectedStore({ keyPrefix: 'test:' });
      mockClient.get.mockResolvedValue(null);
      await store.get('my-key');
      expect(mockClient.get).toHaveBeenCalledWith('test:my-key');
    });

    it('parses JSON and returns valid entry', async () => {
      const { store, mockClient } = createConnectedStore();
      const entry = makeEntry({ createdAt: Date.now(), ttl: 300 });
      mockClient.get.mockResolvedValue(JSON.stringify(entry));
      const result = await store.get('valid');
      expect(result).toEqual(entry);
    });

    it('increments hits for valid entry', async () => {
      const { store, mockClient } = createConnectedStore();
      const entry = makeEntry({ createdAt: Date.now(), ttl: 300 });
      mockClient.get.mockResolvedValue(JSON.stringify(entry));
      await store.get('key');
      expect(store.getStats().hits).toBe(1);
    });

    it('returns undefined and increments misses for expired entry', async () => {
      const { store, mockClient } = createConnectedStore();
      const entry = makeEntry({
        createdAt: Date.now() - 400_000, // 400 seconds ago
        ttl: 300, // 300 second TTL => expired
      });
      mockClient.get.mockResolvedValue(JSON.stringify(entry));
      const result = await store.get('expired');
      expect(result).toBeUndefined();
      expect(store.getStats().misses).toBe(1);
      expect(store.getStats().hits).toBe(0);
    });

    it('returns entry when age equals ttl exactly', async () => {
      const { store, mockClient } = createConnectedStore();
      // age == ttl => NOT expired (age > ttl triggers miss)
      const entry = makeEntry({ createdAt: Date.now() - 300_000, ttl: 300 });
      mockClient.get.mockResolvedValue(JSON.stringify(entry));
      const result = await store.get('boundary');
      // age = 300, ttl = 300, 300 > 300 is false => hit
      expect(result).toEqual(entry);
      expect(store.getStats().hits).toBe(1);
    });

    it('returns undefined on timeout (slow redis)', async () => {
      const { store, mockClient } = createConnectedStore();
      // Simulate slow redis - never resolves within 100ms race
      mockClient.get.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(JSON.stringify(makeEntry())), 500)),
      );
      const result = await store.get('slow');
      expect(result).toBeUndefined();
      expect(store.getStats().misses).toBe(1);
    });

    it('increments errors on JSON parse failure', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.get.mockResolvedValue('not valid json!!!');
      const result = await store.get('bad-json');
      expect(result).toBeUndefined();
      expect(store.getStats().errors).toBe(1);
    });

    it('increments errors when redis client throws', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.get.mockRejectedValue(new Error('Redis connection lost'));
      const result = await store.get('error-key');
      expect(result).toBeUndefined();
      expect(store.getStats().errors).toBe(1);
    });

    it('does not increment hits or misses on error', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.get.mockRejectedValue(new Error('fail'));
      await store.get('k');
      const stats = store.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.errors).toBe(1);
    });

    it('accumulates hits across multiple calls', async () => {
      const { store, mockClient } = createConnectedStore();
      const entry = makeEntry();
      mockClient.get.mockResolvedValue(JSON.stringify(entry));
      await store.get('k1');
      await store.get('k2');
      await store.get('k3');
      expect(store.getStats().hits).toBe(3);
    });

    it('accumulates misses across multiple calls', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.get.mockResolvedValue(null);
      await store.get('m1');
      await store.get('m2');
      expect(store.getStats().misses).toBe(2);
    });
  });

  // ── set() ───────────────────────────────────────────────────────────────
  describe('set()', () => {
    it('does nothing when not connected', () => {
      const store = createDisconnectedStore();
      store.set('k', makeEntry(), 60);
      expect(store.getStats().writes).toBe(0);
    });

    it('does nothing when client is null', () => {
      const store = new RedisCacheStore('redis://localhost:6379');
      (store as any).connected = true;
      store.set('k', makeEntry(), 60);
      expect(store.getStats().writes).toBe(0);
    });

    it('returns void (fire-and-forget)', () => {
      const { store } = createConnectedStore();
      const result = store.set('k', makeEntry(), 60);
      expect(result).toBeUndefined();
    });

    it('calls redis set with prefixed key', () => {
      const { store, mockClient } = createConnectedStore({ keyPrefix: 'pfx:' });
      const entry = makeEntry();
      store.set('my-key', entry, 60);
      expect(mockClient.set).toHaveBeenCalledWith(
        'pfx:my-key',
        JSON.stringify(entry),
        { EX: 60 },
      );
    });

    it('increments writes counter', () => {
      const { store } = createConnectedStore();
      store.set('k', makeEntry(), 60);
      expect(store.getStats().writes).toBe(1);
    });

    it('uses Math.ceil for fractional TTL', () => {
      const { store, mockClient } = createConnectedStore();
      store.set('k', makeEntry(), 0.5);
      expect(mockClient.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        { EX: 1 },
      );
    });

    it('enforces minimum EX of 1 for TTL < 1', () => {
      const { store, mockClient } = createConnectedStore();
      store.set('k', makeEntry(), 0.1);
      const callArgs = mockClient.set.mock.calls[0];
      expect(callArgs[2].EX).toBe(1);
    });

    it('enforces minimum EX of 1 for TTL = 0', () => {
      const { store, mockClient } = createConnectedStore();
      store.set('k', makeEntry(), 0);
      const callArgs = mockClient.set.mock.calls[0];
      expect(callArgs[2].EX).toBe(1);
    });

    it('enforces minimum EX of 1 for negative TTL', () => {
      const { store, mockClient } = createConnectedStore();
      store.set('k', makeEntry(), -5);
      const callArgs = mockClient.set.mock.calls[0];
      expect(callArgs[2].EX).toBe(1);
    });

    it('uses Math.ceil for ttl like 2.3 => EX: 3', () => {
      const { store, mockClient } = createConnectedStore();
      store.set('k', makeEntry(), 2.3);
      const callArgs = mockClient.set.mock.calls[0];
      expect(callArgs[2].EX).toBe(3);
    });

    it('rejects entries exceeding max size', () => {
      const { store, mockClient } = createConnectedStore({ maxEntrySizeKb: 1 }); // 1 KB limit
      const largeResult: Record<string, unknown> = {};
      for (let i = 0; i < 200; i++) {
        largeResult[`field_${i}`] = 'x'.repeat(100);
      }
      const entry = makeEntry({ result: largeResult });
      store.set('big', entry, 60);
      expect(mockClient.set).not.toHaveBeenCalled();
      expect(store.getStats().writes).toBe(0);
    });

    it('accepts entry within max size', () => {
      const { store, mockClient } = createConnectedStore({ maxEntrySizeKb: 512 });
      const entry = makeEntry({ result: { small: 'data' } });
      store.set('ok', entry, 60);
      expect(mockClient.set).toHaveBeenCalled();
      expect(store.getStats().writes).toBe(1);
    });

    it('increments errors when redis set rejects', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.set.mockRejectedValue(new Error('Redis write error'));
      store.set('k', makeEntry(), 60);
      // Wait for the promise rejection to be caught
      await vi.waitFor(() => {
        expect(store.getStats().errors).toBe(1);
      });
    });

    it('increments writes even when redis set will reject', () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.set.mockRejectedValue(new Error('fail'));
      store.set('k', makeEntry(), 60);
      // writes is incremented synchronously before the promise resolves
      expect(store.getStats().writes).toBe(1);
    });

    it('accumulates writes across multiple calls', () => {
      const { store } = createConnectedStore();
      store.set('k1', makeEntry(), 60);
      store.set('k2', makeEntry(), 60);
      store.set('k3', makeEntry(), 60);
      expect(store.getStats().writes).toBe(3);
    });
  });

  // ── delete() ────────────────────────────────────────────────────────────
  describe('delete()', () => {
    it('returns false when not connected', async () => {
      const store = createDisconnectedStore();
      expect(await store.delete('k')).toBe(false);
    });

    it('returns true when key is deleted', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.del.mockResolvedValue(1);
      expect(await store.delete('k')).toBe(true);
    });

    it('returns false when key does not exist', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.del.mockResolvedValue(0);
      expect(await store.delete('k')).toBe(false);
    });

    it('applies key prefix to del call', async () => {
      const { store, mockClient } = createConnectedStore({ keyPrefix: 'pfx:' });
      await store.delete('my-key');
      expect(mockClient.del).toHaveBeenCalledWith('pfx:my-key');
    });

    it('returns false and increments errors on redis error', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.del.mockRejectedValue(new Error('fail'));
      expect(await store.delete('k')).toBe(false);
      expect(store.getStats().errors).toBe(1);
    });
  });

  // ── deleteByPattern() ──────────────────────────────────────────────────
  describe('deleteByPattern()', () => {
    it('returns 0 when not connected', async () => {
      const store = createDisconnectedStore();
      expect(await store.deleteByPattern('*')).toBe(0);
    });

    it('uses scanIterator with prefixed MATCH pattern', async () => {
      const { store, mockClient } = createConnectedStore({ keyPrefix: 'pfx:' });
      // Simulate an async iterator that yields no batches
      mockClient.scanIterator.mockReturnValue((async function* () {
        // empty
      })());
      await store.deleteByPattern('tool:*');
      expect(mockClient.scanIterator).toHaveBeenCalledWith({
        MATCH: 'pfx:tool:*',
        COUNT: 100,
      });
    });

    it('deletes found keys and returns count', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.scanIterator.mockReturnValue((async function* () {
        yield ['conduit:cache:k1', 'conduit:cache:k2'];
        yield ['conduit:cache:k3'];
      })());
      mockClient.del.mockResolvedValue(1);
      const deleted = await store.deleteByPattern('*');
      expect(deleted).toBe(3);
      expect(mockClient.del).toHaveBeenCalledTimes(3);
    });

    it('skips empty batches from scanIterator', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.scanIterator.mockReturnValue((async function* () {
        yield [];
        yield ['conduit:cache:k1'];
        yield [];
      })());
      mockClient.del.mockResolvedValue(1);
      const deleted = await store.deleteByPattern('*');
      expect(deleted).toBe(1);
    });

    it('increments errors on scanIterator failure', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.scanIterator.mockReturnValue((async function* () {
        throw new Error('SCAN failed');
      })());
      const deleted = await store.deleteByPattern('*');
      expect(deleted).toBe(0);
      expect(store.getStats().errors).toBe(1);
    });
  });

  // ── flush() ────────────────────────────────────────────────────────────
  describe('flush()', () => {
    it('delegates to deleteByPattern("*")', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.scanIterator.mockReturnValue((async function* () {
        yield ['conduit:cache:a', 'conduit:cache:b'];
      })());
      mockClient.del.mockResolvedValue(1);
      const deleted = await store.flush();
      expect(deleted).toBe(2);
      expect(mockClient.scanIterator).toHaveBeenCalledWith({
        MATCH: 'conduit:cache:*',
        COUNT: 100,
      });
    });

    it('returns 0 when not connected', async () => {
      const store = createDisconnectedStore();
      expect(await store.flush()).toBe(0);
    });
  });

  // ── ping() ──────────────────────────────────────────────────────────────
  describe('ping()', () => {
    it('returns false when not connected', async () => {
      const store = createDisconnectedStore();
      expect(await store.ping()).toBe(false);
    });

    it('returns false when client is null', async () => {
      const store = new RedisCacheStore('redis://localhost:6379');
      (store as any).connected = true;
      expect(await store.ping()).toBe(false);
    });

    it('returns true when ping returns PONG', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.ping.mockResolvedValue('PONG');
      expect(await store.ping()).toBe(true);
    });

    it('returns false when ping returns unexpected value', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.ping.mockResolvedValue('something-else');
      expect(await store.ping()).toBe(false);
    });

    it('returns false when ping throws', async () => {
      const { store, mockClient } = createConnectedStore();
      mockClient.ping.mockRejectedValue(new Error('connection lost'));
      expect(await store.ping()).toBe(false);
    });
  });

  // ── getStats() ──────────────────────────────────────────────────────────
  describe('getStats()', () => {
    it('returns all zero counters for fresh store', () => {
      const store = createDisconnectedStore();
      expect(store.getStats()).toEqual({
        hits: 0,
        misses: 0,
        writes: 0,
        errors: 0,
        connected: false,
      });
    });

    it('reports connected: true when connected', () => {
      const { store } = createConnectedStore();
      expect(store.getStats().connected).toBe(true);
    });

    it('reports connected: false when disconnected', () => {
      const store = createDisconnectedStore();
      expect(store.getStats().connected).toBe(false);
    });

    it('reflects accurate counters after mixed operations', async () => {
      const { store, mockClient } = createConnectedStore();
      const entry = makeEntry();

      // 2 hits
      mockClient.get.mockResolvedValue(JSON.stringify(entry));
      await store.get('k1');
      await store.get('k2');

      // 1 miss
      mockClient.get.mockResolvedValue(null);
      await store.get('k3');

      // 1 write
      store.set('k4', entry, 60);

      // 1 error
      mockClient.get.mockRejectedValue(new Error('fail'));
      await store.get('k5');

      const stats = store.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.writes).toBe(1);
      expect(stats.errors).toBe(1);
    });

    it('returns a snapshot (not a live reference)', () => {
      const { store, mockClient } = createConnectedStore();
      const stats1 = store.getStats();
      mockClient.get.mockResolvedValue(null);
      // Do another operation after taking stats
      store.set('k', makeEntry(), 10);
      const stats2 = store.getStats();
      expect(stats1.writes).toBe(0);
      expect(stats2.writes).toBe(1);
    });
  });

  // ── Key prefix ──────────────────────────────────────────────────────────
  describe('key prefix', () => {
    it('prefixes keys in get()', async () => {
      const { store, mockClient } = createConnectedStore({ keyPrefix: 'myapp:' });
      mockClient.get.mockResolvedValue(null);
      await store.get('abc');
      expect(mockClient.get).toHaveBeenCalledWith('myapp:abc');
    });

    it('prefixes keys in set()', () => {
      const { store, mockClient } = createConnectedStore({ keyPrefix: 'myapp:' });
      store.set('abc', makeEntry(), 10);
      expect(mockClient.set.mock.calls[0][0]).toBe('myapp:abc');
    });

    it('prefixes keys in delete()', async () => {
      const { store, mockClient } = createConnectedStore({ keyPrefix: 'myapp:' });
      await store.delete('abc');
      expect(mockClient.del).toHaveBeenCalledWith('myapp:abc');
    });

    it('prefixes MATCH pattern in deleteByPattern()', async () => {
      const { store, mockClient } = createConnectedStore({ keyPrefix: 'myapp:' });
      mockClient.scanIterator.mockReturnValue((async function* () {})());
      await store.deleteByPattern('tool:*');
      expect(mockClient.scanIterator).toHaveBeenCalledWith({
        MATCH: 'myapp:tool:*',
        COUNT: 100,
      });
    });

    it('handles empty prefix gracefully', async () => {
      const { store, mockClient } = createConnectedStore({ keyPrefix: '' });
      mockClient.get.mockResolvedValue(null);
      await store.get('raw-key');
      expect(mockClient.get).toHaveBeenCalledWith('raw-key');
    });
  });
});
