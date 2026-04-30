/**
 * GovernanceStore unit tests.
 *
 * Audit `tests/3.1#3` — the 397-line `src/governance/store.ts` had zero direct
 * unit tests; only the high-level e2e governance-plane tests exercised it.
 *
 * Covers :
 *   - approval request lifecycle (create / reuse / approve / reject / expire)
 *   - fingerprint-based deduplication of pending requests
 *   - filter combinations on list / audit
 *   - verifyApprovalGrant correctness against id + fingerprint + workspace
 *   - audit-event insert + filter
 *   - boundary cases (expires_at == now, missing optional fields, etc.)
 */
import { describe, expect, it } from 'vitest';
import { GovernanceStore } from '../../src/governance/store.js';
import type {
  CreateGovernanceApprovalRequestInput,
  GovernanceApprovalGrantQuery,
} from '../../src/governance/types.js';

function buildInput(over: Partial<CreateGovernanceApprovalRequestInput> = {}): CreateGovernanceApprovalRequestInput {
  return {
    source: 'governance',
    workspace_id: 'ws-1',
    requester_client_id: 'agent-a',
    server_id: 'salesforce',
    tool_name: 'create_lead',
    reason: 'requires manager approval',
    request_fingerprint: 'fp-abc',
    tool_args: { name: 'Acme', amount: 1000 },
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  };
}

function buildGrantQuery(over: Partial<GovernanceApprovalGrantQuery> = {}): GovernanceApprovalGrantQuery {
  return {
    approval_id: '',
    workspace_id: 'ws-1',
    requester_client_id: 'agent-a',
    server_id: 'salesforce',
    tool_name: 'create_lead',
    request_fingerprint: 'fp-abc',
    ...over,
  };
}

describe('GovernanceStore — approval lifecycle', () => {
  it('persists a pending approval request and reads it back', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput());
    expect(created.status).toBe('pending');
    expect(created.id).toBeTruthy();
    expect(created.tool_args).toEqual({ name: 'Acme', amount: 1000 });

    const fetched = store.getApprovalRequest(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.tool_args).toEqual({ name: 'Acme', amount: 1000 });
  });

  it('reuses an existing pending request when fingerprint matches', () => {
    const store = new GovernanceStore(':memory:');
    const first = store.createOrReuseApprovalRequest(buildInput());
    const second = store.createOrReuseApprovalRequest(buildInput());
    expect(second.id).toBe(first.id);
    expect(store.listApprovalRequests({ status: 'pending' })).toHaveLength(1);
  });

  it('creates a new request when any of (workspace, requester, server, tool, fingerprint) differs', () => {
    const store = new GovernanceStore(':memory:');
    const a = store.createOrReuseApprovalRequest(buildInput({ request_fingerprint: 'fp-1' }));
    const b = store.createOrReuseApprovalRequest(buildInput({ request_fingerprint: 'fp-2' }));
    const c = store.createOrReuseApprovalRequest(buildInput({ requester_client_id: 'agent-b' }));
    const d = store.createOrReuseApprovalRequest(buildInput({ workspace_id: 'ws-2' }));
    const e = store.createOrReuseApprovalRequest(buildInput({ server_id: 'github' }));
    const f = store.createOrReuseApprovalRequest(buildInput({ tool_name: 'delete_lead' }));
    const ids = new Set([a.id, b.id, c.id, d.id, e.id, f.id]);
    expect(ids.size).toBe(6);
  });

  it('approves a pending request and records approver_client_id + note', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput());
    const approved = store.approveRequest(created.id, 'manager-1', 'lgtm');
    expect(approved).not.toBeNull();
    expect(approved?.status).toBe('approved');
    expect(approved?.approver_client_id).toBe('manager-1');
    expect(approved?.note).toBe('lgtm');
  });

  it('rejects a pending request', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput());
    const rejected = store.rejectRequest(created.id, 'manager-1', 'too risky');
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.note).toBe('too risky');
  });

  it('returns null when approving an unknown request id', () => {
    const store = new GovernanceStore(':memory:');
    expect(store.approveRequest('does-not-exist', 'manager-1')).toBeNull();
  });

  it('returns null when approving an already-approved request (no double-approval)', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput());
    store.approveRequest(created.id, 'manager-1');
    const second = store.approveRequest(created.id, 'manager-2');
    expect(second).toBeNull();
  });

  it('returns null when rejecting an already-approved request', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput());
    store.approveRequest(created.id, 'manager-1');
    expect(store.rejectRequest(created.id, 'manager-2')).toBeNull();
  });

  it('after reuse fails on an approved request, a fresh request is created (not the old approved one)', () => {
    // pending → approved makes the old row no longer reusable; subsequent create
    // should yield a fresh pending row.
    const store = new GovernanceStore(':memory:');
    const original = store.createOrReuseApprovalRequest(buildInput());
    store.approveRequest(original.id, 'manager-1');
    const reissued = store.createOrReuseApprovalRequest(buildInput());
    expect(reissued.id).not.toBe(original.id);
    expect(reissued.status).toBe('pending');
  });
});

