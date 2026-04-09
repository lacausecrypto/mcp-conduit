/**
 * Client MCP via transport stdio (processus enfant).
 * Communique avec un serveur MCP via stdin/stdout en JSON-RPC.
 *
 * Le processus est spawné paresseusement au premier appel et
 * redémarré automatiquement si le processus meurt.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { ServerConfig } from '../config/types.js';
import type { CircuitBreaker } from '../router/circuit-breaker.js';
import type { IMcpClient } from './mcp-client-interface.js';
import type { UpstreamResponse, UpstreamRequestOptions } from './mcp-client.js';

/** Délai d'expiration par défaut pour les requêtes stdio (30 secondes) */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Délai de grâce avant SIGKILL après SIGTERM (5 secondes) */
const KILL_GRACE_MS = 5_000;

/**
 * Requête en attente de réponse sur stdout.
 */
interface PendingRequest {
  resolve: (response: UpstreamResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class StdioMcpClient implements IMcpClient {
  private readonly server: ServerConfig;
  private process: ChildProcess | null = null;
  private sessionId: string | undefined;
  private _activeConnections = 0;
  private _circuitBreaker: CircuitBreaker | undefined;

  /** Requêtes en attente, indexées par ID JSON-RPC */
  private readonly pending = new Map<string | number, PendingRequest>();

  /** Buffer pour les données partielles sur stdout */
  private stdoutBuffer = '';

  /** Le processus a-t-il été intentionnellement arrêté ? */
  private stopped = false;

  /** Compteur auto-incrémenté pour les IDs JSON-RPC quand le message n'en a pas */
  private nextId = 1;

  constructor(server: ServerConfig) {
    this.server = server;
  }

  // ─── IMcpClient interface ────────────────────────────────────────────

  setCircuitBreaker(cb: CircuitBreaker): void {
    this._circuitBreaker = cb;
  }

  getCircuitBreaker(): CircuitBreaker | undefined {
    return this._circuitBreaker;
  }

  async forward(options: UpstreamRequestOptions): Promise<UpstreamResponse> {
    if (this._circuitBreaker && !this._circuitBreaker.canExecute()) {
      throw new Error(
        `Circuit breaker open for stdio server "${this.server.id}" — request rejected`,
      );
    }

    this._activeConnections++;
    try {
      const result = await this._doForward(options);
      this._circuitBreaker?.onSuccess();
      return result;
    } catch (error) {
      this._circuitBreaker?.onFailure();
      throw error;
    } finally {
      this._activeConnections--;
    }
  }

  async openSseStream(): Promise<Response> {
    throw new Error(
      `SSE streams are not supported for stdio transport (server "${this.server.id}")`,
    );
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  get activeConnections(): number {
    return this._activeConnections;
  }

  get serverId(): string {
    return this.server.id;
  }

  get serverUrl(): string {
    return this.server.url;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /** Arrête proprement le processus enfant. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.killProcess();
  }

  /** Vérifie si le processus est vivant. */
  isAlive(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private async _doForward(options: UpstreamRequestOptions): Promise<UpstreamResponse> {
    const proc = this.ensureProcess();
    const message = options.body as Record<string, unknown>;

    // S'assurer qu'il y a un ID pour corréler la réponse
    const rawId = message['id'];
    const id: string | number = (typeof rawId === 'string' || typeof rawId === 'number')
      ? rawId
      : this.nextId++;
    const outgoing = { ...message, id };

    const timeoutMs = options.timeoutMs ?? this.server.timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise<UpstreamResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `Stdio request timeout after ${timeoutMs}ms for server "${this.server.id}"`,
        ));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      // Écrire le message JSON-RPC sur stdin, terminé par un saut de ligne
      const data = JSON.stringify(outgoing) + '\n';
      if (!proc.stdin?.write(data)) {
        // Backpressure — attendre le drain
        proc.stdin?.once('drain', () => { /* written */ });
      }
    });
  }

  /**
   * S'assure que le processus enfant est lancé.
   * Le spawne paresseusement si nécessaire.
   */
  private ensureProcess(): ChildProcess {
    if (this.process && this.process.exitCode === null) {
      return this.process;
    }

    if (this.stopped) {
      throw new Error(`Stdio client for "${this.server.id}" has been shut down`);
    }

    const command = this.server.command;
    const args = this.server.args ?? [];
    const env = this.server.env
      ? { ...process.env, ...this.server.env }
      : process.env;

    if (!command) {
      throw new Error(
        `No command configured for stdio server "${this.server.id}"`,
      );
    }

    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.process = proc;
    this.stdoutBuffer = '';

    // Lecture ligne par ligne sur stdout
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString();
      this.processBuffer();
    });

    // Log stderr pour le debug
    proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) {
        console.warn(`[Conduit] stdio stderr (${this.server.id}):`, msg);
      }
    });

    // Gestion de la mort du processus
    proc.on('exit', (code, signal) => {
      console.warn(
        `[Conduit] stdio process exited for "${this.server.id}" (code=${code}, signal=${signal})`,
      );
      this.process = null;

      // Rejeter toutes les requêtes en attente
      for (const [id, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error(
          `Stdio process "${this.server.id}" exited unexpectedly (code=${code})`,
        ));
        this.pending.delete(id);
      }
    });

    proc.on('error', (err) => {
      console.error(`[Conduit] stdio process error for "${this.server.id}":`, err.message);
      this.process = null;
    });

    return proc;
  }

  /**
   * Parse les réponses JSON-RPC complètes depuis le buffer stdout.
   * Chaque réponse est sur une ligne séparée.
   */
  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);

      if (!line) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        console.warn(`[Conduit] Non-JSON output from stdio "${this.server.id}":`, line.slice(0, 200));
        continue;
      }

      const id = parsed['id'];
      if (id === undefined || id === null) {
        // Notification (pas de corrélation) — ignorer
        continue;
      }

      const pending = this.pending.get(id as string | number);
      if (!pending) {
        // Réponse orpheline — la requête a peut-être déjà timeout
        continue;
      }

      clearTimeout(pending.timer);
      this.pending.delete(id as string | number);

      // Capturer le session ID si présent
      if (typeof parsed['sessionId'] === 'string') {
        this.sessionId = parsed['sessionId'];
      }

      const headers: Record<string, string> = {};

      if (parsed['error'] !== undefined) {
        // Réponse d'erreur JSON-RPC — la retourner quand même comme body
        pending.resolve({
          body: parsed,
          status: 200,
          headers,
          isStream: false,
        });
      } else {
        pending.resolve({
          body: parsed,
          status: 200,
          headers,
          isStream: false,
        });
      }
    }
  }

  /**
   * Tue le processus enfant proprement (SIGTERM → grace → SIGKILL).
   */
  private async killProcess(): Promise<void> {
    const proc = this.process;
    if (!proc || proc.exitCode !== null) return;

    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, KILL_GRACE_MS);

      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    });
  }
}
