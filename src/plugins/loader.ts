/**
 * Chargeur de plugins via dynamic import.
 * Valide que chaque module exporté implémente l'interface ConduitPlugin.
 */

import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { PluginConfig, ConduitPlugin, HookName } from './types.js';

/**
 * Default directory plugins must live inside (resolved against CWD).
 *
 * Restricting to a single directory turns "anywhere under the project"
 * into an explicit allowlist. Without it, a compromised npm dependency
 * could be registered as a plugin via the YAML config and execute with
 * full gateway privileges (Redis, SQLite, secrets) — battle-test #4.
 *
 * Operators who genuinely need plugins outside this directory must opt
 * out explicitly via PluginLoadOptions.allowedDirs.
 */
const DEFAULT_ALLOWED_DIR = 'plugins';

/**
 * Test seam: lets the test suite append additional allowed directories
 * without rewriting every loadPlugins() call. Production code never sets
 * this; tests reset it in afterEach.
 */
let testAllowedDirs: string[] = [];
export function _setTestAllowedDirs(dirs: string[]): void { testAllowedDirs = dirs; }
export function _resetTestAllowedDirs(): void { testAllowedDirs = []; }

const VALID_HOOKS: Set<string> = new Set([
  'before:request',
  'after:auth',
  'before:cache',
  'after:upstream',
  'before:response',
]);

export interface PluginLoadOptions {
  /**
   * Allowlist of directories under which plugin files must live (resolved
   * against CWD). When omitted, defaults to `./plugins`. Pass an empty
   * array to disable the allowlist (NOT recommended — operators must
   * understand they are accepting any path under CWD).
   */
  allowedDirs?: string[];
}

/**
 * Charge les plugins depuis les chemins configurés.
 * Retourne les plugins validés. Les plugins invalides sont loggés et ignorés.
 */
export async function loadPlugins(
  configs: PluginConfig[],
  options: PluginLoadOptions = {},
): Promise<ConduitPlugin[]> {
  const plugins: ConduitPlugin[] = [];
  const allowedDirs = [
    ...(options.allowedDirs ?? [DEFAULT_ALLOWED_DIR]),
    ...testAllowedDirs,
  ];

  for (const config of configs) {
    try {
      const plugin = await loadSinglePlugin(config, allowedDirs);
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

function isUnderAnyAllowedDir(realPath: string, allowedDirs: string[]): boolean {
  if (allowedDirs.length === 0) return true; // explicit opt-out
  for (const dir of allowedDirs) {
    const root = resolve(process.cwd(), dir);
    // The plugin path was symlink-resolved (realpathSync) before reaching us.
    // Resolve symlinks for the allowed root too so comparisons survive
    // /tmp → /private/tmp style aliases on macOS.
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      realRoot = root;
    }
    const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (realPath === realRoot || realPath.startsWith(rootWithSep)) return true;
  }
  return false;
}

async function loadSinglePlugin(
  config: PluginConfig,
  allowedDirs: string[],
): Promise<ConduitPlugin> {
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
  // Resolve symlinks so that a legitimate-looking path inside CWD cannot
  // redirect the loader to /etc or another protected prefix.
  let realResolved: string;
  try {
    realResolved = realpathSync(resolved);
  } catch {
    // Path does not exist yet — fall back to the lexical resolve; the
    // subsequent dynamic import() will fail with a clearer error.
    realResolved = resolved;
  }
  const BLOCKED_PREFIXES = process.platform === 'win32'
    ? ['C:\\Windows\\', 'C:\\Program Files\\', 'C:\\ProgramData\\']
    : ['/etc/', '/root/', '/proc/', '/sys/', '/dev/'];
  const candidates = [resolved.toLowerCase(), realResolved.toLowerCase()];
  for (const blocked of BLOCKED_PREFIXES) {
    const blockedLower = blocked.toLowerCase();
    if (candidates.some((c) => c.startsWith(blockedLower))) {
      throw new Error(`Plugin path "${config.path}" points to a blocked system directory (${blocked})`);
    }
  }
  if (config.path.includes('..') && !realResolved.startsWith(process.cwd())) {
    throw new Error(`Plugin path "${config.path}" contains path traversal outside the project`);
  }

  // Allowlist enforcement — plugins must live inside one of the configured
  // directories. Without this, ANY file under CWD (including a compromised
  // node_modules entry) could be registered as a plugin via YAML config and
  // execute arbitrary code with full gateway privileges.
  if (!isUnderAnyAllowedDir(realResolved, allowedDirs)) {
    throw new Error(
      `Plugin path "${config.path}" is outside the allowed plugin directories ` +
      `(${allowedDirs.length === 0 ? '<none>' : allowedDirs.join(', ')}). ` +
      'Place the plugin under one of these directories or extend the allowlist explicitly.',
    );
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
