/**
 * MCP Conduit — Production Benchmark
 *
 * Tests the full gateway pipeline with all modules enabled.
 * Compares direct backend calls vs gateway for latency, throughput,
 * upstream savings, and per-module overhead.
 *
 * Usage: npx tsx tests/benchmark/gateway-benchmark.ts
 */

import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { resetMetrics } from '../../src/observability/metrics.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LatencyResult {
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  min: number;
  max: number;
  samples: number;
}

interface ScenarioResult {
  name: string;
  direct?: LatencyResult;
  gateway?: LatencyResult;
  deltaP50?: number;
  throughputDirect?: number;
  throughputGateway?: number;
  throughputMultiplier?: number;
  upstreamCallsDirect?: number;
  upstreamCallsGateway?: number;
  upstreamSaved?: number;
  upstreamSavedPct?: number;
  note?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))] ?? 0;
}

function calcLatency(samples: number[]): LatencyResult {
  if (samples.length === 0) {
    return { p50: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0, samples: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    avg,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    samples: samples.length,
  };
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function fmtMs(n: number): string {
  if (n < 1) return `${fmt(n * 1000, 0)}µs`;
  return `${fmt(n, 2)}ms`;
}

function fmtMsFixed(n: number): string {
  return `${fmt(n, 2)}ms`;
}

function pad(s: string, len: number, leftAlign = false): string {
  return leftAlign ? s.padEnd(len) : s.padStart(len);
}

// ── Mock Backend ──────────────────────────────────────────────────────────────

interface MockBackend {
  url: string;
  getCallCount(): number;
  resetCallCount(): void;
  close(): Promise<void>;
}

const TOOLS = [
  {
    name: 'bench_tool',
    description: 'Benchmark tool',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
];

function startMockBackend(delayMs = 0): Promise<MockBackend> {
  let callCount = 0;

  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const handle = async () => {
        if (delayMs > 0) await sleep(delayMs);
        callCount++;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          res.writeHead(400); res.end(); return;
        }

        const id = parsed['id'] ?? null;
        const method = String(parsed['method'] ?? '');

        let response: object;
        if (method === 'initialize') {
          response = {
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'bench-mock', version: '1.0' },
            },
          };
        } else if (method === 'tools/list') {
          response = { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        } else if (method === 'tools/call') {
          response = {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: 'benchmark result' }] },
          };
        } else {
          response = {
            jsonrpc: '2.0', id,
            error: { code: -32601, message: `Unknown: ${method}` },
          };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      };
      handle().catch(() => { res.writeHead(500); res.end(); });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('No address')); return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        getCallCount() { return callCount; },
        resetCallCount() { callCount = 0; },
        close() {
          return new Promise((res, rej) => {
            server.closeAllConnections?.();
            server.close((e) => e ? rej(e) : res());
          });
        },
      });
    });
  });
}

// ── Config builders ───────────────────────────────────────────────────────────

type GatewayFeatures = {
  auth?: boolean;
  acl?: boolean;
  rateLimit?: boolean;
  cache?: boolean;
  circuitBreaker?: boolean;
};