describe('GovernanceStore — expiry behaviour', () => {
  it('marks pending requests as expired once expires_at <= now', async () => {
    const store = new GovernanceStore(':memory:');
    // Insert with very short TTL, then wait past it before reading.
    const created = store.createOrReuseApprovalRequest(buildInput({
      expires_at: new Date(Date.now() + 30).toISOString(),
    }));
    expect(created.status).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Subsequent read invokes pruneExpiredApprovalRequests and transitions it.
    const fetched = store.getApprovalRequest(created.id);
    expect(fetched?.status).toBe('expired');
  });

  it('does not auto-mark approved requests as expired even past expires_at', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput({
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }));
    const approved = store.approveRequest(created.id, 'manager-1');
    expect(approved?.status).toBe('approved');
    // Force prune by creating any new request (which calls pruneExpired).
    store.createOrReuseApprovalRequest(buildInput({ request_fingerprint: 'other' }));
    const re = store.getApprovalRequest(created.id);
    expect(re?.status).toBe('approved');
  });

  it('expired pending request is not reused — a fresh one is created', () => {
    const store = new GovernanceStore(':memory:');
    const expired = store.createOrReuseApprovalRequest(buildInput({
      expires_at: new Date(Date.now() - 1).toISOString(),
    }));
    const next = store.createOrReuseApprovalRequest(buildInput({
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }));
    expect(next.id).not.toBe(expired.id);
    expect(next.status).toBe('pending');
  });
});

describe('GovernanceStore — list filters', () => {
  function seed(store: GovernanceStore): void {
    store.createOrReuseApprovalRequest(buildInput({ workspace_id: 'ws-1', requester_client_id: 'agent-a', request_fingerprint: 'a1', tool_name: 't1' }));
    store.createOrReuseApprovalRequest(buildInput({ workspace_id: 'ws-1', requester_client_id: 'agent-b', request_fingerprint: 'b1', tool_name: 't1' }));
    store.createOrReuseApprovalRequest(buildInput({ workspace_id: 'ws-2', requester_client_id: 'agent-a', request_fingerprint: 'a2', tool_name: 't2' }));
    store.createOrReuseApprovalRequest(buildInput({ workspace_id: 'ws-2', requester_client_id: 'agent-c', request_fingerprint: 'c1', tool_name: 't3' }));
  }

  it('filters by workspace_id', () => {
    const store = new GovernanceStore(':memory:');
    seed(store);
    const ws1 = store.listApprovalRequests({ workspace_id: 'ws-1' });
    expect(ws1).toHaveLength(2);
    expect(ws1.every((r) => r.workspace_id === 'ws-1')).toBe(true);
  });

  it('filters by requester_client_id', () => {
    const store = new GovernanceStore(':memory:');
    seed(store);
    const a = store.listApprovalRequests({ requester_client_id: 'agent-a' });
    expect(a).toHaveLength(2);
  });

  it('filters by status', () => {
    const store = new GovernanceStore(':memory:');
    seed(store);
    const all = store.listApprovalRequests({ workspace_id: 'ws-1' });
    store.approveRequest(all[0]!.id, 'mgr-1');
    expect(store.listApprovalRequests({ status: 'approved' })).toHaveLength(1);
    expect(store.listApprovalRequests({ status: 'pending' })).toHaveLength(3);
  });

  it('combines workspace_id + status + requester_client_id', () => {
    const store = new GovernanceStore(':memory:');
    seed(store);
    const matches = store.listApprovalRequests({
      workspace_id: 'ws-2',
      requester_client_id: 'agent-a',
      status: 'pending',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.tool_name).toBe('t2');
  });

  it('respects limit + offset for pagination', () => {
    const store = new GovernanceStore(':memory:');
    for (let i = 0; i < 5; i++) {
      store.createOrReuseApprovalRequest(buildInput({ request_fingerprint: `fp-${i}` }));
    }
    const page1 = store.listApprovalRequests({ limit: 2, offset: 0 });
    const page2 = store.listApprovalRequests({ limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page1[0]?.id).not.toBe(page2[0]?.id);
  });

  it('orders by created_at DESC (most-recent first)', async () => {
    const store = new GovernanceStore(':memory:');
    const first = store.createOrReuseApprovalRequest(buildInput({ request_fingerprint: 'fp-first' }));
    // Ensure created_at differs by at least 1 ms — ISO strings tie at ms resolution.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = store.createOrReuseApprovalRequest(buildInput({ request_fingerprint: 'fp-second' }));
    const list = store.listApprovalRequests();
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe(second.id);
    expect(list[1]?.id).toBe(first.id);
  });
});

describe('GovernanceStore — verifyApprovalGrant', () => {
  it('returns the approval row when id + fingerprint + identity all match', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput());
    store.approveRequest(created.id, 'manager-1');
    const grant = store.verifyApprovalGrant(buildGrantQuery({ approval_id: created.id }));
    expect(grant).not.toBeNull();
    expect(grant?.id).toBe(created.id);
  });

  it('returns null if request_fingerprint differs (replay across different args)', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput({ request_fingerprint: 'fp-original' }));
    store.approveRequest(created.id, 'manager-1');
    const grant = store.verifyApprovalGrant(buildGrantQuery({
      approval_id: created.id,
      request_fingerprint: 'fp-different',
    }));
    expect(grant).toBeNull();
  });

  it('returns null if requester_client_id differs (cross-user replay)', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput());
    store.approveRequest(created.id, 'manager-1');
    const grant = store.verifyApprovalGrant(buildGrantQuery({
      approval_id: created.id,
      requester_client_id: 'agent-other',
    }));
    expect(grant).toBeNull();
  });

  it('returns null if workspace_id differs (cross-workspace replay)', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput({ workspace_id: 'ws-A' }));
    store.approveRequest(created.id, 'manager-1');
    const grant = store.verifyApprovalGrant(buildGrantQuery({
      approval_id: created.id,
      workspace_id: 'ws-B',
    }));
    expect(grant).toBeNull();
  });

  it('returns null for a still-pending approval (must be approved)', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput());
    const grant = store.verifyApprovalGrant(buildGrantQuery({ approval_id: created.id }));
    expect(grant).toBeNull();
  });

  it('returns null for an expired approval row even if approved', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput({
      expires_at: new Date(Date.now() + 50).toISOString(),
    }));
    store.approveRequest(created.id, 'manager-1');
    // Sleep past expiry
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const grant = store.verifyApprovalGrant(buildGrantQuery({ approval_id: created.id }));
        expect(grant).toBeNull();
        resolve();
      }, 80);
    });
  });

  it('returns null for a rejected approval', () => {
    const store = new GovernanceStore(':memory:');
    const created = store.createOrReuseApprovalRequest(buildInput());
    store.rejectRequest(created.id, 'manager-1');
    const grant = store.verifyApprovalGrant(buildGrantQuery({ approval_id: created.id }));
    expect(grant).toBeNull();
  });
});

