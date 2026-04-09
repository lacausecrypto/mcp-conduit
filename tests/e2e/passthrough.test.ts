/**
 * Tests e2e — Phase 0 : proxy transparent.
 *
 * Vérifie que la passerelle transmet fidèlement les requêtes MCP
 * vers les backends en amont, sans altération du contenu.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setup,
  teardown,
  sendMcpRequest,
  sendMcpRequestJson,
  makeToolCallMessage,
  makeToolsListMessage,
  makeInitializeMessage,
  type E2eTestContext,
} from './setup.js';

describe('Phase 0 — proxy transparent', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ namespaceStrategy: 'none', cacheEnabled: false });
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  beforeEach(() => {
    ctx.mockServer.resetCallCounts();
  });

  describe('initialize', () => {
    it('transmet la requête initialize au backend et retourne la réponse', async () => {
      const res = await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body['jsonrpc']).toBe('2.0');
      expect(body['id']).toBe(1);

      const result = body['result'] as Record<string, unknown>;
      expect(result['protocolVersion']).toBe('2024-11-05');
      expect(result['serverInfo']).toMatchObject({ name: 'mock-mcp-server' });

      expect(ctx.mockServer.getCallCount('initialize')).toBe(1);
    });

    it('transmet les IDs de message JSON-RPC tels quels', async () => {
      const msgWithStringId = { ...makeInitializeMessage(), id: 'my-trace-id' };
      const body = await sendMcpRequestJson<Record<string, unknown>>(
        ctx.app, 'test-server', msgWithStringId,
      );
      expect(body['id']).toBe('my-trace-id');
    });
  });

  describe('tools/list', () => {
    it('retourne la liste des outils du backend', async () => {
      const body = await sendMcpRequestJson<Record<string, unknown>>(
        ctx.app, 'test-server', makeToolsListMessage(),
      );

      expect(body['jsonrpc']).toBe('2.0');
      const result = body['result'] as { tools: unknown[] };
      expect(Array.isArray(result['tools'])).toBe(true);
      expect(result['tools'].length).toBeGreaterThan(0);

      // Vérifie que get_contact est présent
      const toolNames = (result['tools'] as Array<{ name: string }>).map((t) => t.name);
      expect(toolNames).toContain('get_contact');
      expect(toolNames).toContain('search_leads');
    });

    it('retourne les annotations des outils', async () => {
      const body = await sendMcpRequestJson<Record<string, unknown>>(
        ctx.app, 'test-server', makeToolsListMessage(),
      );
      const result = body['result'] as { tools: Array<{ name: string; annotations: unknown }> };
      const getContact = result['tools'].find((t) => t.name === 'get_contact');
      expect(getContact?.annotations).toMatchObject({ readOnlyHint: true });
    });
  });

  describe('tools/call', () => {
    it('transmet un tools/call au backend et retourne le résultat', async () => {
      const body = await sendMcpRequestJson<Record<string, unknown>>(
        ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '123' }),
      );

      expect(body['jsonrpc']).toBe('2.0');
      expect(body['error']).toBeUndefined();

      const result = body['result'] as Record<string, unknown>;
      expect(result['id']).toBe('123');
      expect(result['name']).toBe('Alice Martin');

      // Vérifie que le backend a bien reçu l'appel
      expect(ctx.mockServer.getCallCount('tools/call')).toBe(1);
    });

    it('transmet les arguments de l\'outil en amont', async () => {
      await sendMcpRequestJson(
        ctx.app, 'test-server', makeToolCallMessage('search_leads', { query: 'bob', limit: 10 }),
      );

      const calls = ctx.mockServer.getCalls('tools/call');
      const call = calls[0] as { name: string; arguments: Record<string, unknown> };
      expect(call?.['name']).toBe('search_leads');
      expect(call?.['arguments']).toMatchObject({ query: 'bob', limit: 10 });
    });

    it('retourne une erreur JSON-RPC si l\'outil n\'existe pas', async () => {
      const body = await sendMcpRequestJson<Record<string, unknown>>(
        ctx.app, 'test-server', makeToolCallMessage('nonexistent_tool'),
      );
      expect(body['error']).toBeDefined();
    });
  });

  describe('gestion des erreurs', () => {
    it('retourne une erreur JSON-RPC pour un corps non-JSON', async () => {
      const res = await ctx.app.request('/mcp/test-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'ceci-nest-pas-du-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      const error = body['error'] as { code: number };
      expect(error['code']).toBe(-32700); // PARSE_ERROR
    });

    it('retourne une erreur 404 pour un serveur inconnu', async () => {
      const res = await sendMcpRequest(
        ctx.app, 'unknown-server', makeInitializeMessage(),
      );
      expect(res.status).toBe(404);
    });

    it('retourne une erreur JSON-RPC pour un message JSON-RPC invalide', async () => {
      const res = await ctx.app.request('/mcp/test-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notJsonRpc: true }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      const error = body['error'] as { code: number };
      expect(error['code']).toBe(-32600); // INVALID_REQUEST
    });

    it('retourne 413 si le Content-Length dépasse la limite (10 Mo)', async () => {
      const res = await ctx.app.request('/mcp/test-server', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Simule un Content-Length plus grand que la limite
          'Content-Length': String(11 * 1024 * 1024),
        },
        body: JSON.stringify(makeInitializeMessage()),
      });
      expect(res.status).toBe(413);
      const body = await res.json() as Record<string, unknown>;
      const error = body['error'] as { code: number };
      expect(error['code']).toBe(-32600); // INVALID_REQUEST
    });
  });

  describe('en-têtes HTTP', () => {
    it('retourne un en-tête X-Conduit-Trace-Id dans la réponse', async () => {
      const res = await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
      expect(res.headers.get('x-conduit-trace-id')).toBeTruthy();
    });

    it('propage le trace ID fourni par le client', async () => {
      const myTraceId = 'mon-trace-id-custom-12345678';
      const res = await sendMcpRequest(
        ctx.app, 'test-server', makeInitializeMessage(),
        { 'x-conduit-trace-id': myTraceId },
      );
      expect(res.headers.get('x-conduit-trace-id')).toBe(myTraceId);
    });

    it('retourne l\'identifiant du serveur dans X-Conduit-Server-Id', async () => {
      const res = await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
      expect(res.headers.get('x-conduit-server-id')).toBe('test-server');
    });
  });

  describe('requêtes batch JSON-RPC', () => {
    it('traite un batch de requêtes et retourne un tableau de réponses', async () => {
      const batch = [
        makeInitializeMessage(1),
        makeToolsListMessage(2),
      ];

      const res = await sendMcpRequest(ctx.app, 'test-server', batch);
      expect(res.status).toBe(200);

      const body = await res.json() as unknown[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
    });
  });
});
