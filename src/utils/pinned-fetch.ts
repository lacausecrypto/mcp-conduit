/**
 * DNS-rebinding-resistant HTTP client.
 *
 * Background: `validateServerUrlWithDns` resolves a hostname and validates
 * every returned IP against the SSRF denylist. But the subsequent `fetch`
 * call resolves DNS *again* via undici, opening a TOCTOU window where a
 * hostile authoritative server can return a public IP at validation time
 * and a loopback / RFC1918 IP at fetch time (TTL=0 rebinding).
 *
 * `pinnedFetch` closes that window: the caller passes the IP that was
 * already validated, and the request is dispatched directly to that IP
 * via Node's `http`/`https` modules with a custom `lookup` that always
 * returns the same address. The original hostname is kept in the `Host`
 * header (HTTP) and as the SNI / certificate-validation `servername`
 * (HTTPS), so the upstream still sees a normal request.
 *
 * Returns a Web `Response` object so callers using `fetch` can swap in
 * minimal disruption.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

export interface PinnedFetchOptions {
  pinnedIp: string;
  family: 4 | 6;
  /** Initial fetch options. Body is currently not supported (descriptor fetcher only does GET). */
  init?: {
    method?: string;
    headers?: Record<string, string>;
    redirect?: 'follow' | 'manual' | 'error';
    signal?: AbortSignal;
  };
}

export async function pinnedFetch(
  url: string | URL,
  options: PinnedFetchOptions,
): Promise<Response> {
  const target = typeof url === 'string' ? new URL(url) : url;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`pinnedFetch only supports http(s); got "${target.protocol}"`);
  }

  const isHttps = target.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const port = target.port
    ? Number(target.port)
    : (isHttps ? 443 : 80);

  const headers: Record<string, string> = {
    Host: target.host,
    ...(options.init?.headers ?? {}),
  };

  return new Promise<Response>((resolve, reject) => {
    const req = requestFn({
      method: options.init?.method ?? 'GET',
      host: options.pinnedIp,
      port,
      path: target.pathname + target.search,
      headers,
      // Pin DNS to the pre-validated address. Even if Node retries
      // resolution internally, the lookup is stubbed.
      lookup: (_hostname, _opts, cb: (err: Error | null, address: string, family: number) => void) => {
        cb(null, options.pinnedIp, options.family);
      },
      // For HTTPS, set SNI + cert validation servername to the original
      // hostname so the TLS handshake matches the certificate.
      ...(isHttps ? { servername: target.hostname } : {}),
    }, (incoming: IncomingMessage) => {
      resolve(incomingMessageToResponse(incoming, target));
    });

    req.on('error', (err) => reject(err));

    if (options.init?.signal) {
      const onAbort = () => {
        req.destroy(new Error('AbortError'));
      };
      if (options.init.signal.aborted) {
        onAbort();
      } else {
        options.init.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    req.end();
  });
}

function incomingMessageToResponse(incoming: IncomingMessage, originalUrl: URL): Response {
  const status = incoming.statusCode ?? 0;
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, String(value));
    }
  }
  // Map a node IncomingMessage to a Web ReadableStream so `Response.body`
  // works (descriptor fetcher reads it via `getReader()`).
  const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;

  return new Response(body, {
    status,
    statusText: incoming.statusMessage ?? '',
    headers,
  });
}
