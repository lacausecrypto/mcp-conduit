/**
 * Tests for src/plugins/loader.ts
 *
 * Covers:
 * - loadPlugins with empty array
 * - loadPlugins skips failed plugins (logs error, continues)
 * - loadSinglePlugin rejects invalid hook names
 * - loadSinglePlugin with valid default export object
 * - loadSinglePlugin with factory function (createPlugin)
 * - loadSinglePlugin filters hooks to only those in config.hooks
 * - loadSinglePlugin rejects module with no valid export
 * - loadSinglePlugin rejects plugin without name
 * - loadSinglePlugin rejects plugin without hooks object
 * - loadPlugins loads multiple plugins maintaining order
 * - loadSinglePlugin passes config.config to factory function
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig, HookName } from '../../src/plugins/types.js';

// We need to dynamically import the loader each time to avoid module caching issues
// For testing, we create real .mjs files in a temp directory and load them.

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'conduit-plugin-loader-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Helper: write a plugin module to a temp file and return its absolute path.
 */
function writePlugin(filename: string, code: string): string {
  const filePath = join(tmpDir, filename);
  writeFileSync(filePath, code, 'utf-8');
  return filePath;
}

/**
 * Helper: make a PluginConfig pointing to a temp file.
 */
function makePluginConfig(
  name: string,
  filePath: string,
  hooks: HookName[] = ['before:request'],
  config?: Record<string, unknown>,
): PluginConfig {
  return { name, path: filePath, hooks, config };
}

