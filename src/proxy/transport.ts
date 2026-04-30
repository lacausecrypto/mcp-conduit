/**
 * Couche de transport Streamable HTTP pour le protocole MCP.
 *
 * Gère les endpoints HTTP de la passerelle :
 * - POST /mcp/:serverId  — requête JSON-RPC vers un serveur spécifique
 * - POST /mcp            — requête vers le premier serveur configuré
 * - GET  /mcp/:serverId  — flux SSE de notifications serveur
 *
 * Caractéristiques :
 * - Passthrough transparent des en-têtes Mcp-Session-Id
 * - Support des réponses JSON et SSE
 * - Injection des en-têtes de trace X-Conduit-Trace-Id
 * - Rapportage du statut de cache via X-Conduit-Cache-Status
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import type { ConduitGatewayConfig } from '../config/types.js';
import type { GatewayCore } from '../gateway/gateway.js';
import { buildProfileTargetId } from '../connect/profile-target.js';
import { resolveConnectProfile } from '../connect/export.js';
import {
  parseJsonRpcBatchPartial,
  isInvalidBatchEntry,
  isValidJsonRpc,
  buildJsonRpcError,
  buildJsonRpcResult,
  JSON_RPC_ERRORS,
  MAX_BATCH_SIZE,
  type JsonRpcMessage,
  type InvalidBatchEntry,
} from './json-rpc.js';
import { resolveTraceId, TRACE_HEADER } from '../observability/trace.js';

/** En-têtes de débogage injectés dans les réponses */
const CACHE_STATUS_HEADER = 'X-Conduit-Cache-Status';
const SERVER_ID_HEADER = 'X-Conduit-Server-Id';

/** Taille maximale du corps de requête pour éviter les attaques OOM (10 Mo) */
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

function isNotificationMessage(message: JsonRpcMessage): boolean {
  return message.method !== undefined
    && message.id === undefined
    && message.result === undefined
    && message.error === undefined;
}

/**
 * Crée l'application Hono de transport pour la passerelle.
 */
export function createTransport(config: ConduitGatewayConfig, core: GatewayCore): Hono {
  const app = new Hono();

  /**
   * POST /mcp/:serverId — requête MCP vers un serveur identifié.
   */
  app.post('/mcp/:serverId', async (c) => {
    const serverId = c.req.param('serverId');

    const server = config.servers.find((s) => s.id === serverId);
    if (!server) {
      return c.json(
        buildJsonRpcError(null, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Serveur inconnu : ${serverId}`),
        404,
      );
    }

    return handleMcpRequest(c, serverId, config, core);
  });

  /**
   * POST /mcp/profile/:profileId — endpoint profil agrégé sous contrôle Conduit.
   */
  app.post('/mcp/profile/:profileId', async (c) => {
    const profileId = c.req.param('profileId');

    try {
      resolveConnectProfile(config, profileId);
    } catch {
      return c.json(
        buildJsonRpcError(null, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Profil inconnu : ${profileId}`),
        404,
      );
    }

    return handleMcpRequest(c, buildProfileTargetId(profileId), config, core);
  });

  /**
   * POST /mcp — requête vers le premier serveur configuré.
   */
  app.post('/mcp', async (c) => {
    const firstServer = config.servers[0];
    if (!firstServer) {
      return c.json(
        buildJsonRpcError(null, JSON_RPC_ERRORS.INTERNAL_ERROR, 'Aucun serveur configuré'),
        503,
      );
    }
    return handleMcpRequest(c, firstServer.id, config, core);
  });

  /**
   * GET /mcp/:serverId — flux SSE de notifications serveur.
   */
  app.get('/mcp/:serverId', async (c) => {
    const serverId = c.req.param('serverId');

    const server = config.servers.find((s) => s.id === serverId);
    if (!server) {
      return c.json({ error: `Serveur inconnu : ${serverId}` }, 404);
    }

    const traceId = resolveTraceId(Object.fromEntries(c.req.raw.headers.entries()));
    const client = core.getClient(serverId);

    if (!client) {
      return c.json({ error: `Client non disponible pour : ${serverId}` }, 503);
    }

    try {
      const extraHeaders: Record<string, string> = { [TRACE_HEADER]: traceId };
      // Same forwarding policy as the JSON-RPC path: only propagate the
      // client's Authorization header when this server explicitly opts in.
      if (server.forward_authorization === true && !server.upstream_auth) {
        const authHeader = c.req.header('authorization');
        if (authHeader) extraHeaders['Authorization'] = authHeader;
      }

      const upstreamResponse = await client.openSseStream(extraHeaders);

      if (!upstreamResponse.ok) {
        return c.json({ error: 'Erreur lors de l\'ouverture du flux SSE' }, 502);
      }

      // Passthrough du flux SSE en amont
      c.header(TRACE_HEADER, traceId);
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');

      return stream(c, async (str) => {
        if (!upstreamResponse.body) {
          return;
        }
        const reader = upstreamResponse.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await str.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }, async (_err, str) => {
        // Nettoyage en cas d'erreur de streaming
        await str.close();
      });
    } catch (error) {
      console.error(`[Conduit] Erreur SSE pour ${serverId} :`, error);
      return c.json({ error: 'Erreur interne du flux SSE' }, 500);
    }
  });

  app.get('/mcp/profile/:profileId', async (c) => {
    const profileId = c.req.param('profileId');
    try {
      resolveConnectProfile(config, profileId);
    } catch {
      return c.json({ error: `Profil inconnu : ${profileId}` }, 404);
    }

    return c.json({
      error: 'Profile endpoints use streamable HTTP over POST. Use POST /mcp/profile/:profileId.',
    }, 405);
  });

  return app;
}

