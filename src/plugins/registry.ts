/**
 * Registre de plugins — stocke et exécute les hooks de plugins.
 *
 * Les hooks sont exécutés séquentiellement dans l'ordre d'enregistrement.
 * Chaque hook est wrappé dans un try/catch pour éviter qu'un plugin
 * défaillant ne crashe le pipeline. Un hook peut court-circuiter le
 * pipeline en retournant un PluginResult avec une response.
 */

import type {
  HookName,
  PluginContext,
  PluginResult,
  ConduitPlugin,
  HookCallback,
} from './types.js';

/** Entrée interne de hook avec référence au plugin source */
interface RegisteredHook {
  pluginName: string;
  callback: HookCallback;
}

export class PluginRegistry {
  private readonly hooks = new Map<HookName, RegisteredHook[]>();
  private readonly plugins: ConduitPlugin[] = [];

  /** Enregistre un plugin et ses hooks. */
  register(plugin: ConduitPlugin): void {
    this.plugins.push(plugin);

    for (const [hookName, callback] of Object.entries(plugin.hooks)) {
      if (!callback) continue;

      const name = hookName as HookName;
      if (!this.hooks.has(name)) {
        this.hooks.set(name, []);
      }
      this.hooks.get(name)!.push({
        pluginName: plugin.name,
        callback,
      });
    }
  }

  /**
   * Exécute tous les hooks enregistrés pour un point donné.
   * Retourne un PluginResult si un hook demande un court-circuit,
   * ou undefined si tous les hooks ont terminé normalement.
   */
  async runHook(name: HookName, ctx: PluginContext): Promise<PluginResult | undefined> {
    const registeredHooks = this.hooks.get(name);
    if (!registeredHooks || registeredHooks.length === 0) return undefined;

    for (const hook of registeredHooks) {
      try {
        const result = await hook.callback(ctx);
        if (result?.response) {
          return result;
        }
      } catch (error) {
        console.error(
          `[Conduit] Plugin "${hook.pluginName}" error in hook "${name}":`,
          error instanceof Error ? error.message : error,
        );
        // Continue avec le prochain hook — un plugin défaillant
        // ne doit pas casser le pipeline
      }
    }

    return undefined;
  }

  /** Initialise tous les plugins. */
  async initializeAll(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.initialize) {
        try {
          await plugin.initialize();
        } catch (error) {
          console.error(
            `[Conduit] Plugin "${plugin.name}" initialization failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
  }

  /** Arrête proprement tous les plugins. */
  async shutdownAll(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.shutdown) {
        try {
          await plugin.shutdown();
        } catch (error) {
          console.error(
            `[Conduit] Plugin "${plugin.name}" shutdown error:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
  }

  /** Nombre de plugins enregistrés. */
  get size(): number {
    return this.plugins.length;
  }

  /** Noms des plugins enregistrés. */
  getPluginNames(): string[] {
    return this.plugins.map((p) => p.name);
  }
}
