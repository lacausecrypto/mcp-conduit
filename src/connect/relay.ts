import { createInterface } from 'node:readline';
import {
  JSON_RPC_ERRORS,
  buildJsonRpcError,
  parseJsonRpc,
  type JsonRpcMessage,
} from '../proxy/json-rpc.js';
import { loadLocalInstallation, readInstallationSecret, type ConnectLocalInstallation } from './local.js';

export async function runConnectRelay(
  installId: string,
  serverId: string,
  io: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    error?: NodeJS.WritableStream;
  } = {},
): Promise<void> {
  const installation = loadLocalInstallation(installId);
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const error = io.error ?? process.stderr;
  const rl = createInterface({ input, terminal: false });

  rl.on('line', async (line: string) => {
    const response = await processRelayLine(line, installation, serverId, error);
    if (response) {
      output.write(JSON.stringify(response) + '\n');
    }
  });

  await new Promise<void>((resolve) => rl.once('close', () => resolve()));
}

export async function processRelayLine(
  line: string,
  installation: ConnectLocalInstallation,
  serverId: string,
  errorStream?: NodeJS.WritableStream,
): Promise<JsonRpcMessage | JsonRpcMessage[] | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return buildJsonRpcError(null, JSON_RPC_ERRORS.PARSE_ERROR, 'Invalid JSON');
  }

  const parsed = parseJsonRpc(raw);
  if (!parsed) {
    return buildJsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC message');
  }

  try {
    if (Array.isArray(parsed)) {
      const results = await Promise.all(parsed.map((message) => forwardRelayMessage(message, installation, serverId)));
      return results.filter((message) => message !== null);
    }

    return await forwardRelayMessage(parsed, installation, serverId);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    errorStream?.write(`[Conduit relay] ${message}\n`);
    const id = !Array.isArray(parsed) && (typeof parsed.id === 'string' || typeof parsed.id === 'number' || parsed.id === null)
      ? parsed.id
      : null;
    return buildJsonRpcError(id, JSON_RPC_ERRORS.INTERNAL_ERROR, message);
  }
}

export async function forwardRelayMessage(
  message: JsonRpcMessage,
  installation: ConnectLocalInstallation,
  serverId: string,
): Promise<JsonRpcMessage | null> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (installation.auth.type === 'bearer') {
    const secret = readInstallationSecret(installation);
    if (!secret) {
      throw new Error(`Missing stored token for installation "${installation.id}"`);
    }
    headers[installation.auth.header_name] = `${installation.auth.prefix}${secret}`;
  }

  const res = await fetch(`${installation.base_url}/mcp/${encodeURIComponent(serverId)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });

  const text = await res.text();
  if (!text.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Non-JSON response from Conduit upstream (${res.status})`);
  }

  const jsonRpc = parseJsonRpc(parsed);
  if (!jsonRpc || Array.isArray(jsonRpc)) {
    throw new Error(`Invalid JSON-RPC response from Conduit upstream (${res.status})`);
  }

  if ((message.id === undefined || message.id === null) && 'method' in message && !('result' in message) && !('error' in message)) {
    return null;
  }

  return jsonRpc;
}