/**
 * Gère une requête MCP entrante pour un serveur donné.
 * Analyse le corps JSON-RPC, délègue au core de la passerelle, et construit la réponse.
 */
async function handleMcpRequest(
  c: Context,
  serverId: string,
  _config: ConduitGatewayConfig,
  core: GatewayCore,
): Promise<Response> {
  // Extraction du trace ID (depuis le client ou généré)
  const headersObj: Record<string, string> = {};
  c.req.raw.headers.forEach((value: string, key: string) => {
    headersObj[key] = value;
  });
  const traceId = resolveTraceId(headersObj);

  // Enforce body size limit:
  // 1. Fast-path: reject immediately if Content-Length header is over the limit.
  // 2. Slow-path: cap actual bytes read (handles chunked / missing Content-Length).
  const contentLength = c.req.raw.headers.get('content-length');
  if (contentLength !== null && parseInt(contentLength, 10) > MAX_REQUEST_BODY_BYTES) {
    const errResp = buildJsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Request body too large');
    c.header(TRACE_HEADER, traceId);
    return c.json(errResp, 413);
  }

  let rawBody: unknown;
  try {
    const rawRequest = c.req.raw;
    let bodyText: string;

    if (rawRequest.body) {
      const reader = rawRequest.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        // Vérifier AVANT de stocker le chunk pour éviter de consommer
        // plus de mémoire que la limite autorisée.
        if (totalBytes > MAX_REQUEST_BODY_BYTES) {
          reader.cancel().catch(() => undefined);
          chunks.length = 0; // Libérer les chunks déjà stockés
          const errResp = buildJsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Request body too large');
          c.header(TRACE_HEADER, traceId);
          return c.json(errResp, 413);
        }
        chunks.push(value);
      }

      bodyText = new TextDecoder().decode(
        chunks.reduce((acc, chunk) => {
          const merged = new Uint8Array(acc.length + chunk.length);
          merged.set(acc);
          merged.set(chunk, acc.length);
          return merged;
        }, new Uint8Array(0)),
      );
    } else {
      bodyText = '{}';
    }

    rawBody = JSON.parse(bodyText) as unknown;
  } catch {
    const errResp = buildJsonRpcError(null, JSON_RPC_ERRORS.PARSE_ERROR, 'JSON parse error');
    c.header(TRACE_HEADER, traceId);
    return c.json(errResp, 400);
  }

  // Two parsing modes:
  //  - Batch (array body): use the permissive parser so a single malformed
  //    entry produces a per-message Invalid Request error, conformément à
  //    la spec JSON-RPC 2.0. Reject upfront if the batch exceeds the cap.
  //  - Single message: keep the strict envelope check.
  let parsed: JsonRpcMessage | Array<JsonRpcMessage | InvalidBatchEntry>;
  if (Array.isArray(rawBody)) {
    if (rawBody.length === 0 || rawBody.length > MAX_BATCH_SIZE) {
      const errResp = buildJsonRpcError(
        null,
        JSON_RPC_ERRORS.INVALID_REQUEST,
        rawBody.length === 0
          ? 'Empty JSON-RPC batch'
          : `JSON-RPC batch exceeds maximum size (${MAX_BATCH_SIZE})`,
      );
      c.header(TRACE_HEADER, traceId);
      return c.json(errResp, 400);
    }
    const partial = parseJsonRpcBatchPartial(rawBody);
    if (partial === null) {
      const errResp = buildJsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Message JSON-RPC invalide');
      c.header(TRACE_HEADER, traceId);
      return c.json(errResp, 400);
    }
    parsed = partial;
  } else if (isValidJsonRpc(rawBody)) {
    parsed = rawBody;
  } else {
    const errResp = buildJsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Message JSON-RPC invalide');
    c.header(TRACE_HEADER, traceId);
    return c.json(errResp, 400);
  }

  // Construction du contexte de requête depuis les en-têtes
  const requestContext = buildRequestContext(headersObj, traceId);

  try {
    // Traitement batch — chaque message est traité indépendamment.
    // Les entrées invalides reçoivent immédiatement une erreur
    // Invalid Request sans atteindre le pipeline.
    if (Array.isArray(parsed)) {
      const settled = await Promise.allSettled(
        parsed.map(async (msg): Promise<JsonRpcMessage> => {
          if (isInvalidBatchEntry(msg)) {
            return buildJsonRpcError(
              msg.id,
              JSON_RPC_ERRORS.INVALID_REQUEST,
              'Invalid JSON-RPC message in batch entry',
            );
          }
          const r = await core.handleRequest(serverId, msg, requestContext);
          return r.body as JsonRpcMessage;
        }),
      );

      const batchResults = settled.map((outcome, idx) => {
        if (outcome.status === 'fulfilled') {
          return outcome.value;
        }
        const failedMsg = parsed[idx]!;
        const failedId = isInvalidBatchEntry(failedMsg)
          ? failedMsg.id
          : (failedMsg.id ?? null);
        const errorMessage = outcome.reason instanceof Error
          ? outcome.reason.message
          : 'Erreur interne';
        return buildJsonRpcError(
          failedId,
          JSON_RPC_ERRORS.INTERNAL_ERROR,
          errorMessage,
        );
      });

      c.header(TRACE_HEADER, traceId);
      c.header(SERVER_ID_HEADER, serverId);
      return c.json(batchResults);
    }

    const result = await core.handleRequest(serverId, parsed, requestContext);

    // Injection des en-têtes de réponse
    c.header(TRACE_HEADER, traceId);
    c.header(SERVER_ID_HEADER, serverId);

    if (result.cacheStatus) {
      c.header(CACHE_STATUS_HEADER, result.cacheStatus);
    }

    if (result.upstreamSessionId) {
      c.header('Mcp-Session-Id', result.upstreamSessionId);
    }

    if (result.retryAfter !== undefined) {
      c.header('Retry-After', String(result.retryAfter));
    }

    // Passthrough SSE
    if (result.isStream && result.rawResponse) {
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');

      return stream(c, async (str) => {
        if (!result.rawResponse?.body) {
          return;
        }
        const reader = result.rawResponse.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await str.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }, async (_err, str) => {
        await str.close();
      });
    }

    if (result.body === null && isNotificationMessage(parsed)) {
      return c.body(null, 202);
    }

    return c.json(result.body);
  } catch (error) {
    console.error(`[Conduit] Erreur de traitement pour ${serverId} :`, error);
    const errorMessage = error instanceof Error ? error.message : 'Erreur interne';
    const msgId = Array.isArray(parsed) ? null : (parsed.id ?? null);
    const errResp = buildJsonRpcError(msgId, JSON_RPC_ERRORS.INTERNAL_ERROR, errorMessage);

    c.header(TRACE_HEADER, traceId);
    return c.json(errResp, 500);
  }
}

/** Contexte de requête extrait des en-têtes HTTP */
export interface RequestContext {
  traceId: string;
  authHeader?: string;
  groupHeader?: string;
  sessionId?: string;
  rawHeaders: Record<string, string>;
}

/**
 * Construit le contexte de requête depuis les en-têtes HTTP.
 */
function buildRequestContext(
  headers: Record<string, string>,
  traceId: string,
): RequestContext {
  const context: RequestContext = {
    traceId,
    rawHeaders: headers,
  };

  const auth = headers['authorization'];
  const group = headers['x-conduit-group'];
  const session = headers['mcp-session-id'];

  if (auth !== undefined) context.authHeader = auth;
  if (group !== undefined) context.groupHeader = group;
  if (session !== undefined) context.sessionId = session;

  return context;
}

/** Résultat de traitement d'une requête par le core */
export interface CoreResult {
  body: unknown;
  cacheStatus?: string;
  upstreamSessionId?: string;
  isStream?: boolean;
  rawResponse?: Response;
  /** Secondes à indiquer dans l'en-tête Retry-After (rate limiting) */
  retryAfter?: number;
}

/** Résultat d'un buildJsonRpcResult utilisé dans les réponses */
export { buildJsonRpcResult };
