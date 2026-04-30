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
 * Hard cap on the number of messages in a single JSON-RPC batch.
 *
 * The transport already enforces a 10 MiB body limit, but with small
 * messages (~50 bytes) that translates to ~200k entries — each spawning a
 * promise through the full pipeline (auth, ACL, cache, plugins, upstream).
 * Battle-test showed 100k entries parse in ~2ms but multiplying that load
 * across the pipeline is the actual amplification vector. 100 is well above
 * any legitimate batch use and well below the amplification threshold.
 */
export const MAX_BATCH_SIZE = 100;

/**
 * Sentinel returned by parseJsonRpcStrict for batch entries that failed
 * structural validation. The transport layer turns these into per-message
 * Invalid Request errors so the caller can distinguish which entry broke,
 * conformément à la spec JSON-RPC 2.0.
 */
export interface InvalidBatchEntry {
  invalid: true;
  /** ID extracted from the raw entry if present, otherwise null. */
  id: string | number | null;
}

export function isInvalidBatchEntry(value: unknown): value is InvalidBatchEntry {
  return typeof value === 'object'
    && value !== null
    && (value as Record<string, unknown>)['invalid'] === true;
}

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
 * Retourne null si la valeur n'est pas un message JSON-RPC valide ou si
 * le batch dépasse MAX_BATCH_SIZE.
 *
 * Pour le batch : l'historique du gateway rejetait l'intégralité du batch
 * dès qu'une entrée était invalide. Le comportement strict (ancien) reste
 * disponible via cette fonction. Les appelants qui veulent une réponse
 * conforme JSON-RPC 2.0 (erreur par message invalide) doivent utiliser
 * parseJsonRpcBatchPartial ci-dessous.
 */
export function parseJsonRpc(
  body: unknown,
): JsonRpcMessage | JsonRpcMessage[] | null {
  // Traitement du batch (tableau de messages)
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MAX_BATCH_SIZE) {
      return null;
    }
    const messages: JsonRpcMessage[] = [];
    for (const item of body) {
      if (!isValidJsonRpc(item)) {
        return null;
      }
      messages.push(item);
    }
    return messages;
  }

  if (!isValidJsonRpc(body)) {
    return null;
  }

  return body;
}

/**
 * Permissive batch parser — returns one entry per input message: either a
 * validated `JsonRpcMessage` or an `InvalidBatchEntry` placeholder. Lets the
 * transport produce per-message Invalid Request errors instead of aborting
 * the whole batch.
 *
 * Returns null for a non-array body or for an oversize batch (the cap still
 * applies — without it the spec-compliant path would just amplify DoS).
 */
export function parseJsonRpcBatchPartial(
  body: unknown,
): Array<JsonRpcMessage | InvalidBatchEntry> | null {
  if (!Array.isArray(body)) return null;
  if (body.length === 0 || body.length > MAX_BATCH_SIZE) return null;

  return body.map((item): JsonRpcMessage | InvalidBatchEntry => {
    if (isValidJsonRpc(item)) return item;
    // Best-effort id extraction so the client can correlate the error.
    let id: string | number | null = null;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const raw = (item as Record<string, unknown>)['id'];
      if (typeof raw === 'string' || typeof raw === 'number') id = raw;
    }
    return { invalid: true, id };
  });
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
