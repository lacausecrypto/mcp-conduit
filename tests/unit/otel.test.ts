/**
 * Tests unitaires pour l'intégration OpenTelemetry.
 */

import { describe, it, expect } from 'vitest';
import {
  parseTraceparent,
  formatTraceparent,
  generateSpanId,
  resolveTraceId,
} from '../../src/observability/trace.js';

describe('W3C Trace Context', () => {
  describe('parseTraceparent', () => {
    it('parses a valid traceparent header', () => {
      const result = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
      expect(result).not.toBeNull();
      expect(result!.version).toBe('00');
      expect(result!.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(result!.parentId).toBe('00f067aa0ba902b7');
      expect(result!.flags).toBe('01');
    });

    it('returns null for invalid format', () => {
      expect(parseTraceparent('invalid')).toBeNull();
      expect(parseTraceparent('')).toBeNull();
      expect(parseTraceparent('00-short-id-01')).toBeNull();
    });

    it('returns null for too-short trace ID', () => {
      expect(parseTraceparent('00-4bf92f35-00f067aa0ba902b7-01')).toBeNull();
    });
  });

  describe('formatTraceparent', () => {
    it('formats a traceparent with sampled flag', () => {
      const result = formatTraceparent('4bf92f35-77b3-4da6-a3ce-929d0e0e4736', '00f067aa0ba902b7');
      expect(result).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    });

    it('formats a traceparent with unsampled flag', () => {
      const result = formatTraceparent('4bf92f35-77b3-4da6-a3ce-929d0e0e4736', '00f067aa0ba902b7', false);
      expect(result).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
    });

    it('handles UUID-style trace IDs (with dashes)', () => {
      const result = formatTraceparent('abcdef12-3456-7890-abcd-ef1234567890', 'deadbeef12345678');
      expect(result).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });
  });

  describe('generateSpanId', () => {
    it('generates a 16-char hex string', () => {
      const spanId = generateSpanId();
      expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it('generates unique span IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateSpanId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('resolveTraceId with W3C traceparent', () => {
    it('extracts trace ID from traceparent header', () => {
      const traceId = resolveTraceId({
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      });
      // Should be formatted as UUID-like
      expect(traceId).toBe('4bf92f35-77b3-4da6-a3ce-929d0e0e4736');
    });

    it('prefers traceparent over X-Conduit-Trace-Id', () => {
      const traceId = resolveTraceId({
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'x-conduit-trace-id': 'custom-id-should-be-ignored',
      });
      expect(traceId).toBe('4bf92f35-77b3-4da6-a3ce-929d0e0e4736');
    });

    it('falls back to X-Conduit-Trace-Id when no traceparent', () => {
      const traceId = resolveTraceId({
        'x-conduit-trace-id': 'my-custom-trace-id',
      });
      expect(traceId).toBe('my-custom-trace-id');
    });

    it('generates a new trace ID when no headers present', () => {
      const traceId = resolveTraceId({});
      expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('ignores invalid traceparent and falls back', () => {
      const traceId = resolveTraceId({
        traceparent: 'invalid-traceparent',
        'x-conduit-trace-id': 'fallback-id',
      });
      expect(traceId).toBe('fallback-id');
    });
  });
});
