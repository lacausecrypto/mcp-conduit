/**
 * Chargeur de plugins via dynamic import.
 * Valide que chaque module exporté implémente l'interface ConduitPlugin.
 */

import { resolve } from 'node:path';
import type { PluginConfig, ConduitPlugin, HookName } from './types.js';

const VALID_HOOKS: Set<string> = new Set([
  'before:request',
  'after:auth',
  'before:cache',
  'after:upstream',
  'before:response',
]);

/**
 * Charge les plugins depuis les chemins configurés.
 * Retourne les plugins validés. Les plugins invalides sont loggés et ignorés.
 */
export async function loadPlugins(configs: PluginConfig[]): Promise<ConduitPlugin[]> {
  const plugins: ConduitPlugin[] = [];

  for (const config of configs) {
    try {
      const plugin = await loadSinglePlugin(config);
      plugins.push(plugin);
      console.log(`[Conduit] Plugin "${config.name}" loaded (hooks: ${config.hooks.join(', ')})`);
    } catch (error) {
      console.error(
        `[Conduit] Failed to load plugin "${config.name}" from "${config.path}":`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return plugins;
}

async function loadSinglePlugin(config: PluginConfig): Promise<ConduitPlugin> {
  // Valider les hooks avant le chargement
  for (const hook of config.hooks) {
    if (!VALID_HOOKS.has(hook)) {
      throw new Error(`Invalid hook "${hook}". Valid hooks: ${[...VALID_HOOKS].join(', ')}`);
    }
  }

  // Résoudre le chemin (relatif au CWD ou absolu)
  const modulePath = config.path.startsWith('.')
    ? resolve(process.cwd(), config.path)
    : config.path;

  // Security: block dangerous paths (Unix + Windows system directories)
  const resolved = resolve(modulePath);
  const BLOCKED_PREFIXES = process.platform === 'win32'
    ? ['C:\\Windows\\', 'C:\\Program Files\\', 'C:\\ProgramData\\']
    : ['/etc/', '/root/', '/proc/', '/sys/', '/dev/'];
  const normalizedResolved = resolved.toLowerCase();
  for (const blocked of BLOCKED_PREFIXES) {
    if (normalizedResolved.startsWith(blocked.toLowerCase())) {
      throw new Error(`Plugin path "${config.path}" points to a blocked system directory (${blocked})`);
    }
  }
  if (config.path.includes('..') && !resolved.startsWith(process.cwd())) {
    throw new Error(`Plugin path "${config.path}" contains path traversal outside the project`);
  }

  // Dynamic import
  const mod = await import(modulePath) as Record<string, unknown>;

  // Le module peut exporter le plugin comme default ou comme export nommé "plugin"
  const pluginFactory = mod['default'] ?? mod['plugin'] ?? mod['createPlugin'];

  let plugin: ConduitPlugin;

  if (typeof pluginFactory === 'function') {
    // Factory function: createPlugin(config) → ConduitPlugin
    plugin = pluginFactory(config.config ?? {}) as ConduitPlugin;
  } else if (typeof pluginFactory === 'object' && pluginFactory !== null) {
    plugin = pluginFactory as ConduitPlugin;
  } else {
    throw new Error(
      `Module must export a default/plugin/createPlugin (got ${typeof pluginFactory})`,
    );
  }

  // Validation
  if (!plugin.name || typeof plugin.name !== 'string') {
    throw new Error('Plugin must have a "name" string property');
  }
  if (!plugin.hooks || typeof plugin.hooks !== 'object') {
    throw new Error('Plugin must have a "hooks" object property');
  }

  // Filtrer uniquement les hooks demandés dans la config
  const allowedHooks = new Set(config.hooks);
  const filteredHooks: ConduitPlugin['hooks'] = {};
  for (const [hookName, callback] of Object.entries(plugin.hooks)) {
    if (allowedHooks.has(hookName as HookName) && typeof callback === 'function') {
      filteredHooks[hookName as HookName] = callback;
    }
  }
  plugin.hooks = filteredHooks;

  return plugin;
}
