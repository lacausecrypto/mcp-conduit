/**
 * Additional coverage for src/rate-limit/redis-limiter.ts
 * Focuses on RedisLimiter paths that don't require a real Redis connection.
 */

import { describe, it, expect } from 'vitest';
import { RedisLimiter } from '../../src/rate-limit/redis-limiter.js';

describe('RedisLimiter - without connection', () => {
  it('constructs with default key prefix', () => {
    const limiter = new RedisLimiter('redis://localhost:6379');
    expect(limiter.keyPrefix).toBe('conduit:rl:');
  });

  it('constructs with custom key prefix', () => {
    const limiter = new RedisLimiter('redis://localhost:6379', 'myapp:limits:');
    expect(limiter.keyPrefix).toBe('myapp:limits:');
  });

  it('ping() returns false when not connected', async () => {
    const limiter = new RedisLimiter('redis://localhost:6379');
    const result = await limiter.ping();
    expect(result).toBe(false);
  });

  it('consume() throws when not connected', async () => {
    const limiter = new RedisLimiter('redis://localhost:6379');
    await expect(limiter.consume('test-key', 10, 60000)).rejects.toThrow('not connected');
  });

  it('check() throws when not connected', async () => {
    const limiter = new RedisLimiter('redis://localhost:6379');
    await expect(limiter.check('test-key', 10, 60000)).rejects.toThrow('not connected');
  });

  it('reset() throws when not connected', async () => {
    const limiter = new RedisLimiter('redis://localhost:6379');
    await expect(limiter.reset('test-key')).rejects.toThrow('not connected');
  });

  it('resetAll() throws when not connected', async () => {
    const limiter = new RedisLimiter('redis://localhost:6379');
    await expect(limiter.resetAll()).rejects.toThrow('not connected');
  });

  it('getUsage() throws when not connected', async () => {
    const limiter = new RedisLimiter('redis://localhost:6379');
    await expect(limiter.getUsage('test-key', 60000)).rejects.toThrow('not connected');
  });

  it('disconnect() does nothing when not connected', async () => {
    const limiter = new RedisLimiter('redis://localhost:6379');
    await expect(limiter.disconnect()).resolves.toBeUndefined();
  });

  it('has all required interface methods', () => {
    const limiter = new RedisLimiter('redis://localhost:6379');
    expect(typeof limiter.consume).toBe('function');
    expect(typeof limiter.check).toBe('function');
    expect(typeof limiter.reset).toBe('function');
    expect(typeof limiter.resetAll).toBe('function');
    expect(typeof limiter.getUsage).toBe('function');
    expect(typeof limiter.connect).toBe('function');
    expect(typeof limiter.disconnect).toBe('function');
    expect(typeof limiter.ping).toBe('function');
  });
});