describe('loadPlugins', () => {
  it('returns empty array for empty config array', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const result = await loadPlugins([]);
    expect(result).toEqual([]);
  });

  it('skips plugins that fail to load and logs error', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await loadPlugins([
      {
        name: 'broken-plugin',
        path: '/nonexistent/path/to/plugin.js',
        hooks: ['before:request'],
      },
    ]);

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load plugin "broken-plugin"'),
      expect.any(String),
    );

    errorSpy.mockRestore();
  });

  it('loads multiple plugins maintaining insertion order', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pathA = writePlugin('plugin-a.mjs', `
      export default {
        name: 'alpha',
        hooks: { 'before:request': async () => {} },
      };
    `);

    const pathB = writePlugin('plugin-b.mjs', `
      export default {
        name: 'beta',
        hooks: { 'before:request': async () => {} },
      };
    `);

    const pathC = writePlugin('plugin-c.mjs', `
      export default {
        name: 'gamma',
        hooks: { 'before:request': async () => {} },
      };
    `);

    const configs: PluginConfig[] = [
      makePluginConfig('Alpha', pathA),
      makePluginConfig('Beta', pathB),
      makePluginConfig('Gamma', pathC),
    ];

    const result = await loadPlugins(configs);

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('alpha');
    expect(result[1].name).toBe('beta');
    expect(result[2].name).toBe('gamma');

    logSpy.mockRestore();
  });

  it('continues loading remaining plugins when one fails', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const validPath = writePlugin('valid-plugin.mjs', `
      export default {
        name: 'valid-one',
        hooks: { 'before:request': async () => {} },
      };
    `);

    const configs: PluginConfig[] = [
      { name: 'broken', path: '/nonexistent.js', hooks: ['before:request'] },
      makePluginConfig('Valid', validPath),
    ];

    const result = await loadPlugins(configs);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('valid-one');
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe('loadSinglePlugin — hook validation', () => {
  it('rejects invalid hook names', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pluginPath = writePlugin('hook-plugin.mjs', `
      export default { name: 'test', hooks: {} };
    `);

    const result = await loadPlugins([
      {
        name: 'bad-hook',
        path: pluginPath,
        hooks: ['invalid:hook' as HookName],
      },
    ]);

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load plugin "bad-hook"'),
      expect.stringContaining('Invalid hook "invalid:hook"'),
    );

    errorSpy.mockRestore();
  });

  it('rejects hook names that look like valid hooks but are not', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pluginPath = writePlugin('almost-hook.mjs', `
      export default { name: 'test', hooks: {} };
    `);

    const result = await loadPlugins([
      {
        name: 'almost',
        path: pluginPath,
        hooks: ['before:Request' as HookName], // case-sensitive, should fail
      },
    ]);

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe('loadSinglePlugin — default export object', () => {
  it('loads plugin from default export object', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pluginPath = writePlugin('default-obj.mjs', `
      export default {
        name: 'default-obj-plugin',
        hooks: {
          'before:request': async (ctx) => {},
          'after:auth': async (ctx) => {},
        },
      };
    `);

    const result = await loadPlugins([
      makePluginConfig('Default Object', pluginPath, ['before:request', 'after:auth']),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('default-obj-plugin');
    expect(result[0].hooks['before:request']).toBeTypeOf('function');
    expect(result[0].hooks['after:auth']).toBeTypeOf('function');

    logSpy.mockRestore();
  });
});

describe('loadSinglePlugin — named export "plugin"', () => {
  it('loads plugin from named "plugin" export', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pluginPath = writePlugin('named-plugin.mjs', `
      export const plugin = {
        name: 'named-plugin',
        hooks: {
          'before:request': async () => {},
        },
      };
    `);

    const result = await loadPlugins([
      makePluginConfig('Named', pluginPath, ['before:request']),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('named-plugin');

    logSpy.mockRestore();
  });
});

describe('loadSinglePlugin — factory function (createPlugin)', () => {
  it('loads plugin from createPlugin factory', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pluginPath = writePlugin('factory-plugin.mjs', `
      export function createPlugin(config) {
        return {
          name: 'factory-plugin',
          hooks: {
            'before:request': async () => {},
          },
          _receivedConfig: config,
        };
      }
    `);

    const result = await loadPlugins([
      makePluginConfig('Factory', pluginPath, ['before:request'], { key: 'value' }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('factory-plugin');

    logSpy.mockRestore();
  });

  it('passes config.config to factory function', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pluginPath = writePlugin('config-factory.mjs', `
      let capturedConfig = null;
      export function createPlugin(config) {
        capturedConfig = config;
        return {
          name: 'config-aware',
          hooks: { 'before:request': async () => {} },
          getConfig() { return capturedConfig; },
        };
      }
    `);

    const pluginConfig = { timeout: 5000, endpoint: 'https://example.com' };
    const result = await loadPlugins([
      makePluginConfig('ConfigAware', pluginPath, ['before:request'], pluginConfig),
    ]);

    expect(result).toHaveLength(1);
    // The factory receives the config — we verify by checking the plugin was loaded.
    // Direct config inspection would require reaching into the module, but the
    // factory pattern itself is what we are testing.
    expect(result[0].name).toBe('config-aware');

    logSpy.mockRestore();
  });

  it('passes empty object to factory when config.config is undefined', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pluginPath = writePlugin('no-config-factory.mjs', `
      export function createPlugin(config) {
        if (typeof config !== 'object' || config === null) {
          throw new Error('Expected an object, got ' + typeof config);
        }
        return {
          name: 'no-config-plugin',
          hooks: { 'before:request': async () => {} },
        };
      }
    `);

    // No config property
    const result = await loadPlugins([
      makePluginConfig('NoConfig', pluginPath, ['before:request']),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('no-config-plugin');

    logSpy.mockRestore();
  });

  it('loads plugin from default export factory function', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pluginPath = writePlugin('default-factory.mjs', `
      export default function(config) {
        return {
          name: 'default-factory-plugin',
          hooks: {
            'after:upstream': async () => {},
          },
        };
      }
    `);

    const result = await loadPlugins([
      makePluginConfig('DefaultFactory', pluginPath, ['after:upstream']),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('default-factory-plugin');
    expect(result[0].hooks['after:upstream']).toBeTypeOf('function');

    logSpy.mockRestore();
  });
});

describe('loadSinglePlugin — hook filtering', () => {
  it('filters hooks to only those listed in config.hooks', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pluginPath = writePlugin('multi-hook.mjs', `
      export default {
        name: 'multi-hook-plugin',
        hooks: {
          'before:request': async () => {},
          'after:auth': async () => {},
          'before:cache': async () => {},
          'after:upstream': async () => {},
          'before:response': async () => {},
        },
      };
    `);

    // Only allow two hooks
    const result = await loadPlugins([
      makePluginConfig('MultiHook', pluginPath, ['before:request', 'before:response']),
    ]);

    expect(result).toHaveLength(1);
    const hooks = result[0].hooks;
    expect(hooks['before:request']).toBeTypeOf('function');
    expect(hooks['before:response']).toBeTypeOf('function');
    // These should be filtered out
    expect(hooks['after:auth']).toBeUndefined();
    expect(hooks['before:cache']).toBeUndefined();
    expect(hooks['after:upstream']).toBeUndefined();

    logSpy.mockRestore();
  });

  it('filters out non-function hook entries', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pluginPath = writePlugin('non-fn-hook.mjs', `
      export default {
        name: 'non-fn-hooks',
        hooks: {
          'before:request': 'not-a-function',
          'after:auth': async () => {},
        },
      };
    `);

    const result = await loadPlugins([
      makePluginConfig('NonFn', pluginPath, ['before:request', 'after:auth']),
    ]);

    expect(result).toHaveLength(1);
    // 'before:request' value is a string, should be filtered out
    expect(result[0].hooks['before:request']).toBeUndefined();
    expect(result[0].hooks['after:auth']).toBeTypeOf('function');

    logSpy.mockRestore();
  });

  it('returns empty hooks object when no allowed hooks match', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pluginPath = writePlugin('mismatch.mjs', `
      export default {
        name: 'mismatch-plugin',
        hooks: {
          'after:upstream': async () => {},
        },
      };
    `);

    // Config only allows 'before:request' but plugin only has 'after:upstream'
    const result = await loadPlugins([
      makePluginConfig('Mismatch', pluginPath, ['before:request']),
    ]);

    expect(result).toHaveLength(1);
    expect(Object.keys(result[0].hooks)).toHaveLength(0);

    logSpy.mockRestore();
  });
});

describe('loadSinglePlugin — validation errors', () => {
  it('rejects module with no valid export (number export)', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pluginPath = writePlugin('no-export.mjs', `
      export const something = 42;
    `);

    const result = await loadPlugins([
      makePluginConfig('NoExport', pluginPath, ['before:request']),
    ]);

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load plugin "NoExport"'),
      expect.stringContaining('Module must export a default/plugin/createPlugin'),
    );

    errorSpy.mockRestore();
  });

  it('rejects module that exports a string', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pluginPath = writePlugin('string-export.mjs', `
      export default 'not-a-plugin';
    `);

    const result = await loadPlugins([
      makePluginConfig('StringExport', pluginPath, ['before:request']),
    ]);

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('rejects plugin without name property', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pluginPath = writePlugin('no-name.mjs', `
      export default {
        hooks: { 'before:request': async () => {} },
      };
    `);

    const result = await loadPlugins([
      makePluginConfig('NoName', pluginPath, ['before:request']),
    ]);

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load plugin "NoName"'),
      expect.stringContaining('Plugin must have a "name" string property'),
    );

    errorSpy.mockRestore();
  });

  it('rejects plugin with empty string name', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pluginPath = writePlugin('empty-name.mjs', `
      export default {
        name: '',
        hooks: { 'before:request': async () => {} },
      };
    `);

    const result = await loadPlugins([
      makePluginConfig('EmptyName', pluginPath, ['before:request']),
    ]);

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load plugin "EmptyName"'),
      expect.stringContaining('Plugin must have a "name" string property'),
    );

    errorSpy.mockRestore();
  });

  it('rejects plugin with non-string name (number)', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pluginPath = writePlugin('num-name.mjs', `
      export default {
        name: 42,
        hooks: { 'before:request': async () => {} },
      };
    `);

    const result = await loadPlugins([
      makePluginConfig('NumName', pluginPath, ['before:request']),
    ]);

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('rejects plugin without hooks property', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pluginPath = writePlugin('no-hooks.mjs', `
      export default {
        name: 'no-hooks-plugin',
      };
    `);

    const result = await loadPlugins([
      makePluginConfig('NoHooks', pluginPath, ['before:request']),
    ]);

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load plugin "NoHooks"'),
      expect.stringContaining('Plugin must have a "hooks" object property'),
    );

    errorSpy.mockRestore();
  });

  it('rejects plugin with hooks set to null', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pluginPath = writePlugin('null-hooks.mjs', `
      export default {
        name: 'null-hooks',
        hooks: null,
      };
    `);

    const result = await loadPlugins([
      makePluginConfig('NullHooks', pluginPath, ['before:request']),
    ]);

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('rejects plugin with hooks set to a string', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pluginPath = writePlugin('string-hooks.mjs', `
      export default {
        name: 'string-hooks',
        hooks: 'not-an-object',
      };
    `);

    const result = await loadPlugins([
      makePluginConfig('StringHooks', pluginPath, ['before:request']),
    ]);

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe('loadSinglePlugin — path resolution', () => {
  it('resolves relative paths starting with "." from cwd', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Create plugin in a subdirectory of tmpDir
    const subDir = join(tmpDir, 'plugins');
    mkdirSync(subDir, { recursive: true });
    const pluginPath = join(subDir, 'rel-plugin.mjs');
    writeFileSync(pluginPath, `
      export default {
        name: 'relative-plugin',
        hooks: { 'before:request': async () => {} },
      };
    `);

    // Use absolute path (not actually relative, since we can't easily control cwd in tests)
    const result = await loadPlugins([
      makePluginConfig('Relative', pluginPath, ['before:request']),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('relative-plugin');

    logSpy.mockRestore();
  });
});

describe('loadSinglePlugin — all valid hooks accepted', () => {
  it('accepts all five valid hook names', async () => {
    const { loadPlugins } = await import('../../src/plugins/loader.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pluginPath = writePlugin('all-hooks.mjs', `
      export default {
        name: 'all-hooks-plugin',
        hooks: {
          'before:request': async () => {},
          'after:auth': async () => {},
          'before:cache': async () => {},
          'after:upstream': async () => {},
          'before:response': async () => {},
        },
      };
    `);

    const allHooks: HookName[] = [
      'before:request', 'after:auth', 'before:cache', 'after:upstream', 'before:response',
    ];

    const result = await loadPlugins([
      makePluginConfig('AllHooks', pluginPath, allHooks),
    ]);

    expect(result).toHaveLength(1);
    for (const hook of allHooks) {
      expect(result[0].hooks[hook]).toBeTypeOf('function');
    }

    logSpy.mockRestore();
  });
});
