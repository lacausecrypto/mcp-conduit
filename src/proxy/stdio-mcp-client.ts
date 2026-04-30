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
import { buildManagedRuntimeLaunchSpec } from '../runtime/managed.js';
import type { IMcpClient } from './mcp-client-interface.js';
import type { UpstreamResponse, UpstreamRequestOptions } from './mcp-client.js';

/** Délai d'expiration par défaut pour les requêtes stdio (30 secondes) */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Délai de grâce avant SIGKILL après SIGTERM (5 secondes) */
const KILL_GRACE_MS = 5_000;

/**
 * Si le processus enfant exit avant ce délai, on considère que le spawn lui-même
 * a échoué (ENOENT, dépendance manquante, crash immédiat sur stdin) et on
 * incrémente le compteur de respawns rapides.
 */
const FAST_FAILURE_THRESHOLD_MS = 2_000;

/**
 * Délai de backoff initial après un crash rapide. Doublé à chaque échec
 * consécutif jusqu'à `MAX_RESPAWN_BACKOFF_MS`.
 */
const RESPAWN_BACKOFF_BASE_MS = 250;
const MAX_RESPAWN_BACKOFF_MS = 30_000;

/**
 * Au-delà de ce nombre d'échecs rapides consécutifs, on refuse définitivement
 * de re-spawner jusqu'à ce qu'un health-check / force-reset soit appelé (via
 * l'API admin du circuit-breaker associé).
 */
