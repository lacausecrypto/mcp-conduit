/**
 * Factory pour créer le bon type de client MCP selon le transport configuré.
 */

import type { ServerConfig } from '../config/types.js';
import type { IMcpClient } from './mcp-client-interface.js';
import { McpClient } from './mcp-client.js';
import { StdioMcpClient } from './stdio-mcp-client.js';

/**
 * Crée un client MCP adapté au transport configuré.
 * - 'http' (défaut) → McpClient classique via HTTP fetch
 * - 'stdio' → StdioMcpClient via processus enfant stdin/stdout
 */
export function createMcpClient(config: ServerConfig): IMcpClient {
  const transport = config.transport ?? 'http';

  switch (transport) {
    case 'stdio':
      return new StdioMcpClient(config);
    case 'http':
      return new McpClient(config);
    default:
      throw new Error(`Transport inconnu "${transport}" pour le serveur "${config.id}"`);
  }
}
