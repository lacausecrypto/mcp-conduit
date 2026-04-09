import { describe, it, expect } from 'vitest';
import {
  isValidJsonRpc,
  isJsonRpcRequest,
  parseJsonRpc,
  buildJsonRpcResult,
  buildJsonRpcError,
  processBatch,
  extractToolName,
  extractToolArgs,
  JSON_RPC_ERRORS,
  type JsonRpcMessage,
} from '../../src/proxy/json-rpc.js';

describe('isValidJsonRpc', () => {
  it('valide un message de requête JSON-RPC valide', () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    expect(isValidJsonRpc(msg)).toBe(true);
  });

  it('valide un message de réponse avec result', () => {
    const msg = { jsonrpc: '2.0', id: 1, result: { tools: [] } };
    expect(isValidJsonRpc(msg)).toBe(true);
  });

  it('valide un message de réponse avec error', () => {
    const msg = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Not found' } };
    expect(isValidJsonRpc(msg)).toBe(true);
  });

  it('valide une notification (sans id)', () => {
    const msg = { jsonrpc: '2.0', method: 'notifications/initialized' };
    expect(isValidJsonRpc(msg)).toBe(true);
  });

  it('rejette un objet sans jsonrpc', () => {
    expect(isValidJsonRpc({ id: 1, method: 'test' })).toBe(false);
  });

  it('rejette jsonrpc avec mauvaise version', () => {
    expect(isValidJsonRpc({ jsonrpc: '1.0', id: 1, method: 'test' })).toBe(false);
  });

  it('rejette null', () => {
    expect(isValidJsonRpc(null)).toBe(false);
  });

  it('rejette une chaîne', () => {
    expect(isValidJsonRpc('not an object')).toBe(false);
  });

  it('rejette un objet sans method/result/error', () => {
    expect(isValidJsonRpc({ jsonrpc: '2.0', id: 1 })).toBe(false);
  });
});

describe('isJsonRpcRequest', () => {
  it('retourne true pour un message avec method', () => {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'tools/call' };
    expect(isJsonRpcRequest(msg)).toBe(true);
  });

  it('retourne false pour un message sans method', () => {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, result: {} };
    expect(isJsonRpcRequest(msg)).toBe(false);
  });
});

describe('parseJsonRpc', () => {
  it('parse un message JSON-RPC valide', () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    expect(parseJsonRpc(body)).toEqual(body);
  });

  it('parse un batch de messages', () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'test', arguments: {} } },
    ];
    const result = parseJsonRpc(batch);
    expect(Array.isArray(result)).toBe(true);
    expect((result as JsonRpcMessage[]).length).toBe(2);
  });

  it('retourne null pour un message invalide', () => {
    expect(parseJsonRpc({ invalid: true })).toBeNull();
  });

  it('retourne null pour null', () => {
    expect(parseJsonRpc(null)).toBeNull();
  });

  it('retourne null pour un tableau vide', () => {
    expect(parseJsonRpc([])).toBeNull();
  });

  it('retourne null si un élément du batch est invalide', () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { invalid: true },
    ];
    expect(parseJsonRpc(batch)).toBeNull();
  });
});

describe('buildJsonRpcResult', () => {
  it('construit une réponse de succès valide', () => {
    const result = buildJsonRpcResult(1, { tools: [] });
    expect(result.jsonrpc).toBe('2.0');
    expect(result.id).toBe(1);
    expect(result.result).toEqual({ tools: [] });
    expect(result.error).toBeUndefined();
  });

  it('utilise null si id est undefined', () => {
    const result = buildJsonRpcResult(undefined, { ok: true });
    expect(result.id).toBeNull();
  });

  it('preserve l\'id null', () => {
    const result = buildJsonRpcResult(null, {});
    expect(result.id).toBeNull();
  });

  it('preserve l\'id string', () => {
    const result = buildJsonRpcResult('req-123', {});
    expect(result.id).toBe('req-123');
  });
});

describe('buildJsonRpcError', () => {
  it('construit une réponse d\'erreur valide', () => {
    const err = buildJsonRpcError(1, JSON_RPC_ERRORS.METHOD_NOT_FOUND, 'Not found');
    expect(err.jsonrpc).toBe('2.0');
    expect(err.id).toBe(1);
    expect(err.error?.code).toBe(-32601);
    expect(err.error?.message).toBe('Not found');
  });

  it('inclut les données supplémentaires si fournies', () => {
    const err = buildJsonRpcError(1, JSON_RPC_ERRORS.INVALID_PARAMS, 'Invalid', { field: 'name' });
    expect(err.error?.data).toEqual({ field: 'name' });
  });

  it('n\'inclut pas data si non fourni', () => {
    const err = buildJsonRpcError(1, JSON_RPC_ERRORS.INTERNAL_ERROR, 'Error');
    expect(err.error?.data).toBeUndefined();
  });
});

describe('processBatch', () => {
  it('traite tous les messages du batch', async () => {
    const messages: JsonRpcMessage[] = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ];

    const results = await processBatch(messages, async (msg) => ({
      ...msg,
      result: { processed: true },
    }));

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect((r.result as { processed: boolean }).processed).toBe(true);
    }
  });

  it('traite un batch vide sans erreur', async () => {
    const results = await processBatch([], async (msg) => msg);
    expect(results).toHaveLength(0);
  });
});

describe('extractToolName', () => {
  it('extrait le nom de l\'outil depuis les params', () => {
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_contact', arguments: {} },
    };
    expect(extractToolName(msg)).toBe('get_contact');
  });

  it('retourne undefined si pas de params', () => {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'tools/call' };
    expect(extractToolName(msg)).toBeUndefined();
  });

  it('retourne undefined si name n\'est pas une string', () => {
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 42 as unknown as string },
    };
    expect(extractToolName(msg)).toBeUndefined();
  });
});

describe('extractToolArgs', () => {
  it('extrait les arguments de l\'outil', () => {
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_contact', arguments: { id: '123', name: 'Alice' } },
    };
    expect(extractToolArgs(msg)).toEqual({ id: '123', name: 'Alice' });
  });

  it('retourne un objet vide si pas de params', () => {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'tools/call' };
    expect(extractToolArgs(msg)).toEqual({});
  });

  it('retourne un objet vide si arguments manquants', () => {
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'test' },
    };
    expect(extractToolArgs(msg)).toEqual({});
  });
});

describe('JSON_RPC_ERRORS', () => {
  it('expose les codes d\'erreur standard', () => {
    expect(JSON_RPC_ERRORS.PARSE_ERROR).toBe(-32700);
    expect(JSON_RPC_ERRORS.INVALID_REQUEST).toBe(-32600);
    expect(JSON_RPC_ERRORS.METHOD_NOT_FOUND).toBe(-32601);
    expect(JSON_RPC_ERRORS.INVALID_PARAMS).toBe(-32602);
    expect(JSON_RPC_ERRORS.INTERNAL_ERROR).toBe(-32603);
  });
});