function makeConfig(backendUrl: string, features: GatewayFeatures = {}): ConduitGatewayConfig {
  const {
    auth = false,
    acl = false,
    rateLimit = false,
    cache = true,
    circuitBreaker = false,
  } = features;

  const serverEntry: ConduitGatewayConfig['servers'][0] = {
    id: 'bench',
    url: backendUrl,
    ...(cache ? { cache: { default_ttl: 300 } } : { cache: { default_ttl: 0 } }),
    ...(circuitBreaker
      ? { circuit_breaker: { enabled: true, failure_threshold: 10, reset_timeout_ms: 30000, success_threshold: 2, half_open_max_requests: 1 } }
      : {}),
  };

  const config: ConduitGatewayConfig = {
    gateway: { port: 0, host: '127.0.0.1' },
    router: {
      namespace_strategy: 'none',
      health_check: {
        enabled: false, interval_seconds: 60,
        timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1,
      },
    },
    servers: [serverEntry],
    cache: {
      enabled: cache,
      l1: { max_entries: 10000, max_entry_size_kb: 256 },
    },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: {
      log_args: false, log_responses: false,
      redact_fields: [], retention_days: 1, db_path: ':memory:',
    },
    metrics: { enabled: false, port: 0 },
  };

  if (auth) {
    config.auth = {
      method: 'api-key',
      api_keys: [{ key: 'bench-key', client_id: 'bench-client', tenant_id: 'default' }],
    };
  }

  if (acl) {
    config.acl = {
      enabled: true,
      default_action: 'allow',
      policies: [
        {
          name: 'bench-policy',
          clients: ['bench-client'],
          allow: [{ server: 'bench', tools: ['bench_tool'] }],
        },
      ],
    };
  }

  if (rateLimit) {
    config.rate_limits = {
      enabled: true,
      per_client: { requests_per_minute: 1_000_000 }, // effectively unlimited
    };
  }

  return config;
}

function makeFullConfig(backendUrl: string): ConduitGatewayConfig {
  return makeConfig(backendUrl, {
    auth: true, acl: true, rateLimit: true, cache: true, circuitBreaker: true,
  });
}

// ── Request runners ───────────────────────────────────────────────────────────

async function runDirect(
  backendUrl: string,
  body: unknown,
  N: number,
  concurrency: number,
  warmup = 5,
): Promise<{ latency: LatencyResult; totalMs: number }> {
  const bodyStr = JSON.stringify(body);
  const latencies: number[] = [];

  const doOne = async () => {
    const t = performance.now();
    await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
    });
    latencies.push(performance.now() - t);
  };

  for (let i = 0; i < warmup; i++) await doOne();
  latencies.length = 0;

  const start = performance.now();
  const batches = Math.ceil(N / concurrency);
  for (let b = 0; b < batches; b++) {
    const sz = Math.min(concurrency, N - b * concurrency);
    await Promise.all(Array.from({ length: sz }, () => doOne()));
  }
  return { latency: calcLatency(latencies), totalMs: performance.now() - start };
}

type HonoApp = { request: (url: string, init?: RequestInit) => Promise<Response> };

async function runGateway(
  app: HonoApp,
  body: unknown,
  N: number,
  concurrency: number,
  warmup = 5,
  extraHeaders: Record<string, string> = {},
): Promise<{ latency: LatencyResult; totalMs: number }> {
  const bodyStr = JSON.stringify(body);
  const latencies: number[] = [];
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };

  const doOne = async () => {
    const t = performance.now();
    await app.request('/mcp/bench', { method: 'POST', headers, body: bodyStr });
    latencies.push(performance.now() - t);
  };

  for (let i = 0; i < warmup; i++) await doOne();
  latencies.length = 0;

  const start = performance.now();
  const batches = Math.ceil(N / concurrency);
  for (let b = 0; b < batches; b++) {
    const sz = Math.min(concurrency, N - b * concurrency);
    await Promise.all(Array.from({ length: sz }, () => doOne()));
  }
  return { latency: calcLatency(latencies), totalMs: performance.now() - start };
}

// ── Table printer ─────────────────────────────────────────────────────────────

const W = 78; // inner width (between ║ ║)

function box(char: string): void {
  process.stdout.write(`║  ${char.padEnd(W - 4)}  ║\n`);
}

function boxRow(c1: string, c2: string, c3: string, c4: string): void {
  const col1 = c1.padEnd(24);
  const col2 = c2.padStart(13);
  const col3 = c3.padStart(13);
  const col4 = c4.padStart(16);
  process.stdout.write(`║  ${col1} │ ${col2} │ ${col3} │ ${col4}  ║\n`);
}

function boxSep(): void {
  const line = `─`.repeat(26) + `┼` + `─`.repeat(15) + `┼` + `─`.repeat(15) + `┼` + `─`.repeat(18);
  process.stdout.write(`║  ${line}  ║\n`);
}

