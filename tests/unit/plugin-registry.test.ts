/**
 * Tests unitaires pour le registre de plugins.
 */

import { describe, it, expect, vi } from 'vitest';
import { PluginRegistry } from '../../src/plugins/registry.js';
import type { ConduitPlugin, PluginContext } from '../../src/plugins/types.js';

function makeCtx(overrides?: Partial<PluginContext>): PluginContext {
  return {
    serverId: 'test-server',
    method: 'tools/call',
    clientId: 'test-client',
    traceId: 'trace-123',
    message: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    extraHeaders: {},
    metadata: {},
    ...overrides,
  };
}

describe('PluginRegistry', () => {
  it('registers a plugin and reports size', () => {
    const registry = new PluginRegistry();
    const plugin: ConduitPlugin = { name: 'test', hooks: {} };
    registry.register(plugin);
    expect(registry.size).toBe(1);
    expect(registry.getPluginNames()).toEqual(['test']);
  });

  it('runs before:request hooks in order', async () => {
    const registry = new PluginRegistry();
    const order: number[] = [];

    registry.register({
      name: 'first',
      hooks: {
        'before:request': async () => { order.push(1); },
      },
    });
    registry.register({
      name: 'second',
      hooks: {
        'before:request': async () => { order.push(2); },
      },
    });

    await registry.runHook('before:request', makeCtx());
    expect(order).toEqual([1, 2]);
  });

  it('short-circuits when a plugin returns a response', async () => {
    const registry = new PluginRegistry();
    const secondHook = vi.fn();

    registry.register({
      name: 'blocker',
      hooks: {
        'before:request': async () => ({
          response: { body: { error: 'blocked' } },
        }),
      },
    });
    registry.register({
      name: 'should-not-run',
      hooks: { 'before:request': secondHook },
    });

    const result = await registry.runHook('before:request', makeCtx());
    expect(result).toBeDefined();
    expect(result?.response?.body).toEqual({ error: 'blocked' });
    expect(secondHook).not.toHaveBeenCalled();
  });

  it('continues after a plugin throws', async () => {
    const registry = new PluginRegistry();
    const secondHook = vi.fn();

    registry.register({
      name: 'broken',
      hooks: {
        'before:request': async () => { throw new Error('boom'); },
      },
    });
    registry.register({
      name: 'resilient',
      hooks: { 'before:request': secondHook },
    });

    const result = await registry.runHook('before:request', makeCtx());
    expect(result).toBeUndefined();
    expect(secondHook).toHaveBeenCalled();
  });

  it('returns undefined for hooks with no registrations', async () => {
    const registry = new PluginRegistry();
    const result = await registry.runHook('after:auth', makeCtx());
    expect(result).toBeUndefined();
  });

  it('allows plugins to modify context metadata', async () => {
    const registry = new PluginRegistry();

    registry.register({
      name: 'tagger',
      hooks: {
        'before:request': async (ctx) => {
          ctx.metadata['tagged'] = true;
        },
      },
    });

    const ctx = makeCtx();
    await registry.runHook('before:request', ctx);
    expect(ctx.metadata['tagged']).toBe(true);
  });

  it('initializes and shuts down plugins', async () => {
    const registry = new PluginRegistry();
    const initFn = vi.fn();
    const shutdownFn = vi.fn();

    registry.register({
      name: 'lifecycle',
      hooks: {},
      initialize: initFn,
      shutdown: shutdownFn,
    });

    await registry.initializeAll();
    expect(initFn).toHaveBeenCalledOnce();

    await registry.shutdownAll();
    expect(shutdownFn).toHaveBeenCalledOnce();
  });

  it('handles initialize failures gracefully', async () => {
    const registry = new PluginRegistry();

    registry.register({
      name: 'failing-init',
      hooks: {},
      initialize: async () => { throw new Error('init fail'); },
    });

    // Should not throw
    await registry.initializeAll();
  });
});
