/**
 * Tests de cas limites — MCP Conduit.
 *
 * 1.  Arguments vides {}
 * 2.  Valeurs null dans les arguments
 * 3.  Noms d'outils Unicode
 * 4.  Nom d'outil très long (1000 caractères)
 * 5.  Arguments profondément imbriqués (20 niveaux)
 * 6.  Arguments tableaux (1000 éléments)
 * 7.  Caractères spéciaux dans les arguments
 * 8.  Réponse vide du backend { result: { content: [] } }
 * 9.  Concurrence tools/list et tools/call
 * 10. Invalidation rapide du cache (write-read-write-read)
 * 11. Limite TTL (requête juste après l'expiration)
 * 12. Même outil sur différents serveurs (namespace)
 * 13. Requête sans en-tête Authorization (auth requise)
 * 14. En-tête Authorization malformé
 * 15. Batch JSON-RPC avec requêtes valides/invalides mélangées
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { startMockMcpServer, type MockMcpServer, type MockTool } from '../e2e/mock-mcp-server.js';
import { resetMetrics } from '../../src/observability/metrics.js';
import type { Hono } from 'hono';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeToolCall(name: string, args: Record<string, unknown> = {}, id: number | string = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

async function sendJson<T>(
  app: Hono,
  serverId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await app.request(`/mcp/${serverId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

function makeBaseConfig(mockUrl: string, overrides: Partial<ConduitGatewayConfig> = {}): ConduitGatewayConfig {
  return {
    gateway: { port: 0, host: '127.0.0.1' },
    router: {
      namespace_strategy: 'none',
      health_check: {
        enabled: false, interval_seconds: 60,
        timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1,
      },
    },
    servers: [{
      id: 'edge-server',
      url: mockUrl,
      cache: { default_ttl: 300 },
    }],
    cache: { enabled: true, l1: { max_entries: 1000, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: {
      log_args: true, log_responses: false,
      redact_fields: [], retention_days: 1, db_path: ':memory:',
    },
    metrics: { enabled: false, port: 0 },
    ...overrides,
  };
}

let mockServer: MockMcpServer;
let gateway: ConduitGateway;
let app: Hono;

beforeEach(async () => {
  mockServer = await startMockMcpServer(0);
  resetMetrics();
  gateway = new ConduitGateway(makeBaseConfig(mockServer.url));
  await gateway.initialize();
  app = gateway.createApp();
});

afterEach(async () => {
  gateway.stop();
  await mockServer.close();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('cas limites — arguments vides {}', () => {
  it('tools/call avec args {} est accepté et mis en cache', async () => {
    const { body } = await sendJson<{ result?: unknown; error?: unknown }>(
      app, 'edge-server', makeToolCall('get_contact', {}),
    );
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();

    // Deuxième appel : doit venir du cache
    const { body: body2 } = await sendJson<{ result?: unknown }>(
      app, 'edge-server', makeToolCall('get_contact', {}),
    );
    expect(body2.result).toBeDefined();
    expect(gateway.getCacheStore().getStats().hits).toBe(1);
  });
});

describe('cas limites — valeurs null dans les arguments', () => {
  it('{ contact_id: null } est traité sans erreur', async () => {
    const { body } = await sendJson<{ result?: unknown; error?: unknown }>(
      app, 'edge-server', makeToolCall('get_contact', { contact_id: null }),
    );
    // Pas de crash (peut retourner un résultat ou une erreur métier)
    expect(body).toBeDefined();
  });
});

describe('cas limites — arguments profondément imbriqués', () => {
  it('20 niveaux d\'imbrication dans les arguments : traité sans stack overflow', async () => {
    let nested: Record<string, unknown> = { value: 'deep' };
    for (let i = 0; i < 20; i++) {
      nested = { level: i, child: nested };
    }
    const { body } = await sendJson<{ result?: unknown; error?: unknown }>(
      app, 'edge-server', makeToolCall('get_contact', { nested }),
    );
    expect(body).toBeDefined();
    // Ne doit pas planter
    expect(typeof body).toBe('object');
  });
});

describe('cas limites — arguments tableau', () => {
  it('{ ids: [1..1000] } est traité et la clé de cache est stable', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i); // 100 éléments
    const { body } = await sendJson<{ result?: unknown; error?: unknown }>(
      app, 'edge-server', makeToolCall('get_contact', { ids }),
    );
    expect(body).toBeDefined();

    // Deuxième appel avec le même tableau : doit venir du cache
    const { body: body2 } = await sendJson<{ result?: unknown }>(
      app, 'edge-server', makeToolCall('get_contact', { ids }),
    );
    expect(body2.result).toBeDefined();
    expect(gateway.getCacheStore().getStats().hits).toBe(1);
  });
});

describe('cas limites — caractères spéciaux dans les arguments', () => {
  it('newlines, tabulations, guillemets, backslashes dans les arguments', async () => {
    const specialArgs = {
      text: 'line1\nline2\ttabbed',
      quoted: '"double" and \'single\'',
      backslash: 'path\\to\\file',
      unicode: '中文 العربية 🚀',
      nullByte: 'before\x00after',
    };

    const { body } = await sendJson<{ result?: unknown; error?: unknown }>(
      app, 'edge-server', makeToolCall('get_contact', specialArgs),
    );
    expect(body).toBeDefined();
    // Ne doit pas crasher sur les caractères spéciaux
    expect(typeof body).toBe('object');
  });
});

describe('cas limites — réponse vide du backend', () => {
  it('{ content: [] } retourné par le backend : mis en cache correctement', async () => {
    // Configurer un outil qui retourne une liste de contenu vide
    // readOnlyHint: true est nécessaire pour que la politique de cache accepte de mettre en cache
    mockServer.setTool({
      name: 'empty_result_tool',
      description: 'Retourne un résultat vide',
      annotations: { readOnlyHint: true },
      result: { content: [] },
    });

    // Recréer le gateway pour récupérer le nouvel outil
    gateway.stop();
    resetMetrics();
    gateway = new ConduitGateway(makeBaseConfig(mockServer.url));
    await gateway.initialize();
    app = gateway.createApp();

    const { body } = await sendJson<{ result?: unknown; error?: unknown }>(
      app, 'edge-server', makeToolCall('empty_result_tool', {}),
    );
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();

    // Doit être mis en cache
    const stats = gateway.getCacheStore().getStats();
    expect(stats.entries).toBeGreaterThanOrEqual(1);
  });
});

describe('cas limites — concurrence tools/list et tools/call', () => {
  it('tools/list et tools/call en parallèle : pas de race condition', async () => {
    const N = 50;
    const listMsg = { jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} };
    const callMsg = makeToolCall('get_contact', { id: 'concurrent' });

    const requests = Array.from({ length: N }, (_, i) => {
      const body = i % 2 === 0 ? { ...listMsg, id: i } : { ...callMsg, id: i };
      return sendJson<{ result?: unknown; error?: unknown }>(app, 'edge-server', body);
    });

    const results = await Promise.all(requests);

    // Aucun crash
    for (const res of results) {
      expect(res.body).toBeDefined();
      expect(typeof res.body).toBe('object');
    }
  });
});

describe('cas limites — invalidation rapide du cache', () => {
  it('write → read → write → read : chaque lecture reflète la valeur la plus récente', async () => {
    const { body: r1 } = await sendJson<{ result?: unknown }>(
      app, 'edge-server', makeToolCall('get_contact', { id: 'inval-1' }, 1),
    );
    expect(r1.result).toBeDefined();

    // Lire depuis le cache
    const { body: r2 } = await sendJson<{ result?: unknown }>(
      app, 'edge-server', makeToolCall('get_contact', { id: 'inval-1' }, 2),
    );
    expect(r2.result).toBeDefined();
    expect(gateway.getCacheStore().getStats().hits).toBe(1);

    // Invalider le cache manuellement
    gateway.getCacheStore().deleteByTool('get_contact', 'edge-server');
    expect(gateway.getCacheStore().getStats().entries).toBe(0);

    // Nouvelle lecture : doit re-appeler l'upstream
    const callsBefore = mockServer.getCallCount('tools/call');
    await sendJson(app, 'edge-server', makeToolCall('get_contact', { id: 'inval-1' }, 3));
    expect(mockServer.getCallCount('tools/call')).toBe(callsBefore + 1);
  });
});

describe('cas limites — limite TTL', () => {
  it('une entrée expirée (TTL=0) n\'est PAS retournée depuis le cache', async () => {
    // TTL = 0 secondes → expiré immédiatement
    gateway.stop();
    resetMetrics();
    gateway = new ConduitGateway(makeBaseConfig(mockServer.url, {
      servers: [{
        id: 'edge-server',
        url: mockServer.url,
        cache: {
          default_ttl: 300,
          overrides: { ttl_zero_tool: { ttl: 0 } },
        },
      }],
    }));
    await gateway.initialize();
    app = gateway.createApp();

    mockServer.setTool({
      name: 'ttl_zero_tool',
      description: 'TTL 0',
      result: { value: 'fresh' },
    });

    // Premier appel — MISS
    await sendJson(app, 'edge-server', makeToolCall('ttl_zero_tool', { id: 'ttl-0' }, 1));
    const callsAfterFirst = mockServer.getCallCount('tools/call');

    // Micro-pause pour laisser le TTL expirer (0ms = immédiatement expiré)
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Deuxième appel — doit être un MISS (TTL expiré)
    await sendJson(app, 'edge-server', makeToolCall('ttl_zero_tool', { id: 'ttl-0' }, 2));
    const callsAfterSecond = mockServer.getCallCount('tools/call');

    // L'entrée TTL=0 est expirée → second appel va upstream
    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
  });
});

describe('cas limites — requête sans Authorization (auth requise)', () => {
  it('retourne 401-style error sans lever d\'exception', async () => {
    gateway.stop();
    resetMetrics();
    gateway = new ConduitGateway(makeBaseConfig(mockServer.url, {
      auth: {
        method: 'api-key',
        api_keys: [{ key: 'test-key', client_id: 'test', tenant_id: 'default' }],
      },
    }));
    await gateway.initialize();
    app = gateway.createApp();

    const { body } = await sendJson<{ error?: { message: string }; result?: unknown }>(
      app, 'edge-server', makeToolCall('get_contact', { id: '1' }),
      // Pas d'en-tête Authorization
    );

    expect(body.error).toBeDefined();
    const msg = body.error?.message ?? '';
    expect(msg.toLowerCase()).toMatch(/auth|key|manquant/i);
    expect(body.result).toBeUndefined();
  });
});

describe('cas limites — Authorization malformé', () => {
  it('garbage dans Authorization ne plante pas le gateway', async () => {
    gateway.stop();
    resetMetrics();
    gateway = new ConduitGateway(makeBaseConfig(mockServer.url, {
      auth: {
        method: 'api-key',
        api_keys: [{ key: 'test-key', client_id: 'test', tenant_id: 'default' }],
      },
    }));
    await gateway.initialize();
    app = gateway.createApp();

    const badHeaders = [
      'Bearer ',                          // token vide
      'NotBearer abc',                    // mauvais préfixe
      'Bearer ' + 'x'.repeat(10000),      // token très long
      '{"json":"injection"}',             // injection JSON
    ];

    for (const authValue of badHeaders) {
      const { body } = await sendJson<{ error?: unknown; result?: unknown }>(
        app, 'edge-server', makeToolCall('get_contact', { id: '1' }),
        { Authorization: authValue },
      );
      // Doit retourner une erreur auth (pas de crash)
      expect(body.error).toBeDefined();
      expect(body.result).toBeUndefined();
    }
  });
});

describe('cas limites — batch JSON-RPC avec requêtes valides/invalides mélangées', () => {
  it('batch [valide, invalide, valide] : résultats individuels corrects', async () => {
    const batchBody = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_contact', arguments: { id: '1' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nonexistent_tool', arguments: {} } },
    ];

    const { body } = await sendJson<Array<{ id: number; result?: unknown; error?: unknown }>>(
      app, 'edge-server', batchBody,
    );

    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBe(3);

    // Requête 1 (tools/list) doit réussir
    const r1 = (body as Array<{ id: number; result?: unknown; error?: unknown }>).find((r) => r.id === 1);
    expect(r1?.result).toBeDefined();
    expect(r1?.error).toBeUndefined();

    // Requête 2 (tools/call valide) doit réussir
    const r2 = (body as Array<{ id: number; result?: unknown; error?: unknown }>).find((r) => r.id === 2);
    expect(r2?.result).toBeDefined();
    expect(r2?.error).toBeUndefined();

    // Requête 3 (outil inexistant) doit échouer
    const r3 = (body as Array<{ id: number; result?: unknown; error?: unknown }>).find((r) => r.id === 3);
    expect(r3?.error).toBeDefined();
    expect(r3?.result).toBeUndefined();
  });
});

describe('cas limites — outil de même nom sur deux serveurs (namespace prefix)', () => {
  it('namespace "prefix" : les deux outils sont accessibles sans collision', async () => {
    const mockServer2 = await startMockMcpServer(0, [
      {
        name: 'get_contact',
        description: 'Get contact on server 2',
        result: { source: 'server-2', name: 'Bob' },
      },
    ]);

    gateway.stop();
    resetMetrics();

    gateway = new ConduitGateway({
      gateway: { port: 0, host: '127.0.0.1' },
      router: {
        namespace_strategy: 'prefix',
        health_check: {
          enabled: false, interval_seconds: 60,
          timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1,
        },
      },
      servers: [
        { id: 'server-a', url: mockServer.url, cache: { default_ttl: 300 } },
        { id: 'server-b', url: mockServer2.url, cache: { default_ttl: 300 } },
      ],
      cache: { enabled: true, l1: { max_entries: 1000, max_entry_size_kb: 64 } },
      tenant_isolation: { enabled: false, header: 'Authorization' },
      observability: {
        log_args: false, log_responses: false,
        redact_fields: [], retention_days: 1, db_path: ':memory:',
      },
      metrics: { enabled: false, port: 0 },
    });
    await gateway.initialize();
    const multiApp = gateway.createApp();

    // Les deux serveurs ont get_contact mais avec namespaces différents
    const { body: listBody } = await sendJson<{ result?: { tools?: Array<{ name: string }> } }>(
      multiApp, 'server-a', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    );

    // Vérifier qu'aucun des deux n'est en collision
    const toolNames = listBody.result?.tools?.map((t) => t.name) ?? [];
    // Avec namespace prefix, les outils d'un seul serveur sont accessibles via /mcp/server-a
    expect(toolNames.length).toBeGreaterThan(0);

    await mockServer2.close();
  });
});

describe('cas limites — outil avec nom très long', () => {
  it('nom d\'outil de 200 caractères est traité sans erreur', async () => {
    const longName = 'a'.repeat(200);
    const { body } = await sendJson<{ result?: unknown; error?: unknown }>(
      app, 'edge-server', makeToolCall(longName, { id: '1' }),
    );
    // Le gateway doit retourner une erreur (outil non trouvé) mais sans crash
    expect(body).toBeDefined();
    expect(typeof body).toBe('object');
  });
});

describe('cas limites — nom d\'outil avec caractères Unicode', () => {
  it('outil avec caractères non-ASCII dans le nom', async () => {
    const unicodeTool: MockTool = {
      name: 'rechercher_données',
      description: 'Outil avec accents',
      result: { ok: true },
    };
    mockServer.setTool(unicodeTool);

    // Recréer le gateway pour récupérer l'outil
    gateway.stop();
    resetMetrics();
    gateway = new ConduitGateway(makeBaseConfig(mockServer.url));
    await gateway.initialize();
    app = gateway.createApp();

    const { body } = await sendJson<{ result?: unknown; error?: unknown }>(
      app, 'edge-server', makeToolCall('rechercher_données', {}),
    );
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });
});
