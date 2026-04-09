/**
 * Serveur MCP simulé pour les tests e2e.
 *
 * Simule un backend MCP réel répondant aux méthodes JSON-RPC :
 * - initialize  — handshake initial
 * - tools/list  — retourne les outils enregistrés avec leurs annotations
 * - tools/call  — exécute un appel d'outil simulé
 */

import http from 'node:http';

/** Définition d'un outil dans le serveur simulé */
export interface MockTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** Résultat fixe retourné lors d'un appel */
  result?: unknown;
}

/** Interface du serveur simulé */
export interface MockMcpServer {
  /** URL de base du serveur (ex: http://localhost:PORT) */
  url: string;
  /** Arrête le serveur et libère le port */
  close(): Promise<void>;
  /** Retourne le nombre d'appels reçus pour une méthode donnée */
  getCallCount(method: string): number;
  /** Réinitialise les compteurs d'appels */
  resetCallCounts(): void;
  /** Retourne tous les appels reçus pour une méthode */
  getCalls(method: string): unknown[];
  /** Ajoute ou met à jour un outil simulé */
  setTool(tool: MockTool): void;
  /** Définit un comportement d'erreur pour un outil spécifique */
  setToolError(toolName: string, errorMessage: string): void;
  /** Supprime le comportement d'erreur d'un outil */
  clearToolError(toolName: string): void;
}

const DEFAULT_TOOLS: MockTool[] = [
  {
    name: 'get_contact',
    description: 'Récupère un contact par identifiant',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Identifiant du contact' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
    result: { id: '123', name: 'Alice Martin', email: 'alice@example.com' },
  },
  {
    name: 'search_leads',
    description: 'Recherche des leads par critères',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    annotations: { idempotentHint: true },
    result: { leads: [{ id: 'lead-1', name: 'Bob Dupont' }], total: 1 },
  },
  {
    name: 'create_contact',
    description: 'Crée un nouveau contact',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        password: { type: 'string' },
      },
      required: ['name'],
    },
    annotations: { destructiveHint: false },
    result: { id: 'new-contact-456', created: true },
  },
  {
    name: 'delete_contact',
    description: 'Supprime un contact (opération destructrice)',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    annotations: { destructiveHint: true },
    result: { deleted: true },
  },
];

/**
 * Démarre un serveur HTTP simulant un backend MCP.
 *
 * @param port Port d'écoute (0 = port aléatoire alloué par l'OS)
 * @param tools Liste des outils disponibles (défaut : outils de démo)
 */
export function startMockMcpServer(
  port = 0,
  tools: MockTool[] = DEFAULT_TOOLS,
): Promise<MockMcpServer> {
  // État interne du serveur simulé
  const callCounts = new Map<string, number>();
  const callArgs = new Map<string, unknown[]>();
  const toolMap = new Map<string, MockTool>();
  const toolErrors = new Map<string, string>();

  // Initialisation des outils
  for (const tool of tools) {
    toolMap.set(tool.name, { ...tool });
  }

  /**
   * Incrémente le compteur d'une méthode et mémorise les arguments.
   */
  function recordCall(method: string, args?: unknown): void {
    callCounts.set(method, (callCounts.get(method) ?? 0) + 1);
    const existing = callArgs.get(method) ?? [];
    existing.push(args ?? null);
    callArgs.set(method, existing);
  }

  /**
   * Traite une requête JSON-RPC et retourne la réponse appropriée.
   */
  function handleJsonRpc(req: unknown): Record<string, unknown> {
    const request = req as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };

    const id = request.id ?? null;
    const method = request.method ?? '';

    recordCall(method, request.params);

    // Méthode : initialize
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
        },
      };
    }

    // Méthode : tools/list
    if (method === 'tools/list') {
      const toolList = Array.from(toolMap.values()).map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        annotations: t.annotations ?? {},
      }));

      return {
        jsonrpc: '2.0',
        id,
        result: { tools: toolList },
      };
    }

    // Méthode : tools/call
    if (method === 'tools/call') {
      const toolName = String(request.params?.['name'] ?? '');

      // Vérification d'une erreur simulée
      const simulatedError = toolErrors.get(toolName);
      if (simulatedError) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: simulatedError,
          },
        };
      }

      const tool = toolMap.get(toolName);
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Outil introuvable : ${toolName}`,
          },
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        result: tool.result ?? { content: 'OK' },
      };
    }

    // Méthode inconnue
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Méthode inconnue : ${method}`,
      },
    };
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';

      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(body);

          res.setHeader('Content-Type', 'application/json');

          // Support des requêtes batch
          if (Array.isArray(parsed)) {
            const responses = parsed.map(handleJsonRpc);
            res.writeHead(200);
            res.end(JSON.stringify(responses));
          } else {
            const response = handleJsonRpc(parsed);
            res.writeHead(200);
            res.end(JSON.stringify(response));
          }
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Erreur de parsing JSON' },
          }));
        }
      });

      req.on('error', () => {
        res.writeHead(500);
        res.end();
      });
    });

    server.on('error', reject);

    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Impossible de récupérer l\'adresse du serveur simulé'));
        return;
      }

      const serverUrl = `http://127.0.0.1:${address.port}`;

      resolve({
        url: serverUrl,

        close(): Promise<void> {
          return new Promise((res, rej) => {
            server.close((err) => {
              if (err) rej(err);
              else res();
            });
          });
        },

        getCallCount(method: string): number {
          return callCounts.get(method) ?? 0;
        },

        resetCallCounts(): void {
          callCounts.clear();
          callArgs.clear();
        },

        getCalls(method: string): unknown[] {
          return callArgs.get(method) ?? [];
        },

        setTool(tool: MockTool): void {
          toolMap.set(tool.name, { ...tool });
        },

        setToolError(toolName: string, errorMessage: string): void {
          toolErrors.set(toolName, errorMessage);
        },

        clearToolError(toolName: string): void {
          toolErrors.delete(toolName);
        },
      });
    });
  });
}