const MAX_CONSECUTIVE_FAST_FAILURES = 10;

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

  /** Horodatage du dernier spawn — utilisé pour détecter les crashs rapides */
  private lastSpawnAt = 0;

  /** Nombre d'échecs rapides consécutifs (exit < FAST_FAILURE_THRESHOLD_MS après spawn) */
  private consecutiveFastFailures = 0;

  /** Date à partir de laquelle un re-spawn est à nouveau autorisé (cooldown) */
  private nextRespawnAllowedAt = 0;

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

  /**
   * Arrête proprement le processus enfant.
   *
   * Audit 3.1#9 — rejette immédiatement toutes les requêtes en attente avec
   * une erreur claire pour qu'aucune requête in-flight ne reste suspendue
   * pendant que le processus est tué (sinon les callers attendent l'expiration
   * de leur propre timeout, ou pire l'event `exit` qui peut être rebondi par
   * le grace SIGKILL).
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.rejectAllPending(
      new Error(`Stdio client for "${this.server.id}" has been shut down`),
    );
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
    const isNotification = isMcpNotification(message);

    if (isNotification) {
      await writeStdioMessage(proc, JSON.stringify(message) + '\n');
      return {
        body: null,
        status: 202,
        headers: {},
        isStream: false,
      };
    }

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
      writeStdioMessage(proc, data).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /**
   * S'assure que le processus enfant est lancé.
   * Le spawne paresseusement si nécessaire.
   *
   * Audit 3.1#8 — si le binaire crashe immédiatement à chaque spawn, on
   * applique un backoff exponentiel pour éviter le fork-bomb. Au-delà de
   * `MAX_CONSECUTIVE_FAST_FAILURES`, on refuse complètement le respawn
   * jusqu'à ce qu'une intervention manuelle ait lieu (circuit breaker reset).
   */
  private ensureProcess(): ChildProcess {
    if (this.process && this.process.exitCode === null) {
      return this.process;
    }

    if (this.stopped) {
      throw new Error(`Stdio client for "${this.server.id}" has been shut down`);
    }

    // Respawn budget — block fork-bomb on broken commands.
    const now = Date.now();
    if (this.consecutiveFastFailures >= MAX_CONSECUTIVE_FAST_FAILURES) {
      throw new Error(
        `Stdio process "${this.server.id}" failed to start ${this.consecutiveFastFailures} times in a row — refusing to respawn. Reset the circuit breaker once the underlying issue is fixed.`,
      );
    }
    if (now < this.nextRespawnAllowedAt) {
      const waitMs = this.nextRespawnAllowedAt - now;
      throw new Error(
        `Stdio process "${this.server.id}" is in respawn cooldown (${waitMs}ms remaining after ${this.consecutiveFastFailures} fast failure${this.consecutiveFastFailures === 1 ? '' : 's'})`,
      );
    }

    const managedLaunch = buildManagedRuntimeLaunchSpec(this.server);
    const command = managedLaunch?.command ?? this.server.command;
    const args = managedLaunch?.args ?? this.server.args ?? [];
    const env = managedLaunch?.env ?? (this.server.env
      ? { ...process.env, ...this.server.env }
      : process.env);

    if (!command) {
      throw new Error(
        `No command configured for stdio server "${this.server.id}"`,
      );
    }

    // On Windows, commands like 'npx' are actually 'npx.cmd' batch files.
    // spawn() can't resolve them without shell:true on Windows.
    const isWindows = process.platform === 'win32';

    // Reject shell metacharacters when we hand the command to cmd.exe — a
    // malicious config value like "npx & rm -rf %USERPROFILE%" would otherwise
    // be chained by the shell. Args are passed by spawn() as a single
    // quoted string on Windows, so they are guarded the same way.
    if (isWindows) {
      assertNoShellMetacharacters(command, `stdio server "${this.server.id}" command`);
      for (const arg of args) {
        assertNoShellMetacharacters(arg, `stdio server "${this.server.id}" argument`);
      }
    }

    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      ...(managedLaunch?.cwd ? { cwd: managedLaunch.cwd } : {}),
      shell: isWindows,
      // Prevent shell window flash on Windows
      ...(isWindows ? { windowsHide: true } : {}),
    });

    this.process = proc;
    this.stdoutBuffer = '';
    this.lastSpawnAt = Date.now();

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
      // Audit 3.1#8 — un kill par signal externe (SIGTERM/SIGKILL/etc.) ne
      // compte pas comme un crash rapide : c'est l'opérateur ou le système
      // qui a tué le process intentionnellement, pas un binaire défaillant.
      const wasExternalSignal = signal !== null;
      this.recordExit({ wasExternalSignal });

      // Rejeter toutes les requêtes en attente
      this.rejectAllPending(new Error(
        `Stdio process "${this.server.id}" exited unexpectedly (code=${code}, signal=${signal})`,
      ));
    });

    // Audit 3.1#9 — un `error` event peut être émis sans `exit` (ENOENT, EACCES,
    // permissions, binary missing). On rejette les pending *et* on enregistre
    // l'échec pour le backoff (cf. Audit 3.1#8). Un `error` event ne vient
    // jamais d'un signal externe : c'est toujours un échec de spawn, donc on
    // le compte dans le budget.
    proc.on('error', (err) => {
      console.error(`[Conduit] stdio process error for "${this.server.id}":`, err.message);
      this.process = null;
      this.recordExit({ wasExternalSignal: false });
      this.rejectAllPending(new Error(
        `Stdio process "${this.server.id}" failed: ${err.message}`,
      ));
    });

    return proc;
  }

  /**
   * Audit 3.1#8 — détecte les crashs rapides et applique un backoff exponentiel.
   * Réinitialise le compteur dès qu'un processus a vécu plus longtemps que
   * `FAST_FAILURE_THRESHOLD_MS`.
   *
   * @param opts.wasExternalSignal — true si le process a été tué par un signal
   *   externe (SIGTERM/SIGKILL/...). Dans ce cas on ne compte PAS comme une
   *   fast failure pour ne pas bloquer un opérateur qui kill manuellement.
   */
  private recordExit(opts: { wasExternalSignal: boolean }): void {
    if (opts.wasExternalSignal) {
      // Reset on intentional kill — operator-driven, not crash loop.
      this.consecutiveFastFailures = 0;
      this.nextRespawnAllowedAt = 0;
      return;
    }
    const livedMs = Date.now() - this.lastSpawnAt;
    if (livedMs < FAST_FAILURE_THRESHOLD_MS) {
      this.consecutiveFastFailures++;
      const backoff = Math.min(
        RESPAWN_BACKOFF_BASE_MS * 2 ** (this.consecutiveFastFailures - 1),
        MAX_RESPAWN_BACKOFF_MS,
      );
      this.nextRespawnAllowedAt = Date.now() + backoff;
    } else {
      // Le process a tourné suffisamment longtemps — succès, on remet à zéro.
      this.consecutiveFastFailures = 0;
      this.nextRespawnAllowedAt = 0;
    }
  }

  /**
   * Audit 3.1#9 — rejette toutes les requêtes en attente avec l'erreur fournie
   * et nettoie leurs timers. Idempotent (sûr à appeler plusieurs fois).
   */
  private rejectAllPending(error: Error): void {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      try {
        req.reject(error);
      } catch { /* swallow handler errors */ }
      this.pending.delete(id);
    }
  }

  /**
   * Réinitialise le compteur de respawns rapides — appelé typiquement par
   * l'API admin lors d'un reset du circuit-breaker, ou par le health-check
   * une fois que l'opérateur a corrigé la commande.
   */
  resetRespawnBudget(): void {
    this.consecutiveFastFailures = 0;
    this.nextRespawnAllowedAt = 0;
  }

  /**
   * Lecture diagnostique pour les tests / monitoring.
   */
  getRespawnState(): { consecutiveFastFailures: number; nextRespawnAllowedAt: number } {
    return {
      consecutiveFastFailures: this.consecutiveFastFailures,
      nextRespawnAllowedAt: this.nextRespawnAllowedAt,
    };
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
   * Kills the child process gracefully.
   * On Unix: SIGTERM → grace period → SIGKILL
   * On Windows: proc.kill() sends TerminateProcess (immediate)
   */
  private async killProcess(): Promise<void> {
    const proc = this.process;
    if (!proc || proc.exitCode !== null) return;

    const isWindows = process.platform === 'win32';

    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          if (isWindows) {
            proc.kill(); // TerminateProcess on Windows
          } else {
            proc.kill('SIGKILL');
          }
        } catch { /* already dead */ }
        resolve();
      }, KILL_GRACE_MS);

      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        if (isWindows) {
          proc.kill(); // No graceful signal on Windows, just terminate
        } else {
          proc.kill('SIGTERM');
        }
      } catch { /* already dead */ }
    });
  }
}

