/**
 * Unit tests for CircuitBreaker.
 *
 * Tests every state transition and edge case rigorously:
 * - Closed state: requests pass through
 * - Failure threshold: N failures → opens circuit
 * - Open state: requests rejected immediately
 * - Reset timeout: after timeout, transitions to half-open
 * - Half-open: limited requests allowed
 * - Half-open success: closes circuit
 * - Half-open failure: reopens circuit
 * - Force reset: back to closed
 * - Config validation
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreaker } from '../../src/router/circuit-breaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeCB(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
    return new CircuitBreaker({
      enabled: true,
      failure_threshold: 3,
      reset_timeout_ms: 5_000,
      half_open_max_requests: 1,
      success_threshold: 2,
      ...overrides,
    });
  }

  // ── Closed state ────────────────────────────────────────────────────────────

  describe('CLOSED state', () => {
    it('starts in closed state', () => {
      const cb = makeCB();
      expect(cb.getState().state).toBe('closed');
    });

    it('allows requests through when closed', () => {
      const cb = makeCB();
      expect(cb.canExecute()).toBe(true);
      expect(cb.canExecute()).toBe(true);
    });

    it('resets failure count on success', () => {
      const cb = makeCB({ failure_threshold: 3 });
      cb.onFailure();
      cb.onFailure();
      cb.onSuccess();
      // After success reset, need 3 more failures to open
      cb.onFailure();
      cb.onFailure();
      expect(cb.getState().state).toBe('closed');
      cb.onFailure();
      expect(cb.getState().state).toBe('open');
    });
  });

  // ── CLOSED → OPEN transition ────────────────────────────────────────────────

  describe('CLOSED → OPEN transition', () => {
    it('opens after failure_threshold failures', () => {
      const cb = makeCB({ failure_threshold: 3 });
      expect(cb.getState().state).toBe('closed');
      cb.onFailure();
      cb.onFailure();
      expect(cb.getState().state).toBe('closed'); // not yet
      cb.onFailure();
      expect(cb.getState().state).toBe('open');
    });

    it('increments trip_count when opening', () => {
      const cb = makeCB({ failure_threshold: 2 });
      expect(cb.getState().trip_count).toBe(0);
      cb.onFailure();
      cb.onFailure();
      expect(cb.getState().trip_count).toBe(1);
    });

    it('failure_threshold of 1 opens on first failure', () => {
      const cb = makeCB({ failure_threshold: 1 });
      cb.onFailure();
      expect(cb.getState().state).toBe('open');
    });
  });

  // ── Open state ──────────────────────────────────────────────────────────────

  describe('OPEN state', () => {
    let cb: CircuitBreaker;

    beforeEach(() => {
      cb = makeCB({ failure_threshold: 2, reset_timeout_ms: 5_000 });
      cb.onFailure();
      cb.onFailure();
      expect(cb.getState().state).toBe('open');
    });

    it('rejects requests immediately when open', () => {
      expect(cb.canExecute()).toBe(false);
      expect(cb.canExecute()).toBe(false);
    });

    it('does not transition before reset_timeout_ms', () => {
      vi.advanceTimersByTime(4_999);
      expect(cb.canExecute()).toBe(false);
      expect(cb.getState().state).toBe('open');
    });

    it('records last_failure timestamp', () => {
      const before = Date.now();
      const state = cb.getState();
      expect(state.last_failure).toBeGreaterThanOrEqual(before - 10);
    });
  });

  // ── OPEN → HALF-OPEN transition ─────────────────────────────────────────────

  describe('OPEN → HALF-OPEN transition', () => {
    it('transitions to half-open after reset_timeout_ms', () => {
      const cb = makeCB({ failure_threshold: 1, reset_timeout_ms: 5_000 });
      cb.onFailure();
      expect(cb.getState().state).toBe('open');

      vi.advanceTimersByTime(5_001);
      // canExecute() triggers the transition
      const allowed = cb.canExecute();
      expect(allowed).toBe(true);
      expect(cb.getState().state).toBe('half-open');
    });

    it('allows exactly half_open_max_requests in half-open state', () => {
      const cb = makeCB({ failure_threshold: 1, reset_timeout_ms: 1_000, half_open_max_requests: 2 });
      cb.onFailure();
      vi.advanceTimersByTime(1_001);

      // First request transitions to half-open and is allowed
      expect(cb.canExecute()).toBe(true);
      // Second request within max
      expect(cb.canExecute()).toBe(true);
      // Third request exceeds max
      expect(cb.canExecute()).toBe(false);
    });
  });

  // ── HALF-OPEN → CLOSED ──────────────────────────────────────────────────────

  describe('HALF-OPEN → CLOSED transition', () => {
    function openAndHalfOpen() {
      const cb = makeCB({
        failure_threshold: 1,
        reset_timeout_ms: 1_000,
        half_open_max_requests: 3,
        success_threshold: 2,
      });
      cb.onFailure();
      vi.advanceTimersByTime(1_001);
      cb.canExecute(); // transition to half-open
      return cb;
    }

    it('closes circuit after success_threshold successes in half-open', () => {
      const cb = openAndHalfOpen();
      expect(cb.getState().state).toBe('half-open');

      cb.onSuccess();
      expect(cb.getState().state).toBe('half-open'); // not yet (threshold = 2)
      cb.onSuccess();
      expect(cb.getState().state).toBe('closed');
    });

    it('allows requests again after closing', () => {
      const cb = openAndHalfOpen();
      cb.onSuccess();
      cb.onSuccess();
      expect(cb.canExecute()).toBe(true);
      expect(cb.canExecute()).toBe(true);
    });
  });

  // ── HALF-OPEN → OPEN ────────────────────────────────────────────────────────

  describe('HALF-OPEN → OPEN transition on failure', () => {
    it('reopens immediately on any failure in half-open', () => {
      const cb = makeCB({ failure_threshold: 1, reset_timeout_ms: 1_000 });
      cb.onFailure();
      vi.advanceTimersByTime(1_001);
      cb.canExecute(); // transition to half-open

      expect(cb.getState().state).toBe('half-open');
      cb.onFailure();
      expect(cb.getState().state).toBe('open');
    });

    it('increments trip_count on half-open → open', () => {
      const cb = makeCB({ failure_threshold: 1, reset_timeout_ms: 1_000 });
      cb.onFailure(); // trip 1
      vi.advanceTimersByTime(1_001);
      cb.canExecute();
      cb.onFailure(); // trip 2
      expect(cb.getState().trip_count).toBe(2);
    });
  });

  // ── Force reset ──────────────────────────────────────────────────────────────

  describe('force reset', () => {
    it('reset() returns circuit to closed state', () => {
      const cb = makeCB({ failure_threshold: 1 });
      cb.onFailure();
      expect(cb.getState().state).toBe('open');

      cb.reset();
      expect(cb.getState().state).toBe('closed');
      expect(cb.getState().failures).toBe(0);
    });

    it('allows requests immediately after reset', () => {
      const cb = makeCB({ failure_threshold: 1 });
      cb.onFailure();
      cb.reset();
      expect(cb.canExecute()).toBe(true);
    });

    it('reset() from half-open returns to closed', () => {
      const cb = makeCB({ failure_threshold: 1, reset_timeout_ms: 1_000 });
      cb.onFailure();
      vi.advanceTimersByTime(1_001);
      cb.canExecute(); // → half-open
      cb.reset();
      expect(cb.getState().state).toBe('closed');
    });
  });

  // ── getState ─────────────────────────────────────────────────────────────────

  describe('getState()', () => {
    it('exposes failures count', () => {
      const cb = makeCB({ failure_threshold: 5 });
      cb.onFailure();
      cb.onFailure();
      expect(cb.getState().failures).toBe(2);
    });

    it('exposes successes count in half-open', () => {
      const cb = makeCB({ failure_threshold: 1, reset_timeout_ms: 1_000, success_threshold: 3 });
      cb.onFailure();
      vi.advanceTimersByTime(1_001);
      cb.canExecute();

      cb.onSuccess();
      expect(cb.getState().successes).toBe(1);
      cb.onSuccess();
      expect(cb.getState().successes).toBe(2);
    });

    it('last_failure is 0 before any failure', () => {
      const cb = makeCB();
      expect(cb.getState().last_failure).toBe(0);
    });

    it('last_failure is updated on each failure', () => {
      const cb = makeCB({ failure_threshold: 10 });
      const t1 = Date.now();
      cb.onFailure();
      vi.advanceTimersByTime(100);
      cb.onFailure();
      expect(cb.getState().last_failure).toBeGreaterThanOrEqual(t1 + 100);
    });
  });

  // ── trips property ──────────────────────────────────────────────────────────

  describe('trips', () => {
    it('trips increments per circuit open event', () => {
      const cb = makeCB({ failure_threshold: 1, reset_timeout_ms: 1_000 });
      expect(cb.trips).toBe(0);

      cb.onFailure(); // trip 1
      expect(cb.trips).toBe(1);

      vi.advanceTimersByTime(1_001);
      cb.canExecute(); // → half-open
      cb.onFailure(); // trip 2
      expect(cb.trips).toBe(2);
    });
  });

  // ── Default config ──────────────────────────────────────────────────────────

  describe('default config', () => {
    it('uses sensible defaults when no config provided', () => {
      const cb = new CircuitBreaker();
      expect(cb.getState().state).toBe('closed');
      // Default failure_threshold = 5
      for (let i = 0; i < 4; i++) cb.onFailure();
      expect(cb.getState().state).toBe('closed');
      cb.onFailure();
      expect(cb.getState().state).toBe('open');
    });
  });

  // ── Audit High 3.2 #3 — default-config deadlock fix ─────────────────────────
  // Prior to the fix, the default config (half_open_max_requests=1,
  // success_threshold=2) deadlocked: after one successful probe in half-open,
  // halfOpenRequests=1 saturated the cap so no second probe could pass, and
  // the success counter could never reach the threshold to close the circuit.
  describe('half-open recovery with default config (audit High 3.2 #3)', () => {
    it('closes the circuit after enough successes even with halfOpenMax=1, threshold=2', () => {
      const cb = makeCB({
        failure_threshold: 1,
        reset_timeout_ms: 1_000,
        half_open_max_requests: 1,
        success_threshold: 2,
      });
      cb.onFailure();
      expect(cb.getState().state).toBe('open');

      vi.advanceTimersByTime(1_001);

      // First probe transitions to half-open and is allowed
      expect(cb.canExecute()).toBe(true);
      expect(cb.getState().state).toBe('half-open');
      cb.onSuccess();
      // Without the fix: 2nd canExecute() would return false (deadlock).
      expect(cb.canExecute()).toBe(true);
      cb.onSuccess();
      expect(cb.getState().state).toBe('closed');
    });

    it('exposed default-config deadlock: 1 success then no further probe pre-fix', () => {
      // Same scenario, but verify the in-flight counter is correctly released
      // after a success so the half-open state never refuses a probe when
      // none is actually in flight.
      const cb = makeCB({
        failure_threshold: 1,
        reset_timeout_ms: 100,
        half_open_max_requests: 1,
        success_threshold: 3,
      });
      cb.onFailure();
      vi.advanceTimersByTime(101);

      for (let i = 0; i < 3; i++) {
        expect(cb.canExecute()).toBe(true);
        cb.onSuccess();
      }
      expect(cb.getState().state).toBe('closed');
    });

    it('keeps the in-flight cap honored under concurrent probes', () => {
      // The fix decrements halfOpenRequests on completion; a probe that has
      // not yet completed must still count toward the cap. This guards against
      // accidentally turning halfOpenMaxRequests into "total" instead of
      // "concurrent" probes.
      const cb = makeCB({
        failure_threshold: 1,
        reset_timeout_ms: 100,
        half_open_max_requests: 2,
        success_threshold: 5,
      });
      cb.onFailure();
      vi.advanceTimersByTime(101);

      // Two concurrent probes — both allowed, none complete yet
      expect(cb.canExecute()).toBe(true);
      expect(cb.canExecute()).toBe(true);
      // Third concurrent probe is rejected (cap)
      expect(cb.canExecute()).toBe(false);

      // Complete one — slot frees up
      cb.onSuccess();
      expect(cb.canExecute()).toBe(true);
    });

    it('failure during half-open still reopens regardless of in-flight count', () => {
      const cb = makeCB({
        failure_threshold: 1,
        reset_timeout_ms: 100,
        half_open_max_requests: 3,
        success_threshold: 5,
      });
      cb.onFailure();
      vi.advanceTimersByTime(101);
      cb.canExecute();
      cb.canExecute();
      cb.canExecute();
      expect(cb.getState().state).toBe('half-open');
      cb.onFailure();
      expect(cb.getState().state).toBe('open');
    });

    it('success in CLOSED state does not push halfOpenRequests below zero', () => {
      // Defensive: onSuccess in closed state must not corrupt counters.
      const cb = makeCB({
        failure_threshold: 1,
        reset_timeout_ms: 100,
        half_open_max_requests: 1,
        success_threshold: 1,
      });
      cb.onSuccess();
      cb.onSuccess();
      cb.onSuccess();
      // After plenty of successes in closed state, half-open transition still
      // works as expected.
      cb.onFailure();
      vi.advanceTimersByTime(101);
      expect(cb.canExecute()).toBe(true);
    });
  });
});
