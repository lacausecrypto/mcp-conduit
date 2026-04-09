/**
 * Circuit Breaker pattern for upstream MCP server connections.
 *
 * State machine:
 *   CLOSED   → OPEN      : when failure_count >= failure_threshold
 *   OPEN     → HALF-OPEN : after reset_timeout_ms has passed
 *   HALF-OPEN → CLOSED   : when success_count >= success_threshold
 *   HALF-OPEN → OPEN     : on any failure
 *
 * The circuit breaker prevents cascading failures by fast-failing requests
 * when a backend is consistently degraded, then allowing a probe request
 * through after the reset timeout to check if the backend has recovered.
 */

import type { CircuitBreakerConfig } from '../config/types.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  failure_threshold: 5,
  reset_timeout_ms: 30_000,
  half_open_max_requests: 1,
  success_threshold: 2,
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private halfOpenRequests = 0;
  private tripCount = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxRequests: number;
  private readonly successThreshold: number;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    this.failureThreshold = merged.failure_threshold;
    this.resetTimeoutMs = merged.reset_timeout_ms;
    this.halfOpenMaxRequests = merged.half_open_max_requests;
    this.successThreshold = merged.success_threshold;
  }

  /**
   * Returns true if the request should be allowed through.
   * Handles OPEN → HALF-OPEN transition based on timeout.
   */
  canExecute(): boolean {
    switch (this.state) {
      case 'closed':
        return true;

      case 'open': {
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.resetTimeoutMs) {
          // Transition to half-open — allow limited probe requests
          this.state = 'half-open';
          this.halfOpenRequests = 0;
          this.successCount = 0;
          return this.halfOpenRequests < this.halfOpenMaxRequests
            ? (this.halfOpenRequests++, true)
            : false;
        }
        return false;
      }

      case 'half-open':
        if (this.halfOpenRequests < this.halfOpenMaxRequests) {
          this.halfOpenRequests++;
          return true;
        }
        return false;
    }
  }

  /**
   * Record a successful request.
   * In half-open state: accumulates successes toward closing the circuit.
   */
  onSuccess(): void {
    switch (this.state) {
      case 'closed':
        // Reset failure count on success
        this.failureCount = 0;
        break;

      case 'half-open':
        this.successCount++;
        if (this.successCount >= this.successThreshold) {
          this.state = 'closed';
          this.failureCount = 0;
          this.successCount = 0;
          this.halfOpenRequests = 0;
        }
        break;

      case 'open':
        // Shouldn't happen — canExecute() blocks open state
        break;
    }
  }

  /**
   * Record a failed request.
   * In closed state: increments failure count, opens circuit at threshold.
   * In half-open state: reopens the circuit immediately.
   */
  onFailure(): void {
    this.lastFailureTime = Date.now();

    switch (this.state) {
      case 'closed':
        this.failureCount++;
        if (this.failureCount >= this.failureThreshold) {
          this.state = 'open';
          this.tripCount++;
        }
        break;

      case 'half-open':
        // Any failure in half-open reopens
        this.state = 'open';
        this.tripCount++;
        this.successCount = 0;
        this.halfOpenRequests = 0;
        break;

      case 'open':
        // Already open — update timestamp
        break;
    }
  }

  /** Returns the current circuit state and diagnostic info. */
  getState(): {
    state: CircuitState;
    failures: number;
    successes: number;
    last_failure: number;
    trip_count: number;
  } {
    return {
      state: this.state,
      failures: this.failureCount,
      successes: this.successCount,
      last_failure: this.lastFailureTime,
      trip_count: this.tripCount,
    };
  }

  /** Force the circuit back to closed state. */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenRequests = 0;
    this.lastFailureTime = 0;
  }

  /** Number of times the circuit has tripped (transitioned to open). */
  get trips(): number {
    return this.tripCount;
  }
}
