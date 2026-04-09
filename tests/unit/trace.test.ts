/**
 * Tests for src/observability/trace.ts
 * Covers: generateTraceId, resolveTraceId, buildTraceHeaders
 */

import { describe, it, expect } from 'vitest';
import {
  generateTraceId,
  resolveTraceId,
  buildTraceHeaders,
  TRACE_HEADER,
} from '../../src/observability/trace.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateTraceId', () => {
  it('returns a valid UUID v4', () => {
    const id = generateTraceId();
    expect(id).toMatch(UUID_REGEX);
  });

  it('returns a unique value each call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });
});

describe('resolveTraceId', () => {
  it('returns the existing trace ID from headers (lowercase key)', () => {
    const headers = { 'x-conduit-trace-id': 'my-trace-id' };
    expect(resolveTraceId(headers)).toBe('my-trace-id');
  });

  it('returns the first element when header is an array', () => {
    const headers = { 'x-conduit-trace-id': ['array-trace-id', 'ignored'] };
    expect(resolveTraceId(headers)).toBe('array-trace-id');
  });

  it('generates a new UUID when header is missing', () => {
    const headers: Record<string, string> = {};
    const id = resolveTraceId(headers);
    expect(id).toMatch(UUID_REGEX);
  });

  it('generates a new UUID when header is an empty string', () => {
    const headers = { 'x-conduit-trace-id': '' };
    const id = resolveTraceId(headers);
    expect(id).toMatch(UUID_REGEX);
  });

  it('generates a new UUID when header is whitespace only', () => {
    const headers = { 'x-conduit-trace-id': '   ' };
    const id = resolveTraceId(headers);
    expect(id).toMatch(UUID_REGEX);
  });

  it('generates a new UUID when header is an empty array', () => {
    const headers = { 'x-conduit-trace-id': [] };
    const id = resolveTraceId(headers);
    expect(id).toMatch(UUID_REGEX);
  });

  it('generates a new UUID when header array contains empty string', () => {
    const headers = { 'x-conduit-trace-id': ['', 'second'] };
    const id = resolveTraceId(headers);
    expect(id).toMatch(UUID_REGEX);
  });

  it('trims whitespace from string header value', () => {
    const headers = { 'x-conduit-trace-id': '  my-trace  ' };
    expect(resolveTraceId(headers)).toBe('my-trace');
  });

  it('trims whitespace from array header value', () => {
    const headers = { 'x-conduit-trace-id': ['  array-trace  '] };
    expect(resolveTraceId(headers)).toBe('array-trace');
  });

  it('generates a new UUID when header is undefined', () => {
    const headers = { 'x-conduit-trace-id': undefined };
    const id = resolveTraceId(headers);
    expect(id).toMatch(UUID_REGEX);
  });
});

describe('buildTraceHeaders', () => {
  it('returns an object with the trace header', () => {
    const headers = buildTraceHeaders('my-trace-123');
    expect(headers[TRACE_HEADER]).toBe('my-trace-123');
  });

  it('uses the correct header name constant', () => {
    expect(TRACE_HEADER).toBe('X-Conduit-Trace-Id');
  });

  it('returns both custom and W3C traceparent headers', () => {
    const traceId = 'abcdef12-3456-7890-abcd-ef1234567890';
    const headers = buildTraceHeaders(traceId);
    expect(Object.keys(headers)).toHaveLength(2);
    expect(headers['X-Conduit-Trace-Id']).toBe(traceId);
    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});
