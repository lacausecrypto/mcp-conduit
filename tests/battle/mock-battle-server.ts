/**
 * Serveur MCP simulé pour les tests de résistance (battle tests).
 *
 * Contrairement au mock-mcp-server e2e normal, ce serveur est
 * entièrement configurable pour simuler :
 * - Réponses lentes (delayMs)
 * - Taux d'erreur aléatoire (errorRate)
 * - Codes HTTP arbitraires (httpStatus)
 * - JSON malformé (malformedJson)
 * - Charges utiles énormes (hugePayloadKb)
 * - Blocage indéfini (hangForever)
 * - Coupure de connexion (dropConnection)
 *
 * Endpoints de contrôle :
 *   GET  /test/stats      — statistiques
 *   POST /test/configure  — met à jour la config
 *   POST /test/reset      — remet les compteurs à zéro
 */

import http from 'node:http';

export interface BattleServerConfig {
  /** Délai en ms avant de répondre (défaut : 0) */
  delayMs: number;
  /** Taux d'erreur [0–1] — les requêtes échouent aléatoirement (défaut : 0) */
  errorRate: number;
  /** Code HTTP forcé — 0 = comportement normal (défaut : 0) */
  httpStatus: number;
  /** Retourner du JSON malformé (défaut : false) */
  malformedJson: boolean;
  /** Retourner une charge utile de N Ko (0 = normal) */
  hugePayloadKb: number;
  /** Ne jamais répondre (défaut : false) */
  hangForever: boolean;
  /** Fermer la connexion TCP sans répondre (défaut : false) */
  dropConnection: boolean;
}

export interface BattleServerStats {
  totalRequests: number;
  errors: number;
  hangs: number;
  drops: number;
  /** Timestamps des requêtes (Date.now()) */
  requestTimestamps: number[];
}

export interface MockBattleServer {
  url: string;
  close(): Promise<void>;
  getStats(): BattleServerStats;
  resetStats(): void;
  configure(config: Partial<BattleServerConfig>): void;
  getConfig(): BattleServerConfig;
}

const DEFAULT_TOOLS = [
  {
    name: 'battle_tool',
    description: 'Outil de test résistance',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateHugePayload(kb: number): string {
  const target = kb * 1024;
  const chunk = 'x'.repeat(1024);
  const chunks: string[] = [];
  let size = 0;
  while (size < target) {
    chunks.push(chunk);
    size += 1024;
  }
  return chunks.join('');
}

/**
 * Démarre un serveur de battle test.
 */
export function startMockBattleServer(port = 0): Promise<MockBattleServer> {
  const config: BattleServerConfig = {
    delayMs: 0,
    errorRate: 0,
    httpStatus: 0,
    malformedJson: false,
    hugePayloadKb: 0,
    hangForever: false,
    dropConnection: false,
  };

  const stats: BattleServerStats = {
    totalRequests: 0,
    errors: 0,
    hangs: 0,
    drops: 0,
    requestTimestamps: [],
  };

  function buildToolsListResponse(id: unknown): object {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: DEFAULT_TOOLS },
    };
  }

  function buildToolCallResponse(id: unknown, kb: number): object {
    if (kb > 0) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: generateHugePayload(kb) }],
        },
      };
    }
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: 'OK' }] },
    };
  }

  function buildInitResponse(id: unknown): object {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-battle-server', version: '1.0.0' },
      },
    };
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';

      // ── Endpoints de contrôle ────────────────────────────────────────────────
      if (url === '/test/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...stats, requestTimestamps: [...stats.requestTimestamps] }));
        return;
      }

      if (url === '/test/reset') {
        stats.totalRequests = 0;
        stats.errors = 0;
        stats.hangs = 0;
        stats.drops = 0;
        stats.requestTimestamps = [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url === '/test/configure') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const partial = JSON.parse(body) as Partial<BattleServerConfig>;
            Object.assign(config, partial);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, config: { ...config } }));
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      // ── Requêtes MCP normales ────────────────────────────────────────────────
      stats.totalRequests++;
      stats.requestTimestamps.push(Date.now());

      // Coupure de connexion immédiate
      if (config.dropConnection) {
        stats.drops++;
        req.socket.destroy();
        return;
      }

      // Blocage indéfini
      if (config.hangForever) {
        stats.hangs++;
        // Consomme le corps mais ne répond jamais
        req.resume();
        return;
      }

      // Erreur aléatoire
      if (config.errorRate > 0 && Math.random() < config.errorRate) {
        stats.errors++;
        const statusCode = config.httpStatus > 0 ? config.httpStatus : 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Simulated error' },
        }));
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });

      req.on('end', () => {
        // Délai simulé
        const handleRequest = async () => {
          if (config.delayMs > 0) {
            await sleep(config.delayMs);
          }

          // Code HTTP forcé (500, 502, 503)
          const statusCode = config.httpStatus > 0 ? config.httpStatus : 200;

          // JSON malformé
          if (config.malformedJson) {
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end('{ this is not valid JSON }{{{');
            return;
          }

          // Code HTTP non-2xx (réponse JSON-RPC d'erreur)
          if (statusCode >= 400) {
            stats.errors++;
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32000, message: `HTTP ${statusCode}` },
            }));
            return;
          }

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(body) as Record<string, unknown>;
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error' },
            }));
            return;
          }

          const id = parsed['id'] ?? null;
          const method = String(parsed['method'] ?? '');

          let responseBody: object;
          if (method === 'initialize') {
            responseBody = buildInitResponse(id);
          } else if (method === 'tools/list') {
            responseBody = buildToolsListResponse(id);
          } else if (method === 'tools/call') {
            responseBody = buildToolCallResponse(id, config.hugePayloadKb);
          } else {
            responseBody = {
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: `Unknown method: ${method}` },
            };
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseBody));
        };

        handleRequest().catch(() => {
          res.writeHead(500);
          res.end();
        });
      });

      req.on('error', () => {
        // Ignorer les erreurs de requête
      });
    });

    server.on('error', reject);

    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Impossible de récupérer l\'adresse du serveur battle'));
        return;
      }

      const serverUrl = `http://127.0.0.1:${address.port}`;

      resolve({
        url: serverUrl,

        close(): Promise<void> {
          return new Promise((res, rej) => {
            server.closeAllConnections?.();
            server.close((err) => {
              if (err) rej(err);
              else res();
            });
          });
        },

        getStats(): BattleServerStats {
          return { ...stats, requestTimestamps: [...stats.requestTimestamps] };
        },

        resetStats(): void {
          stats.totalRequests = 0;
          stats.errors = 0;
          stats.hangs = 0;
          stats.drops = 0;
          stats.requestTimestamps = [];
        },

        configure(partial: Partial<BattleServerConfig>): void {
          Object.assign(config, partial);
        },

        getConfig(): BattleServerConfig {
          return { ...config };
        },
      });
    });
  });
}
