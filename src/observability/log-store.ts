/**
 * Stockage persistant des logs dans SQLite via better-sqlite3.
 *
 * Caractéristiques :
 * - Opérations synchrones (better-sqlite3 est synchrone par conception)
 * - Schéma avec index sur les colonnes de filtrage fréquent
 * - Purge automatique des entrées plus anciennes que retention_days
 * - Requêtes avec filtres et pagination
 */

import { existsSync, unlinkSync } from 'node:fs';
import Database from 'better-sqlite3';
import { hardenSqliteFilePermissions } from '../utils/db-hardening.js';
import type { LogEntry, LogFilters, LogStats, CacheLogStatus } from './types.js';

/** Schéma de création de la table de logs */
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  client_id TEXT,
  server_id TEXT,
  method TEXT NOT NULL,
  tool_name TEXT,
  args TEXT,
  duration_ms REAL,
  status TEXT NOT NULL,
  response_size INTEGER,
  error_code INTEGER,
  error_message TEXT,
  cache_status TEXT,
  guardrail_rule TEXT,
  guardrail_action TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_server_id ON logs(server_id);
CREATE INDEX IF NOT EXISTS idx_logs_tool_name ON logs(tool_name);
CREATE INDEX IF NOT EXISTS idx_logs_client_id ON logs(client_id);
CREATE INDEX IF NOT EXISTS idx_logs_trace_id ON logs(trace_id);
`;

/** Ligne brute de la base de données */
interface RawLogRow {
  id: number;
  timestamp: string;
  trace_id: string;
  client_id: string | null;
  server_id: string | null;
  method: string;
  tool_name: string | null;
  args: string | null;
  duration_ms: number | null;
  status: string;
  response_size: number | null;
  error_code: number | null;
  error_message: string | null;
  cache_status: string | null;
  guardrail_rule: string | null;
  guardrail_action: string | null;
}

export class LogStore {
  private readonly db: Database.Database;
  private readonly retentionDays: number;
  /** Déclaration préparée pour l'insertion (mise en cache pour les performances) */
  private readonly insertStmt: Database.Statement;

  constructor(dbPath: string, retentionDays = 30) {
    this.retentionDays = retentionDays;
    this.db = LogStore.openDatabase(dbPath);

    // Préparation de la déclaration d'insertion (réutilisée pour toutes les insertions)
    this.insertStmt = this.db.prepare(`
      INSERT INTO logs (
        timestamp, trace_id, client_id, server_id, method,
        tool_name, args, duration_ms, status, response_size,
        error_code, error_message, cache_status,
        guardrail_rule, guardrail_action
      ) VALUES (
        @timestamp, @trace_id, @client_id, @server_id, @method,
        @tool_name, @args, @duration_ms, @status, @response_size,
        @error_code, @error_message, @cache_status,
        @guardrail_rule, @guardrail_action
      )
    `);

    // Purge initiale au démarrage
    this.purgeOldEntries();
  }

  /**
   * Ouvre la base de données SQLite avec récupération automatique.
   * Si le fichier est corrompu, il est supprimé et une base propre est recréée.
   */
  private static openDatabase(dbPath: string): Database.Database {
    try {
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.exec(CREATE_TABLE_SQL);
      hardenSqliteFilePermissions(dbPath);
      return db;
    } catch (err) {
      console.warn(
        `[Conduit] Base de données de logs corrompue ou inaccessible (${dbPath}), recréation...`,
        err instanceof Error ? err.message : err,
      );

      // Supprimer le fichier corrompu et ses fichiers WAL/SHM associés
      for (const suffix of ['', '-wal', '-shm']) {
        const file = `${dbPath}${suffix}`;
        if (existsSync(file)) {
          try { unlinkSync(file); } catch { /* ignore */ }
        }
      }

      // Recréer une base propre
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.exec(CREATE_TABLE_SQL);
      hardenSqliteFilePermissions(dbPath);
      return db;
    }
  }

  /**
   * Insère une entrée de log dans la base de données.
   */
  insert(entry: LogEntry): void {
    this.insertStmt.run({
      timestamp: entry.timestamp,
      trace_id: entry.trace_id,
      client_id: entry.client_id ?? null,
      server_id: entry.server_id ?? null,
      method: entry.method,
      tool_name: entry.tool_name ?? null,
      args: entry.args !== undefined ? JSON.stringify(entry.args) : null,
      duration_ms: entry.duration_ms,
      status: entry.status,
      response_size: entry.response_size,
      error_code: entry.error_code ?? null,
      error_message: entry.error_message ?? null,
      cache_status: entry.cache_status ?? null,
      guardrail_rule: entry.guardrail_rule ?? null,
      guardrail_action: entry.guardrail_action ?? null,
    });
  }

  /**
   * Récupère des entrées de log avec filtres et pagination.
   */
  getAll(filters: LogFilters = {}): LogEntry[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.server) {
      conditions.push('server_id = @server');
      params['server'] = filters.server;
    }

    if (filters.tool) {
      conditions.push('tool_name = @tool');
      params['tool'] = filters.tool;
    }

    if (filters.status) {
      conditions.push('status = @status');
      params['status'] = filters.status;
    }

    if (filters.from) {
      conditions.push('timestamp >= @from');
      params['from'] = filters.from;
    }

    if (filters.to) {
      conditions.push('timestamp <= @to');
      params['to'] = filters.to;
    }

    if (filters.trace_id) {
      conditions.push('trace_id = @trace_id');
      params['trace_id'] = filters.trace_id;
    }

    if (filters.client_id) {
      conditions.push('client_id = @client_id');
      params['client_id'] = filters.client_id;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    params['limit'] = limit;
    params['offset'] = offset;

    const stmt = this.db.prepare(`
      SELECT * FROM logs
      ${where}
      ORDER BY timestamp DESC
      LIMIT @limit OFFSET @offset
    `);

    const rows = stmt.all(params) as RawLogRow[];
    return rows.map(rowToLogEntry);
  }

  /**
   * Récupère tous les logs associés à un trace ID donné.
   */
  getByTraceId(traceId: string): LogEntry[] {
    const stmt = this.db.prepare(
      'SELECT * FROM logs WHERE trace_id = ? ORDER BY timestamp ASC',
    );
    const rows = stmt.all(traceId) as RawLogRow[];
    return rows.map(rowToLogEntry);
  }

  /**
   * Calcule des statistiques agrégées sur les logs.
   * Prend en compte uniquement les entrées des dernières 24 heures par défaut.
   */
  getStats(sinceHours = 24): LogStats {
    const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();

    const totalRow = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM logs WHERE timestamp >= ?',
    ).get(since) as { cnt: number };

    const total = totalRow.cnt;

    if (total === 0) {
      return {
        total_requests: 0,
        requests_per_minute: 0,
        avg_latency_ms: 0,
        p50_ms: 0,
        p95_ms: 0,
        p99_ms: 0,
        error_rate: 0,
        cache_hit_rate: 0,
      };
    }

    const avgRow = this.db.prepare(
      'SELECT AVG(duration_ms) as avg FROM logs WHERE timestamp >= ?',
    ).get(since) as { avg: number | null };

    const errorsRow = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM logs WHERE timestamp >= ? AND status = ?',
    ).get(since, 'error') as { cnt: number };

    const cacheHitsRow = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM logs WHERE timestamp >= ? AND cache_status = ?',
    ).get(since, 'HIT') as { cnt: number };

    // Calcul des percentiles via tri
    const durations = (this.db.prepare(
      'SELECT duration_ms FROM logs WHERE timestamp >= ? AND duration_ms IS NOT NULL ORDER BY duration_ms',
    ).all(since) as Array<{ duration_ms: number }>).map((r) => r.duration_ms);

    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    const p99 = percentile(durations, 99);

    return {
      total_requests: total,
      requests_per_minute: total / (sinceHours * 60),
      avg_latency_ms: avgRow.avg ?? 0,
      p50_ms: p50,
      p95_ms: p95,
      p99_ms: p99,
      error_rate: errorsRow.cnt / total,
      cache_hit_rate: cacheHitsRow.cnt / total,
    };
  }

  /**
   * Supprime les entrées plus anciennes que retention_days.
   */
  purgeOldEntries(): number {
    const cutoff = new Date(
      Date.now() - this.retentionDays * 24 * 3600 * 1000,
    ).toISOString();

    const result = this.db.prepare(
      'DELETE FROM logs WHERE timestamp < ?',
    ).run(cutoff);

    // VACUUM after large deletes to reclaim disk space
    if (result.changes > 100) {
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    }

    return result.changes;
  }

  /**
   * Démarre la purge périodique (toutes les heures).
   * Retourne un handle pour l'annulation.
   */
  startPeriodicPurge(intervalMs = 3600 * 1000): NodeJS.Timeout {
    return setInterval(() => {
      const deleted = this.purgeOldEntries();
      if (deleted > 0) {
        console.log(`[Conduit] Purge des logs : ${deleted} entrée(s) supprimée(s)`);
      }
    }, intervalMs);
  }

  /**
   * Vérifie que la base de données est accessible en écriture.
   * Effectue un INSERT puis un DELETE dans une table temporaire.
   * Retourne true si le test réussit, false sinon.
   */
  ping(): boolean {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS _conduit_ping (id INTEGER PRIMARY KEY, ts TEXT);
        INSERT INTO _conduit_ping (ts) VALUES (datetime('now'));
        DELETE FROM _conduit_ping WHERE id NOT IN (SELECT id FROM _conduit_ping LIMIT 1);
      `);
      return true;
    } catch {
      return false;
    }
  }

  /** Ferme proprement la connexion à la base de données. */
  close(): void {
    this.db.close();
  }
}