function sectionHeader(title: string): void {
  box('');
  box(`  ${title}`);
  boxSep();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const nodeVersion = process.version;
  const date = new Date().toISOString().slice(0, 10);

  console.log('\nRunning MCP Conduit benchmark...\n');

  const allResults: ScenarioResult[] = [];

  // ────────────────────────────────────────────────────────────────────────────
  // A. LATENCY COMPARISON — passthrough, cache-hit, cache-miss at 5/20/50ms
  // ────────────────────────────────────────────────────────────────────────────

  const latencyResults: Array<{
    label: string;
    backendMs: number;
    scenario: 'passthrough' | 'cache-hit' | 'cache-miss';
    direct: LatencyResult;
    gateway: LatencyResult;
  }> = [];

  for (const backendMs of [5, 20, 50]) {
    const backend = await startMockBackend(backendMs);
    resetMetrics();

    // Passthrough uses cache-DISABLED config so every request reaches backend
    const gwPassthrough = new ConduitGateway(makeConfig(backend.url, {
      auth: true, acl: true, rateLimit: true, cache: false, circuitBreaker: true,
    }));
    await gwPassthrough.initialize();
    const appPassthrough = gwPassthrough.createApp();
    const authHeader = { Authorization: 'Bearer bench-key' };

    const callBody = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'bench_tool', arguments: { id: 'latency-test' } },
    };

    // Passthrough (cache disabled — every request goes to backend)
    {
      backend.resetCallCount();
      const { latency: d } = await runDirect(backend.url, callBody, 100, 1, 5);
      const { latency: g } = await runGateway(appPassthrough, callBody, 100, 1, 5, authHeader);
      latencyResults.push({ label: 'Passthrough (no cache)', backendMs, scenario: 'passthrough', direct: d, gateway: g });
      allResults.push({ name: `passthrough [${backendMs}ms]`, direct: d, gateway: g, deltaP50: g.p50 - d.p50 });
    }

    gwPassthrough.stop();

    // Cache tests use cache-ENABLED config
    const gwCached = new ConduitGateway(makeFullConfig(backend.url));
    await gwCached.initialize();
    const appCached = gwCached.createApp();

    // Cache HIT (same key, pre-warmed)
    {
      // Warm the cache
      for (let i = 0; i < 5; i++) {
        await appCached.request('/mcp/bench', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify(callBody),
        });
      }
      backend.resetCallCount();
      const { latency: d } = await runDirect(backend.url, callBody, 200, 1, 5);
      const { latency: g } = await runGateway(appCached, callBody, 200, 1, 5, authHeader);
      latencyResults.push({ label: 'Cache HIT', backendMs, scenario: 'cache-hit', direct: d, gateway: g });
      allResults.push({ name: `cache-hit [${backendMs}ms]`, direct: d, gateway: g, deltaP50: g.p50 - d.p50 });
    }

    // Cache MISS (unique arg each time — never hits cache)
    {
      const directMissLatencies: number[] = [];
      const gwMissLatencies: number[] = [];
      for (let i = 0; i < 80; i++) {
        const directBody = { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'bench_tool', arguments: { id: `dmiss-${i}` } } };
        const t1 = performance.now();
        await fetch(backend.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(directBody) });
        directMissLatencies.push(performance.now() - t1);

        const gwBody = { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'bench_tool', arguments: { id: `gmiss-${i}` } } };
        const t2 = performance.now();
        await appCached.request('/mcp/bench', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader }, body: JSON.stringify(gwBody) });
        gwMissLatencies.push(performance.now() - t2);
      }
      const d = calcLatency(directMissLatencies);
      const g = calcLatency(gwMissLatencies);
      latencyResults.push({ label: 'Cache MISS', backendMs, scenario: 'cache-miss', direct: d, gateway: g });
      allResults.push({ name: `cache-miss [${backendMs}ms]`, direct: d, gateway: g, deltaP50: g.p50 - d.p50 });
    }

    gwCached.stop();
    await backend.close();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // B. THROUGHPUT COMPARISON — sequential, concurrent, mixed at 5ms backend
  // ────────────────────────────────────────────────────────────────────────────

  const throughputResults: ScenarioResult[] = [];

  {
    const backend = await startMockBackend(5);
    resetMetrics();
    const gw = new ConduitGateway(makeFullConfig(backend.url));
    await gw.initialize();
    const app = gw.createApp();
    const authHeader = { Authorization: 'Bearer bench-key' };

    const callBody = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'bench_tool', arguments: { id: 'tp-cached' } },
    };

    // Pre-warm cache
    await app.request('/mcp/bench', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify(callBody),
    });

    // Sequential reads (500×)
    {
      const N = 500;
      const { latency: d, totalMs: dMs } = await runDirect(backend.url, callBody, N, 1, 5);
      backend.resetCallCount();
      const { latency: g, totalMs: gMs } = await runGateway(app, callBody, N, 1, 5, authHeader);
      const upstream = backend.getCallCount();
      const r: ScenarioResult = {
        name: 'Sequential (500×)',
        direct: d, gateway: g,
        deltaP50: g.p50 - d.p50,
        throughputDirect: (N / dMs) * 1000,
        throughputGateway: (N / gMs) * 1000,
        throughputMultiplier: dMs / gMs,
        upstreamCallsDirect: N,
        upstreamCallsGateway: upstream,
        upstreamSaved: N - upstream,
        upstreamSavedPct: ((N - upstream) / N) * 100,
      };
      throughputResults.push(r);
      allResults.push(r);
    }

    // Concurrent reads (50 concurrent × 10 batches = 500)
    {
      gw.getCacheStore().clear();
      await app.request('/mcp/bench', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(callBody),
      });
      const N = 500;
      const { latency: d, totalMs: dMs } = await runDirect(backend.url, callBody, N, 50, 10);
      backend.resetCallCount();
      const { latency: g, totalMs: gMs } = await runGateway(app, callBody, N, 50, 10, authHeader);
      const upstream = backend.getCallCount();
      const r: ScenarioResult = {
        name: 'Concurrent (50×10)',
        direct: d, gateway: g,
        deltaP50: g.p50 - d.p50,
        throughputDirect: (N / dMs) * 1000,
        throughputGateway: (N / gMs) * 1000,
        throughputMultiplier: dMs / gMs,
        upstreamCallsDirect: N,
        upstreamCallsGateway: upstream,
        upstreamSaved: N - upstream,
        upstreamSavedPct: ((N - upstream) / N) * 100,
      };
      throughputResults.push(r);
      allResults.push(r);
    }

    // Mixed workload (500: 70% cached, 20% new, 10% tools/list)
    {
      gw.getCacheStore().clear();
      // Pre-warm 20 entries
      for (let i = 0; i < 20; i++) {
        await app.request('/mcp/bench', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'bench_tool', arguments: { id: `warm-${i}` } } }),
        });
      }
      backend.resetCallCount();

      const N = 500;
      const latencies: number[] = [];
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        const r = Math.random();
        let msg: unknown;
        if (r < 0.7) {
          msg = { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'bench_tool', arguments: { id: `warm-${i % 20}` } } };
        } else if (r < 0.9) {
          msg = { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'bench_tool', arguments: { id: `new-${i}` } } };
        } else {
          msg = { jsonrpc: '2.0', id: i, method: 'tools/list', params: {} };
        }
        const t = performance.now();
        await app.request('/mcp/bench', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify(msg),
        });
        latencies.push(performance.now() - t);
      }
      const totalMs = performance.now() - start;
      const upstream = backend.getCallCount();
      const r: ScenarioResult = {
        name: 'Mixed (500: 70/20/10%)',
        gateway: calcLatency(latencies),
        throughputGateway: (N / totalMs) * 1000,
        upstreamCallsGateway: upstream,
        upstreamSaved: N - upstream,
        upstreamSavedPct: ((N - upstream) / N) * 100,
      };
      throughputResults.push(r);
      allResults.push(r);
    }

    gw.stop();
    await backend.close();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // C. PIPELINE OVERHEAD — individual modules vs full pipeline vs disabled
  // ────────────────────────────────────────────────────────────────────────────

  interface OverheadEntry {
    label: string;
    p50: number;
    delta: number;
  }
  const overheadResults: OverheadEntry[] = [];

  {
    const backend = await startMockBackend(5);

    const callBody = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'bench_tool', arguments: { id: 'oh-1' } },
    };

    // All configs have cache=true and are pre-warmed — we measure module
    // overhead on top of a cache hit (the latency that users actually see
    // when the gateway is doing its job). Baseline = cache only.
    const configs: Array<{ label: string; features: GatewayFeatures; authHeaders?: Record<string, string> }> = [
      { label: 'Cache only (baseline)',      features: { auth: false, acl: false, rateLimit: false, cache: true, circuitBreaker: false } },
      { label: 'Cache + Auth',               features: { auth: true,  acl: false, rateLimit: false, cache: true, circuitBreaker: false }, authHeaders: { Authorization: 'Bearer bench-key' } },
      { label: 'Cache + ACL',                features: { auth: false, acl: true,  rateLimit: false, cache: true, circuitBreaker: false } },
      { label: 'Cache + Rate-limit',         features: { auth: false, acl: false, rateLimit: true,  cache: true, circuitBreaker: false } },
      { label: 'Full pipeline (all ON)',     features: { auth: true,  acl: true,  rateLimit: true,  cache: true, circuitBreaker: true  }, authHeaders: { Authorization: 'Bearer bench-key' } },
      { label: 'No cache (raw passthrough)', features: { auth: false, acl: false, rateLimit: false, cache: false, circuitBreaker: false } },
    ];

    for (const { label, features, authHeaders } of configs) {
      resetMetrics();
      const gw = new ConduitGateway(makeConfig(backend.url, features));
      await gw.initialize();
      const app = gw.createApp();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(authHeaders ?? {}),
      };

      // Pre-warm cache for all cache-enabled configs
      if (features.cache) {
        for (let i = 0; i < 5; i++) {
          await app.request('/mcp/bench', { method: 'POST', headers, body: JSON.stringify(callBody) });
        }
      }

      const N = 300;
      const latencies: number[] = [];
      const bodyStr = JSON.stringify(callBody);
      for (let i = 0; i < N; i++) {
        const t = performance.now();
        await app.request('/mcp/bench', { method: 'POST', headers, body: bodyStr });
        latencies.push(performance.now() - t);
      }
      const res = calcLatency(latencies);
      overheadResults.push({ label, p50: res.p50, delta: 0 }); // delta filled after
      allResults.push({ name: `overhead: ${label}`, gateway: res });
      gw.stop();
    }

    // Compute deltas relative to baseline (cache only)
    const baselineP50 = overheadResults[0]?.p50 ?? 0;
    for (const e of overheadResults) {
      e.delta = e.p50 - baselineP50;
    }

    await backend.close();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // D/E. UPSTREAM SAVINGS + BACKEND LATENCY IMPACT
  // ────────────────────────────────────────────────────────────────────────────

  // (already captured in latencyResults and throughputResults above)

  // ────────────────────────────────────────────────────────────────────────────
  // OUTPUT
  // ────────────────────────────────────────────────────────────────────────────

  const OUTER = '═'.repeat(W);
  console.log(`\n╔${OUTER}╗`);
  {
    const title = 'MCP CONDUIT — PRODUCTION BENCHMARK';
    const sub = `Date: ${date}  Node: ${nodeVersion}`;
    box('');
    box(title);
    box(sub);
  }

  // ── A. Latency ──────────────────────────────────────────────────────────────
  sectionHeader('LATENCY (ms)  p50 / p95');
  boxRow('Scenario', 'Direct', 'Gateway', 'Δ p50');
  boxSep();

  const latencyScenarios = ['Passthrough (no cache)', 'Cache HIT', 'Cache MISS'];
  for (const scenario of latencyScenarios) {
    for (const backendMs of [5, 20, 50]) {
      const entry = latencyResults.find((r) => r.label === scenario && r.backendMs === backendMs);
      if (!entry) continue;
      const d = `${fmtMs(entry.direct.p50)} / ${fmtMs(entry.direct.p95)}`;
      const g = `${fmtMs(entry.gateway.p50)} / ${fmtMs(entry.gateway.p95)}`;
      const delta = entry.gateway.p50 - entry.direct.p50;
      const deltaStr = delta >= 0 ? `+${fmtMsFixed(delta)}` : fmtMsFixed(delta);
      boxRow(`  ${scenario} [${backendMs}ms]`, d, g, deltaStr);
    }
  }

  // ── B. Throughput ───────────────────────────────────────────────────────────
  sectionHeader('THROUGHPUT (req/s)');
  boxRow('Scenario', 'Direct', 'Gateway', 'Speedup');
  boxSep();

  for (const r of throughputResults) {
    const d = r.throughputDirect ? `${fmt(r.throughputDirect, 0)}` : '—';
    const g = r.throughputGateway ? `${fmt(r.throughputGateway, 0)}` : '—';
    const m = r.throughputMultiplier ? `${fmt(r.throughputMultiplier, 1)}x` : '—';
    boxRow(`  ${r.name}`, d, g, m);
  }

  // ── C. Pipeline overhead ────────────────────────────────────────────────────
  sectionHeader('PIPELINE OVERHEAD  (p50, cache-warm, 5ms backend)');
  boxRow('Module config', '', 'Latency (p50)', 'vs passthrough');
  boxSep();

  for (const e of overheadResults) {
    const deltaStr = e.delta === 0
      ? '(baseline)'
      : (e.delta >= 0 ? `+${fmtMsFixed(e.delta)}` : fmtMsFixed(e.delta));
    boxRow(`  ${e.label}`, '', fmtMsFixed(e.p50), deltaStr);
  }

  // ── D. Upstream savings ─────────────────────────────────────────────────────
  sectionHeader('UPSTREAM SAVINGS');
  boxRow('Scenario', 'Total reqs', 'Upstream calls', '% saved');
  boxSep();

  for (const r of throughputResults) {
    if (r.upstreamSaved === undefined) continue;
    const total = String((r.upstreamCallsGateway ?? 0) + (r.upstreamSaved ?? 0));
    const upstream = String(r.upstreamCallsGateway ?? 0);
    const pct = r.upstreamSavedPct !== undefined ? `${fmt(r.upstreamSavedPct, 1)}%` : '—';
    boxRow(`  ${r.name}`, total, upstream, pct);
  }

  // ── E. Backend latency impact ───────────────────────────────────────────────
  sectionHeader('BACKEND LATENCY IMPACT  (Cache HIT p50 / speedup)');
  boxRow('Scenario', '5ms backend', '20ms backend', '50ms backend');
  boxSep();

  for (const scenario of (['Cache HIT'] as const)) {
    const hits = latencyResults.filter((r) => r.label === scenario);
    const vals = hits.map((h) => {
      const speedup = h.direct.p50 / Math.max(0.01, h.gateway.p50);
      return `${fmtMs(h.gateway.p50)} (${fmt(speedup, 1)}x)`;
    });
    boxRow(`  ${scenario} p50 (speedup)`, vals[0] ?? '—', vals[1] ?? '—', vals[2] ?? '—');
  }

  box('');
  console.log(`╚${OUTER}╝\n`);

  // Save JSON
  const outPath = 'benchmark-results.json';
  writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    node_version: nodeVersion,
    latency: allResults.filter((r) => r.name.startsWith('cold') || r.name.startsWith('cache')),
    throughput: throughputResults,
    overhead: overheadResults,
    all: allResults,
  }, null, 2));
  console.log(`Results saved to ${outPath}\n`);
}

main().catch((err) => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
