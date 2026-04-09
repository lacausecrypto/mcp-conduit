/**
 * Exemple de plugin Conduit : audit logger.
 * Log chaque requête et réponse sur la console.
 */

import type { ConduitPlugin } from '../../src/plugins/types.js';

const plugin: ConduitPlugin = {
  name: 'audit-logger',

  hooks: {
    'before:request': async (ctx) => {
      console.log(`[audit] Incoming: ${ctx.method} from ${ctx.clientId} → ${ctx.serverId}`);
    },

    'after:upstream': async (ctx) => {
      console.log(`[audit] Upstream done: ${ctx.method} tool=${ctx.toolName ?? 'n/a'}`);
    },
  },
};

export default plugin;