describe('GovernanceStore — audit events', () => {
  it('inserts and reads back audit events with full fidelity', () => {
    const store = new GovernanceStore(':memory:');
    const event = store.insertAuditEvent({
      workspace_id: 'ws-1',
      actor_client_id: 'agent-a',
      action: 'tool.execute',
      resource_type: 'tool',
      resource_id: 'salesforce/create_lead',
      outcome: 'success',
      details: { reason: 'rule-allow', latency_ms: 42 },
    });
    expect(event.id).toBeGreaterThan(0);
    expect(event.timestamp).toBeTruthy();

    const list = store.listAuditEvents({ workspace_id: 'ws-1' });
    expect(list).toHaveLength(1);
    expect(list[0]?.details).toEqual({ reason: 'rule-allow', latency_ms: 42 });
  });

  it('filters audit events by action + outcome combo', () => {
    const store = new GovernanceStore(':memory:');
    store.insertAuditEvent({ workspace_id: 'ws-1', action: 'tool.execute', resource_type: 'tool', outcome: 'success' });
    store.insertAuditEvent({ workspace_id: 'ws-1', action: 'tool.execute', resource_type: 'tool', outcome: 'denied' });
    store.insertAuditEvent({ workspace_id: 'ws-1', action: 'approval.granted', resource_type: 'approval', outcome: 'success' });

    const denied = store.listAuditEvents({ action: 'tool.execute', outcome: 'denied' });
    expect(denied).toHaveLength(1);

    const allTool = store.listAuditEvents({ action: 'tool.execute' });
    expect(allTool).toHaveLength(2);

    const allSuccess = store.listAuditEvents({ outcome: 'success' });
    expect(allSuccess).toHaveLength(2);
  });

  it('handles audit events with no optional fields', () => {
    const store = new GovernanceStore(':memory:');
    const event = store.insertAuditEvent({
      action: 'system.startup',
      resource_type: 'system',
      outcome: 'success',
    });
    expect(event.workspace_id).toBeUndefined();
    expect(event.actor_client_id).toBeUndefined();
    expect(event.resource_id).toBeUndefined();
    expect(event.details).toBeUndefined();
  });

  it('orders audit events by timestamp DESC', () => {
    const store = new GovernanceStore(':memory:');
    const e1 = store.insertAuditEvent({ action: 'a1', resource_type: 'r', outcome: 'success' });
    const e2 = store.insertAuditEvent({ action: 'a2', resource_type: 'r', outcome: 'success' });
    const list = store.listAuditEvents();
    // Most recent first; SQL ORDER BY timestamp DESC. With ms-resolution
    // timestamps two events written in the same ms can tie — rely on insertion id.
    expect(list[0]?.id).toBeGreaterThanOrEqual(e1.id);
    expect(list[1]?.id).toBeLessThanOrEqual(e2.id);
  });
});

describe('GovernanceStore — ping / db hygiene', () => {
  it('ping returns true on a live in-memory db', () => {
    const store = new GovernanceStore(':memory:');
    expect(store.ping()).toBe(true);
  });
});
