/**
 * Startup tests for src/index.ts
 * Tests the main() execution path, shutdown handler, and error handlers.
 * Uses vi.mock to avoid spawning real servers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock all heavy dependencies before any import ───────────────────────────

const mockGateway = {
  initialize: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/config/loader.js', () => ({
  loadConfigFromEnv: vi.fn(() => ({
    gateway: { port: 8080, host: '0.0.0.0' },
    metrics: { enabled: false, port: 9090 },
    cache: { enabled: true, l1: { max_entries: 100, max_entry_size_kb: 64 } },
    observability: { db_path: ':memory:' },
    servers: [],
    admin: undefined,
    auth: undefined,
    acl: undefined,
    rate_limits: undefined,
  })),
}));

vi.mock('../../src/gateway/gateway.js', () => ({
  ConduitGateway: vi.fn(() => mockGateway),
}));

vi.mock('../../src/observability/metrics.js', () => ({
  getMetrics: vi.fn(() => ({ getMetrics: vi.fn().mockResolvedValue('# metrics\n') })),
  resetMetrics: vi.fn(),
}));

vi.mock('@hono/node-server', () => ({
  serve: vi.fn((_opts: unknown, cb?: (info: { port: number }) => void) => {
    cb?.({ port: 9090 });
  }),
}));

vi.mock('hono', () => {
  const mockApp = { get: vi.fn(), fetch: vi.fn() };
  return { Hono: vi.fn(() => mockApp) };
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('src/index.ts — startup (happy path)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.clearAllMocks();
    mockGateway.initialize.mockResolvedValue(undefined);
    mockGateway.start.mockResolvedValue(undefined);
    mockGateway.stop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it('imports and runs main() without crashing', async () => {
    // Dynamic import triggers main() — runs with mocked dependencies
    await import('../../src/index.js');

    // Allow async main() to settle
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const { ConduitGateway } = await import('../../src/gateway/gateway.js');
    const { resetMetrics } = await import('../../src/observability/metrics.js');

    // Gateway was constructed and initialized
    expect(vi.mocked(ConduitGateway)).toHaveBeenCalled();
    expect(vi.mocked(resetMetrics)).toHaveBeenCalled();
    expect(mockGateway.initialize).toHaveBeenCalled();
    expect(mockGateway.start).toHaveBeenCalled();
  });
});

describe('src/index.ts — global error handlers', () => {
  it('uncaughtException handler calls process.exit(1)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // The handler is registered when the module is first imported (already done above)
    // Emit the event to trigger it
    process.emit('uncaughtException', new Error('test uncaught error'), 'uncaughtException');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Conduit]'),
      expect.any(Error),
    );

    exitSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it('unhandledRejection handler calls process.exit(1)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    process.emit('unhandledRejection', new Error('test rejection'), Promise.resolve());

    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });
});