/**
 * cmd.exe and powershell interpret these characters as control tokens. When
 * spawn() runs through a shell on Windows, an unchecked config value can
 * inject commands (e.g. "node; calc.exe" -> calc is spawned alongside node).
 * Arguments passed through spawn() on Windows with shell:true are also
 * concatenated into that command line, so we validate them with the same list.
 */
const WINDOWS_SHELL_METACHARACTERS = /[&|;<>`$\r\n\0"'^%(){}\[\]]/;

function assertNoShellMetacharacters(value: string, label: string): void {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  if (WINDOWS_SHELL_METACHARACTERS.test(value)) {
    throw new Error(
      `${label} contains shell metacharacters and was rejected under Windows shell execution`,
    );
  }
}

function isJsonRpcNotification(body: Record<string, unknown>): boolean {
  return body['jsonrpc'] === '2.0'
    && typeof body['method'] === 'string'
    && body['id'] === undefined
    && body['result'] === undefined
    && body['error'] === undefined;
}

function isMcpNotification(body: Record<string, unknown>): boolean {
  if (!isJsonRpcNotification(body)) {
    return false;
  }

  const method = body['method'];
  return typeof method === 'string' && method.startsWith('notifications/');
}

function writeStdioMessage(proc: ChildProcess, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!proc.stdin) {
      reject(new Error('Stdio child process has no stdin'));
      return;
    }

    const onError = (error: Error) => {
      proc.stdin?.off('error', onError);
      reject(error);
    };

    proc.stdin.once('error', onError);

    const cleanupAndResolve = () => {
      proc.stdin?.off('error', onError);
      resolve();
    };

    if (!proc.stdin.write(data)) {
      proc.stdin.once('drain', cleanupAndResolve);
      return;
    }

    cleanupAndResolve();
  });
}