/** Convertit une ligne brute SQLite en LogEntry. */
function rowToLogEntry(row: RawLogRow): LogEntry {
  const entry: LogEntry = {
    timestamp: row.timestamp,
    trace_id: row.trace_id,
    client_id: row.client_id ?? '',
    server_id: row.server_id ?? '',
    method: row.method,
    duration_ms: row.duration_ms ?? 0,
    status: (row.status as LogEntry['status']) ?? 'error',
    response_size: row.response_size ?? 0,
  };

  if (row.tool_name !== null) entry.tool_name = row.tool_name;
  if (row.args !== null) {
    try {
      entry.args = JSON.parse(row.args) as Record<string, unknown>;
    } catch {
      // Ignore les erreurs de parsing JSON
    }
  }
  if (row.error_code !== null) entry.error_code = row.error_code;
  if (row.error_message !== null) entry.error_message = row.error_message;
  if (row.cache_status !== null) entry.cache_status = row.cache_status as CacheLogStatus;
  if (row.guardrail_rule !== null) entry.guardrail_rule = row.guardrail_rule;
  if (row.guardrail_action !== null) entry.guardrail_action = row.guardrail_action;

  return entry;
}

/** Calcule le percentile p (0-100) d'un tableau trié de nombres. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  const safeIndex = Math.max(0, Math.min(index, sorted.length - 1));
  return sorted[safeIndex] ?? 0;
}
