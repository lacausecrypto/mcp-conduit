/**
 * Parsing, validation et construction de messages JSON-RPC 2.0.
 *
 * Codes d'erreur standard JSON-RPC :
 * -32700 : Parse error
 * -32600 : Invalid Request
 * -32601 : Method not found
 * -32602 : Invalid params
 * -32603 : Internal error
 */

/** Message JSON-RPC 2.0 générique */
export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcError;
}

/** Erreur JSON-RPC 2.0 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Requête JSON-RPC 2.0 (possède method) */
export interface JsonRpcRequest extends JsonRpcMessage {
  method: string;
}

/** Réponse JSON-RPC 2.0 (possède result ou error) */
export interface JsonRpcResponse extends JsonRpcMessage {
  id: string | number | null;
}

/** Codes d'erreur JSON-RPC standard */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Valide structurellement un message JSON-RPC 2.0.
 * Supporte les requêtes, notifications et réponses.
 */
export function isValidJsonRpc(value: unknown): value is JsonRpcMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (obj['jsonrpc'] !== '2.0') {
    return false;
  }

  const hasMethod = typeof obj['method'] === 'string';
  const hasResult = 'result' in obj;
  const hasError = 'error' in obj;

  return hasMethod || hasResult || hasError;
}

/**
 * Valide qu'un message JSON-RPC est une requête (possède method).
 */
export function isJsonRpcRequest(value: JsonRpcMessage): value is JsonRpcRequest {
  return typeof value.method === 'string';
}

/**
 * Parse et valide un corps de requête JSON-RPC ou un tableau batch.
 * Retourne null si la valeur n'est pas un message JSON-RPC valide.
 */
export function parseJsonRpc(
  body: unknown,
): JsonRpcMessage | JsonRpcMessage[] | null {
  // Traitement du batch (tableau de messages)
  if (Array.isArray(body)) {
    const messages: JsonRpcMessage[] = [];
    for (const item of body) {
      if (!isValidJsonRpc(item)) {
        return null;
      }
      messages.push(item);
    }
    return messages.length > 0 ? messages : null;
  }

  if (!isValidJsonRpc(body)) {
    return null;
  }

  return body;
}

/**
 * Construit une réponse JSON-RPC 2.0 valide.
 */
export function buildJsonRpcResult(
  id: string | number | null | undefined,
  result: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result,
  };
}

/**
 * Construit une réponse d'erreur JSON-RPC 2.0.
 */
export function buildJsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error,
  };
}

/**
 * Traite un batch de requêtes JSON-RPC.
 * Appelle le handler pour chaque message et agrège les résultats.
 */
export async function processBatch(
  messages: JsonRpcMessage[],
  handler: (msg: JsonRpcMessage) => Promise<JsonRpcMessage>,
): Promise<JsonRpcMessage[]> {
  return Promise.all(messages.map(handler));
}

/**
 * Extrait le nom de l'outil depuis les paramètres d'un appel tools/call.
 */
export function extractToolName(message: JsonRpcMessage): string | undefined {
  const params = message.params;
  if (!params) return undefined;
  const name = params['name'];
  return typeof name === 'string' ? name : undefined;
}

/**
 * Extrait les arguments depuis les paramètres d'un appel tools/call.
 */
export function extractToolArgs(message: JsonRpcMessage): Record<string, unknown> {
  const params = message.params;
  if (!params) return {};
  const args = params['arguments'];
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}
