#!/usr/bin/env node
/**
 * Mini serveur MCP stdio pour les tests.
 * Lit des requêtes JSON-RPC sur stdin (une par ligne),
 * répond sur stdout (une par ligne).
 */

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });

const TOOLS = [
  { name: 'echo', description: 'Echoes back the input', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
  { name: 'add', description: 'Adds two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
];

rl.on('line', (line: string) => {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // Ignorer les lignes non-JSON
  }

  const id = request['id'];
  const method = request['method'] as string;
  const params = (request['params'] ?? {}) as Record<string, unknown>;

  let result: unknown;

  switch (method) {
    case 'initialize':
      result = {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'mock-stdio-server', version: '1.0.0' },
        capabilities: { tools: {} },
      };
      break;

    case 'tools/list':
      result = { tools: TOOLS };
      break;

    case 'tools/call': {
      const toolName = params['name'] as string;
      const args = (params['arguments'] ?? {}) as Record<string, unknown>;

      if (toolName === 'echo') {
        result = { content: [{ type: 'text', text: String(args['message'] ?? '') }] };
      } else if (toolName === 'add') {
        const sum = Number(args['a'] ?? 0) + Number(args['b'] ?? 0);
        result = { content: [{ type: 'text', text: String(sum) }] };
      } else {
        const response = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
        process.stdout.write(response + '\n');
        return;
      }
      break;
    }

    default: {
      const response = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
      process.stdout.write(response + '\n');
      return;
    }
  }

  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(response + '\n');
});
