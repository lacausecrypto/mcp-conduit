/**
 * Tests e2e — Phase 1 : observabilité.
 *
 * Vérifie que la passerelle journalise correctement les requêtes,
 * propage les traces, masque les champs sensibles, et expose les métriques.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setup,
  teardown,
  sendMcpRequest,
  makeToolCallMessage,
  makeToolsListMessage,
  makeInitializeMessage,
  type E2eTestContext,
} from './setup.js';

describe('Phase 1 — observabilité', () => {
  let ctx: E2eTestContext;

  beforeAll(async () => {
    ctx = await setup({ namespaceStrategy: 'none', cacheEnabled: false });
  });

  afterAll(async () => {
    await teardown(ctx);
  });

  describe('journalisation (log-store)', () => {
    beforeEach(() => {
      // Vide les logs entre chaque test
      ctx.gateway.getLogStore()['db'].exec('DELETE FROM logs');
    });

    it('crée une entrée de log après un tools/call', async () => {
      await sendMcpRequest(
        ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '42' }),
      );

      const logs = ctx.gateway.getLogStore().getAll();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.method).toBe('tools/call');
      expect(logs[0]?.tool_name).toBe('get_contact');
      expect(logs[0]?.status).toBe('success');
      expect(logs[0]?.server_id).toBe('test-server');
    });

    it('crée une entrée de log après un tools/list', async () => {
      await sendMcpRequest(ctx.app, 'test-server', makeToolsListMessage());

      const logs = ctx.gateway.getLogStore().getAll();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.method).toBe('tools/list');
    });

    it('crée une entrée de log après un initialize', async () => {
      await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());

      const logs = ctx.gateway.getLogStore().getAll();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.method).toBe('initialize');
    });

    it('journalise les arguments de l\'outil', async () => {
      await sendMcpRequest(
        ctx.app, 'test-server', makeToolCallMessage('search_leads', { query: 'test', limit: 5 }),
      );

      const logs = ctx.gateway.getLogStore().getAll();
      expect(logs[0]?.args).toMatchObject({ query: 'test', limit: 5 });
    });

    it('enregistre la durée de la requête (duration_ms >= 0)', async () => {
      await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());

      const logs = ctx.gateway.getLogStore().getAll();
      expect(logs[0]?.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('enregistre le trace ID dans chaque entrée de log', async () => {
      const traceId = 'test-trace-id-observabilite';
      await sendMcpRequest(
        ctx.app, 'test-server', makeInitializeMessage(),
        { 'x-conduit-trace-id': traceId },
      );

      const logs = ctx.gateway.getLogStore().getAll();
      expect(logs[0]?.trace_id).toBe(traceId);
    });

    it('permet de retrouver les logs par trace ID', async () => {
      const traceId = 'trace-observable-unique';
      await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage(), { 'x-conduit-trace-id': traceId });
      await sendMcpRequest(ctx.app, 'test-server', makeToolsListMessage(), { 'x-conduit-trace-id': traceId });
      await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());

      const byTrace = ctx.gateway.getLogStore().getByTraceId(traceId);
      expect(byTrace).toHaveLength(2);
      for (const entry of byTrace) {
        expect(entry.trace_id).toBe(traceId);
      }
    });

    it('les statistiques reflètent les requêtes reçues', async () => {
      await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
      await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '1' }));

      const stats = ctx.gateway.getLogStore().getStats();
      expect(stats.total_requests).toBe(2);
      expect(stats.error_rate).toBe(0);
      expect(stats.avg_latency_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('masquage des champs sensibles (redaction)', () => {
    beforeEach(() => {
      ctx.gateway.getLogStore()['db'].exec('DELETE FROM logs');
    });

    it('masque le champ "password" dans les arguments journalisés', async () => {
      await sendMcpRequest(
        ctx.app,
        'test-server',
        makeToolCallMessage('create_contact', { name: 'Alice', password: 'super-secret' }),
      );

      const logs = ctx.gateway.getLogStore().getAll();
      const args = logs[0]?.args as Record<string, unknown> | undefined;
      expect(args?.['password']).toBe('[REDACTED]');
      expect(args?.['name']).toBe('Alice');
    });

    it('masque les champs contenant "token" par correspondance partielle', async () => {
      await sendMcpRequest(
        ctx.app,
        'test-server',
        makeToolCallMessage('get_contact', { id: '1', api_token: 'tok-xyz123' }),
      );

      const logs = ctx.gateway.getLogStore().getAll();
      const args = logs[0]?.args as Record<string, unknown> | undefined;
      expect(args?.['api_token']).toBe('[REDACTED]');
    });
  });

  describe('propagation du trace ID', () => {
    it('génère un trace ID UUID si aucun n\'est fourni', async () => {
      const res = await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
      const traceId = res.headers.get('x-conduit-trace-id');

      expect(traceId).toBeTruthy();
      // UUID v4 format : xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(traceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('chaque requête sans trace ID reçoit un ID unique', async () => {
      const [res1, res2] = await Promise.all([
        sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage()),
        sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage()),
      ]);

      const id1 = res1.headers.get('x-conduit-trace-id');
      const id2 = res2.headers.get('x-conduit-trace-id');
      expect(id1).not.toBe(id2);
    });

    it('preserve le trace ID fourni par le client même avec des majuscules', async () => {
      const customId = 'MY-CUSTOM-TRACE-123';
      const res = await sendMcpRequest(
        ctx.app, 'test-server', makeInitializeMessage(),
        { 'X-Conduit-Trace-Id': customId },
      );
      expect(res.headers.get('x-conduit-trace-id')).toBe(customId);
    });
  });

  describe('endpoint d\'administration /conduit/logs', () => {
    beforeEach(() => {
      ctx.gateway.getLogStore()['db'].exec('DELETE FROM logs');
    });

    it('retourne les logs depuis /conduit/logs', async () => {
      await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
      await sendMcpRequest(ctx.app, 'test-server', makeToolsListMessage());

      const res = await ctx.app.request('/conduit/logs');
      expect(res.status).toBe(200);

      const body = await res.json() as { logs: unknown[]; count: number };
      expect(body.count).toBe(2);
      expect(body.logs).toHaveLength(2);
    });

    it('supporte le filtre par outil via ?tool=', async () => {
      await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());
      await sendMcpRequest(ctx.app, 'test-server', makeToolsListMessage());
      await sendMcpRequest(ctx.app, 'test-server', makeToolCallMessage('get_contact', { id: '1' }));

      const res = await ctx.app.request('/conduit/logs?tool=get_contact');
      const body = await res.json() as { logs: Array<{ tool_name: string }>; count: number };
      expect(body.count).toBe(1);
      for (const log of body.logs) {
        expect(log.tool_name).toBe('get_contact');
      }
    });

    it('retourne les stats depuis /conduit/stats', async () => {
      await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage());

      const res = await ctx.app.request('/conduit/stats');
      expect(res.status).toBe(200);

      const body = await res.json() as { requests: { total_requests: number } };
      expect(body.requests.total_requests).toBeGreaterThanOrEqual(1);
    });

    it('retourne les logs par trace depuis /conduit/logs/trace/:traceId', async () => {
      const traceId = 'trace-admin-test-abc';
      await sendMcpRequest(ctx.app, 'test-server', makeInitializeMessage(), { 'x-conduit-trace-id': traceId });

      const res = await ctx.app.request(`/conduit/logs/trace/${traceId}`);
      expect(res.status).toBe(200);

      const body = await res.json() as { logs: Array<{ trace_id: string }>; count: number };
      expect(body.count).toBe(1);
      expect(body.logs[0]?.trace_id).toBe(traceId);
    });
  });

  describe('endpoint de santé /conduit/health', () => {
    it('retourne le statut de santé de la passerelle', async () => {
      const res = await ctx.app.request('/conduit/health');
      expect(res.status).toBe(200);

      const body = await res.json() as { status: string };
      expect(body.status).toBe('ok');
    });
  });

  describe('endpoint de version /conduit/version', () => {
    it('retourne la version de la passerelle', async () => {
      const res = await ctx.app.request('/conduit/version');
      expect(res.status).toBe(200);

      const body = await res.json() as { version: string; node_version: string };
      expect(body.version).toBeTruthy();
      expect(body.node_version).toBeTruthy();
    });
  });

  describe('endpoint des serveurs /conduit/servers', () => {
    it('retourne la liste des serveurs enregistrés', async () => {
      const res = await ctx.app.request('/conduit/servers');
      expect(res.status).toBe(200);

      const body = await res.json() as { servers: Array<{ id: string }> };
      expect(body.servers).toHaveLength(1);
      expect(body.servers[0]?.id).toBe('test-server');
    });
  });
});
