import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { hardenSqliteFilePermissions } from '../utils/db-hardening.js';
import type {
  CreateGovernanceApprovalRequestInput,
  CreateGovernanceAuditEventInput,
  GovernanceApprovalGrantQuery,
  GovernanceApprovalRequestSummary,
  GovernanceAuditEvent,
  ListGovernanceApprovalFilters,
} from './types.js';

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  requester_client_id TEXT NOT NULL,
  approver_client_id TEXT,
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  rule_name TEXT,
  reason TEXT NOT NULL,
  trace_id TEXT,
  request_fingerprint TEXT NOT NULL,
  tool_args TEXT,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_workspace_status
  ON approval_requests(workspace_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_approval_requests_requester
  ON approval_requests(requester_client_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_approval_requests_fingerprint
  ON approval_requests(workspace_id, requester_client_id, server_id, tool_name, request_fingerprint, status, expires_at);

CREATE TABLE IF NOT EXISTS governance_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  workspace_id TEXT,
  actor_client_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  outcome TEXT NOT NULL,
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_governance_audit_timestamp
  ON governance_audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_governance_audit_workspace
  ON governance_audit_events(workspace_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_governance_audit_actor
  ON governance_audit_events(actor_client_id, timestamp);
`;

interface RawApprovalRow {
  id: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  status: GovernanceApprovalRequestSummary['status'];
  source: GovernanceApprovalRequestSummary['source'];
  workspace_id: string;
  requester_client_id: string;
  approver_client_id: string | null;
  server_id: string;
  tool_name: string;
  rule_name: string | null;
  reason: string;
  trace_id: string | null;
  request_fingerprint: string;
  tool_args: string | null;
  note: string | null;
}

interface RawAuditRow {
  id: number;
  timestamp: string;
  workspace_id: string | null;
  actor_client_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: GovernanceAuditEvent['outcome'];
  details: string | null;
}

export class GovernanceStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(CREATE_SCHEMA_SQL);
    hardenSqliteFilePermissions(dbPath);
  }

  ping(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  createOrReuseApprovalRequest(input: CreateGovernanceApprovalRequestInput): GovernanceApprovalRequestSummary {
    this.pruneExpiredApprovalRequests();

    const existing = this.db.prepare(`
      SELECT * FROM approval_requests
      WHERE workspace_id = @workspace_id
        AND requester_client_id = @requester_client_id
        AND server_id = @server_id
        AND tool_name = @tool_name
        AND request_fingerprint = @request_fingerprint
        AND status = 'pending'
        AND expires_at > @now
      ORDER BY created_at DESC
      LIMIT 1
    `).get({
      workspace_id: input.workspace_id,
      requester_client_id: input.requester_client_id,
      server_id: input.server_id,
      tool_name: input.tool_name,
      request_fingerprint: input.request_fingerprint,
      now: new Date().toISOString(),
    }) as RawApprovalRow | undefined;

    if (existing) {
      return rowToApproval(existing);
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO approval_requests (
        id, created_at, updated_at, expires_at, status, source,
        workspace_id, requester_client_id, approver_client_id,
        server_id, tool_name, rule_name, reason, trace_id,
        request_fingerprint, tool_args, note
      ) VALUES (
        @id, @created_at, @updated_at, @expires_at, 'pending', @source,
        @workspace_id, @requester_client_id, NULL,
        @server_id, @tool_name, @rule_name, @reason, @trace_id,
        @request_fingerprint, @tool_args, NULL
      )
    `).run({
      id,
      created_at: now,
      updated_at: now,
      expires_at: input.expires_at,
      source: input.source,
      workspace_id: input.workspace_id,
      requester_client_id: input.requester_client_id,
      server_id: input.server_id,
      tool_name: input.tool_name,
      rule_name: input.rule_name ?? null,
      reason: input.reason,
      trace_id: input.trace_id ?? null,
      request_fingerprint: input.request_fingerprint,
      tool_args: JSON.stringify(input.tool_args),
    });

    return this.getApprovalRequest(id)!;
  }

  getApprovalRequest(id: string): GovernanceApprovalRequestSummary | null {
    this.pruneExpiredApprovalRequests();
    const row = this.db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as RawApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  listApprovalRequests(filters: ListGovernanceApprovalFilters = {}): GovernanceApprovalRequestSummary[] {
    this.pruneExpiredApprovalRequests();
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.workspace_id) {
      conditions.push('workspace_id = @workspace_id');
      params['workspace_id'] = filters.workspace_id;
    }
    if (filters.status) {
      conditions.push('status = @status');
      params['status'] = filters.status;
    }
    if (filters.requester_client_id) {
      conditions.push('requester_client_id = @requester_client_id');
      params['requester_client_id'] = filters.requester_client_id;
    }
    if (filters.approver_client_id) {
      conditions.push('approver_client_id = @approver_client_id');
      params['approver_client_id'] = filters.approver_client_id;
    }
    if (filters.source) {
      conditions.push('source = @source');
      params['source'] = filters.source;
    }

    params['limit'] = filters.limit ?? 100;
    params['offset'] = filters.offset ?? 0;
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM approval_requests
      ${where}
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `).all(params) as RawApprovalRow[];
    return rows.map(rowToApproval);
  }

  approveRequest(id: string, approverClientId: string, note?: string): GovernanceApprovalRequestSummary | null {
    return this.decideRequest(id, 'approved', approverClientId, note);
  }

  rejectRequest(id: string, approverClientId: string, note?: string): GovernanceApprovalRequestSummary | null {
    return this.decideRequest(id, 'rejected', approverClientId, note);
  }

  private decideRequest(
    id: string,
    status: 'approved' | 'rejected',
    approverClientId: string,
    note?: string,
  ): GovernanceApprovalRequestSummary | null {
    this.pruneExpiredApprovalRequests();
    const existing = this.getApprovalRequest(id);
    if (!existing || existing.status !== 'pending') {
      return null;
    }

    this.db.prepare(`
      UPDATE approval_requests
      SET status = @status,
          approver_client_id = @approver_client_id,
          note = @note,
          updated_at = @updated_at
      WHERE id = @id
    `).run({
      id,
      status,
      approver_client_id: approverClientId,
      note: note ?? null,
      updated_at: new Date().toISOString(),
    });

    return this.getApprovalRequest(id);
  }

  verifyApprovalGrant(query: GovernanceApprovalGrantQuery): GovernanceApprovalRequestSummary | null {
    this.pruneExpiredApprovalRequests();
    const row = this.db.prepare(`
      SELECT * FROM approval_requests
      WHERE id = @approval_id
        AND status = 'approved'
        AND workspace_id = @workspace_id
        AND requester_client_id = @requester_client_id
        AND server_id = @server_id
        AND tool_name = @tool_name
        AND request_fingerprint = @request_fingerprint
        AND expires_at > @now
      LIMIT 1
    `).get({
      ...query,
      now: new Date().toISOString(),
    }) as RawApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  insertAuditEvent(input: CreateGovernanceAuditEventInput): GovernanceAuditEvent {
    const timestamp = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO governance_audit_events (
        timestamp, workspace_id, actor_client_id, action,
        resource_type, resource_id, outcome, details
      ) VALUES (
        @timestamp, @workspace_id, @actor_client_id, @action,
        @resource_type, @resource_id, @outcome, @details
      )
    `).run({
      timestamp,
      workspace_id: input.workspace_id ?? null,
      actor_client_id: input.actor_client_id ?? null,
      action: input.action,
      resource_type: input.resource_type,
      resource_id: input.resource_id ?? null,
      outcome: input.outcome,
      details: input.details !== undefined ? JSON.stringify(input.details) : null,
    });

    return {
      id: Number(result.lastInsertRowid),
      timestamp,
      ...(input.workspace_id ? { workspace_id: input.workspace_id } : {}),
      ...(input.actor_client_id ? { actor_client_id: input.actor_client_id } : {}),
      action: input.action,
      resource_type: input.resource_type,
      ...(input.resource_id ? { resource_id: input.resource_id } : {}),
      outcome: input.outcome,
      ...(input.details ? { details: input.details } : {}),
    };
  }

  listAuditEvents(filters: {
    workspace_id?: string;
    actor_client_id?: string;
    action?: string;
    outcome?: GovernanceAuditEvent['outcome'];
    limit?: number;
    offset?: number;
  } = {}): GovernanceAuditEvent[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.workspace_id) {
      conditions.push('workspace_id = @workspace_id');
      params['workspace_id'] = filters.workspace_id;
    }
    if (filters.actor_client_id) {
      conditions.push('actor_client_id = @actor_client_id');
      params['actor_client_id'] = filters.actor_client_id;
    }
    if (filters.action) {
      conditions.push('action = @action');
      params['action'] = filters.action;
    }
    if (filters.outcome) {
      conditions.push('outcome = @outcome');
      params['outcome'] = filters.outcome;
    }

    params['limit'] = filters.limit ?? 100;
    params['offset'] = filters.offset ?? 0;
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM governance_audit_events
      ${where}
      ORDER BY timestamp DESC
      LIMIT @limit OFFSET @offset
    `).all(params) as RawAuditRow[];
    return rows.map(rowToAuditEvent);
  }

  private pruneExpiredApprovalRequests(): void {
    this.db.prepare(`
      UPDATE approval_requests
      SET status = 'expired',
          updated_at = @updated_at
      WHERE status = 'pending' AND expires_at <= @now
    `).run({
      updated_at: new Date().toISOString(),
      now: new Date().toISOString(),
    });
  }
}

function rowToApproval(row: RawApprovalRow): GovernanceApprovalRequestSummary {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    status: row.status,
    source: row.source,
    workspace_id: row.workspace_id,
    requester_client_id: row.requester_client_id,
    ...(row.approver_client_id ? { approver_client_id: row.approver_client_id } : {}),
    server_id: row.server_id,
    tool_name: row.tool_name,
    ...(row.rule_name ? { rule_name: row.rule_name } : {}),
    reason: row.reason,
    ...(row.trace_id ? { trace_id: row.trace_id } : {}),
    request_fingerprint: row.request_fingerprint,
    ...(row.tool_args ? { tool_args: JSON.parse(row.tool_args) as Record<string, unknown> } : {}),
    ...(row.note ? { note: row.note } : {}),
  };
}

function rowToAuditEvent(row: RawAuditRow): GovernanceAuditEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    ...(row.workspace_id ? { workspace_id: row.workspace_id } : {}),
    ...(row.actor_client_id ? { actor_client_id: row.actor_client_id } : {}),
    action: row.action,
    resource_type: row.resource_type,
    ...(row.resource_id ? { resource_id: row.resource_id } : {}),
    outcome: row.outcome,
    ...(row.details ? { details: JSON.parse(row.details) as Record<string, unknown> } : {}),
  };
}
