#!/usr/bin/env npx tsx
/**
 * MCP Conduit — Full Benchmark Suite
 *
 * Benchmark unifié couvrant tous les composants et scénarios :
 *
 *   Section 1 — Baseline & Overhead
 *     Direct backend vs Gateway passthrough (mesure l'overhead ajouté)
 *
 *   Section 2 — Cache Performance
 *     L1 MISS, L1 HIT, cache invalidation throughput
 *
 *   Section 3 — Concurrency Scaling
 *     c=1, c=10, c=50, c=100 — comment le throughput évolue
 *
 *   Section 4 — Transport Comparison
 *     HTTP vs stdio (séquentiel et concurrent)
 *
 *   Section 5 — Feature Overhead
 *     Baseline vs +auth vs +plugins vs +all features
 *
 *   Section 6 — Component Microbenchmarks
 *     Cache key gen, redactor, plugin hooks, dedup, discovery
 *
 * Usage :
 *   npx tsx tests/benchmark/full-benchmark.ts
 *   npx tsx tests/benchmark/full-benchmark.ts --json    # export JSON
 *   npx tsx tests/benchmark/full-benchmark.ts --quick   # mode rapide
 *
 * @module
 */

import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { StdioMcpClient } from '../../src/proxy/stdio-mcp-client.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { HttpRegistryBackend } from '../../src/discovery/http-registry.js';
import { CacheStore } from '../../src/cache/cache-store.js';
import { InflightTracker } from '../../src/cache/inflight.js';
import { generateCacheKey } from '../../src/cache/cache-key.js';
import { redact, createRedactor } from '../../src/observability/redactor.js';
import { startMockMcpServer, type MockMcpServer } from '../e2e/mock-mcp-server.js';
import { resetMetrics } from '../../src/observability/metrics.js';

const MOCK_STDIO_SERVER = resolve(import.meta.dirname, '../e2e/mock-stdio-server.ts');
const QUICK_MODE = process.argv.includes('--quick');
const JSON_MODE = process.argv.includes('--json');

// ─── Scale factors ────────────────────────────────────────────────────
const N = QUICK_MODE ? 200 : 1000;      // ops per scenario
const N_MICRO = QUICK_MODE ? 5000 : 50000; // ops for microbenchmarks
const WARMUP = QUICK_MODE ? 5 : 20;

// ─── Types ────────────────────────────────────────────────────────────

interface Latency {
  avg: number; p50: number; p95: number; p99: number; min: number; max: number;
}

interface BenchResult {
  section: string;
  name: string;
  ops: number;
  rps: number;
  latency: Latency;
  errors: number;
  memDeltaKb: number;
}

// ─── Benchmark engine ─────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

function heapKb(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024);
}

async function bench(
  section: string,
  name: string,
  ops: number,
  fn: (i: number) => Promise<void>,
  warmup = WARMUP,
): Promise<BenchResult> {
  // Warmup
  for (let i = 0; i < warmup; i++) await fn(i);

  global.gc?.(); // optional GC if --expose-gc
  const heapBefore = heapKb();
  const latencies: number[] = [];
  let errors = 0;

  const start = performance.now();
  for (let i = 0; i < ops; i++) {
    const t0 = performance.now();
    try {
      await fn(i);
    } catch {
      errors++;
    }
    latencies.push(performance.now() - t0);
  }
  const totalMs = performance.now() - start;
  const heapAfter = heapKb();

  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  return {
    section, name, ops, errors,
    rps: (ops / totalMs) * 1000,
    latency: {
      avg, p50: percentile(latencies, 50), p95: percentile(latencies, 95),
      p99: percentile(latencies, 99), min: latencies[0] ?? 0, max: latencies[latencies.length - 1] ?? 0,
    },
    memDeltaKb: heapAfter - heapBefore,
  };
}

async function benchConcurrent(
  section: string,
  name: string,
  ops: number,
  concurrency: number,
  fn: (i: number) => Promise<void>,
): Promise<BenchResult> {
  // Warmup
  for (let i = 0; i < WARMUP; i++) await fn(i);

  global.gc?.();
  const heapBefore = heapKb();
  const latencies: number[] = [];
  let errors = 0;
  let idx = 0;

  async function worker() {
    while (idx < ops) {
      const i = idx++;
      const t0 = performance.now();
      try { await fn(i); } catch { errors++; }
      latencies.push(performance.now() - t0);
    }
  }

  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const totalMs = performance.now() - start;
  const heapAfter = heapKb();

  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  return {
    section, name, ops, errors,
    rps: (ops / totalMs) * 1000,
    latency: {
      avg, p50: percentile(latencies, 50), p95: percentile(latencies, 95),
      p99: percentile(latencies, 99), min: latencies[0] ?? 0, max: latencies[latencies.length - 1] ?? 0,
    },
    memDeltaKb: heapAfter - heapBefore,
  };
}

// ─── Gateway factory ──────────────────────────────────────────────────

function makeConfig(mockUrl: string, overrides: Partial<ConduitGatewayConfig> = {}): ConduitGatewayConfig {
  return {
    gateway: { port: 0, host: '127.0.0.1' },
    router: { namespace_strategy: 'none', health_check: { enabled: false, interval_seconds: 60, timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1 } },
    servers: [{ id: 'bench', url: mockUrl, cache: { default_ttl: 300 } }],
    cache: { enabled: true, l1: { max_entries: 50000, max_entry_size_kb: 256 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: { log_args: false, log_responses: false, redact_fields: [], retention_days: 1, db_path: ':memory:' },
    metrics: { enabled: false, port: 0 },
    ...overrides,
  };
}

async function makeGateway(mockUrl: string, overrides: Partial<ConduitGatewayConfig> = {}) {
  resetMetrics();
  const gw = new ConduitGateway(makeConfig(mockUrl, overrides));
  await gw.initialize();
  return gw;
}

function toolCall(name: string, args: Record<string, unknown>, id: number | string = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

function postReq(app: { request: Function }, serverId: string, body: string) {
  return app.request(`/mcp/${serverId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }) as Promise<Response>;
}

// ─── Direct backend (no gateway) ──────────────────────────────────────

async function directBackendCall(url: string, body: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  await res.json();
}

// ─── Rendering ────────────────────────────────────────────────────────

function histogramBar(value: number, max: number, width = 20): string {
  const filled = Math.round((value / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function printResults(results: BenchResult[]) {
  let currentSection = '';
  const maxRps = Math.max(...results.map((r) => r.rps));

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                        MCP Conduit — Full Benchmark Report                               ║');
  console.log('║                        ' + new Date().toISOString().slice(0, 19) + '                                                  ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════════════════════╣');

  for (const r of results) {
    if (r.section !== currentSection) {
      currentSection = r.section;
      console.log('╠══════════════════════════════════════════════════════════════════════════════════════════════════╣');
      console.log(`║  ${currentSection.toUpperCase().padEnd(92)}║`);
      console.log('╠══════════════════════════════════════════════════════════════════════════════════════════════════╣');
      console.log(`║  ${'Scenario'.padEnd(34)} ${'RPS'.padStart(8)} ${'Avg'.padStart(8)} ${'P50'.padStart(7)} ${'P95'.padStart(7)} ${'P99'.padStart(7)} ${'Mem'.padStart(7)} ${'Bar'.padStart(5)}      ║`);
      console.log('╟──────────────────────────────────────────────────────────────────────────────────────────────────╢');
    }

    const nm = r.name.padEnd(34).slice(0, 34);
    const rps = r.rps >= 1000000 ? `${(r.rps / 1000000).toFixed(1)}M`.padStart(8)
      : r.rps >= 1000 ? `${(r.rps / 1000).toFixed(1)}K`.padStart(8)
      : r.rps.toFixed(0).padStart(8);
    const avg = r.latency.avg < 0.01 ? '<0.01'.padStart(8) : `${r.latency.avg.toFixed(2)}ms`.padStart(8);
    const p50 = `${r.latency.p50.toFixed(2)}`.padStart(7);
    const p95 = `${r.latency.p95.toFixed(2)}`.padStart(7);
    const p99 = `${r.latency.p99.toFixed(2)}`.padStart(7);
    const mem = r.memDeltaKb > 0 ? `+${r.memDeltaKb}K`.padStart(7) : `${r.memDeltaKb}K`.padStart(7);
    const bar = histogramBar(r.rps, maxRps, 8);
    const err = r.errors > 0 ? ` [${r.errors}err]` : '';

    console.log(`║  ${nm} ${rps} ${avg} ${p50} ${p95} ${p99} ${mem} ${bar}${err} ║`);
  }

  console.log('╚══════════════════════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`MCP Conduit — Full Benchmark Suite ${QUICK_MODE ? '(quick mode)' : ''}`);
  console.log(`Ops per scenario: ${N} | Micro ops: ${N_MICRO} | Warmup: ${WARMUP}\n`);

  const results: BenchResult[] = [];
  const mockServer = await startMockMcpServer(0);
  console.log(`Mock server: ${mockServer.url}\n`);

  // ═══════════════════════════════════════════════════════════════════
  // Section 1 — Baseline & Overhead
  // ═══════════════════════════════════════════════════════════════════
  {
    console.log('Section 1/6: Baseline & Overhead...');
    const body = toolCall('get_contact', { id: 'baseline' });

    // Direct backend (no gateway)
    results.push(await bench('1. Baseline & Overhead', 'Direct backend (no gateway)', N, async () => {
      await directBackendCall(mockServer.url, body);
    }));

    // Gateway passthrough
    const gw = await makeGateway(mockServer.url);
    const app = gw.createApp();

    results.push(await bench('1. Baseline & Overhead', 'Gateway passthrough (initialize)', N, async (i) => {
      await postReq(app, 'bench', JSON.stringify({ jsonrpc: '2.0', id: i, method: 'initialize', params: {} }));
    }));

    results.push(await bench('1. Baseline & Overhead', 'Gateway tools/call (MISS)', N, async (i) => {
      await postReq(app, 'bench', toolCall('get_contact', { id: `miss-${i}` }, i));
    }));

    await gw.stop(1000);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Section 2 — Cache Performance
  // ═══════════════════════════════════════════════════════════════════
  {
    console.log('Section 2/6: Cache Performance...');
    const gw = await makeGateway(mockServer.url);
    const app = gw.createApp();

    // Prime cache
    await postReq(app, 'bench', toolCall('get_contact', { id: 'cached' }));

    results.push(await bench('2. Cache Performance', 'L1 cache HIT', N * 2, async (i) => {
      await postReq(app, 'bench', toolCall('get_contact', { id: 'cached' }, i));
    }));

    // Unique args → always MISS
    results.push(await bench('2. Cache Performance', 'L1 cache MISS (unique args)', N, async (i) => {
      await postReq(app, 'bench', toolCall('get_contact', { id: `unique-${i}` }, i));
    }));

    // Cache invalidation throughput
    const store = gw.getCacheStore();
    for (let i = 0; i < 1000; i++) {
      store.set(`bench-key-${i}`, { result: { v: i }, createdAt: Date.now(), ttl: 300, toolName: 'tool', serverId: 'bench' });
    }
    results.push(await bench('2. Cache Performance', 'Cache invalidation (1000 keys)', 100, async () => {
      store.deleteByServer('bench');
      // Refill for next iteration
      for (let i = 0; i < 1000; i++) {
        store.set(`bench-key-${i}`, { result: { v: i }, createdAt: Date.now(), ttl: 300, toolName: 'tool', serverId: 'bench' });
      }
    }, 2));

    await gw.stop(1000);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Section 3 — Concurrency Scaling
  // ═══════════════════════════════════════════════════════════════════
  {
    console.log('Section 3/6: Concurrency Scaling...');
    const gw = await makeGateway(mockServer.url);
    const app = gw.createApp();
    await postReq(app, 'bench', toolCall('get_contact', { id: 'scale' }));
    const body = toolCall('get_contact', { id: 'scale' });

    for (const c of [1, 10, 50, 100]) {
      results.push(await benchConcurrent('3. Concurrency Scaling', `Cache HIT c=${c}`, N, c, async (i) => {
        await postReq(app, 'bench', body);
      }));
    }

    // MISS with concurrency (tests dedup)
    results.push(await benchConcurrent('3. Concurrency Scaling', 'Cache MISS c=20 (dedup)', N, 20, async (i) => {
      await postReq(app, 'bench', toolCall('get_contact', { id: `dedup-${i % 10}` }, i));
    }));

    await gw.stop(1000);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Section 4 — Transport Comparison
  // ═══════════════════════════════════════════════════════════════════
  {
    console.log('Section 4/6: Transport Comparison...');
    const httpBody = toolCall('get_contact', { id: 'transport' });

    // HTTP sequential
    const gwHttp = await makeGateway(mockServer.url);
    const appHttp = gwHttp.createApp();
    results.push(await bench('4. Transport Comparison', 'HTTP sequential', N, async (i) => {
      await postReq(appHttp, 'bench', toolCall('get_contact', { id: `http-${i}` }, i));
    }));
    await gwHttp.stop(1000);

    // Stdio sequential
    const stdio = new StdioMcpClient({
      id: 'bench-stdio', url: 'stdio://npx', transport: 'stdio',
      command: 'npx', args: ['tsx', MOCK_STDIO_SERVER], cache: { default_ttl: 0 },
    });
    results.push(await bench('4. Transport Comparison', 'Stdio sequential', Math.min(N, 500), async (i) => {
      await stdio.forward({ body: { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'add', arguments: { a: i, b: 1 } } } });
    }));

    // Stdio concurrent
    results.push(await benchConcurrent('4. Transport Comparison', 'Stdio concurrent c=10', Math.min(N, 500), 10, async (i) => {
      await stdio.forward({ body: { jsonrpc: '2.0', id: 10000 + i, method: 'tools/call', params: { name: 'echo', arguments: { message: `m${i}` } } } });
    }));
    await stdio.shutdown();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Section 5 — Feature Overhead
  // ═══════════════════════════════════════════════════════════════════
  {
    console.log('Section 5/6: Feature Overhead...');

    // Baseline (no features)
    const gwBase = await makeGateway(mockServer.url);
    const appBase = gwBase.createApp();
    await postReq(appBase, 'bench', toolCall('get_contact', { id: 'feat' }));
    results.push(await bench('5. Feature Overhead', 'Baseline (cache only)', N, async (i) => {
      await postReq(appBase, 'bench', toolCall('get_contact', { id: 'feat' }, i));
    }));
    await gwBase.stop(1000);

    // With auth
    const gwAuth = await makeGateway(mockServer.url, {
      auth: { method: 'api_key', api_keys: ['bench-key-123'] },
    });
    const appAuth = gwAuth.createApp();
    await appAuth.request('/mcp/bench', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer bench-key-123' },
      body: toolCall('get_contact', { id: 'feat' }),
    });
    results.push(await bench('5. Feature Overhead', '+ Auth (api_key)', N, async (i) => {
      await appAuth.request('/mcp/bench', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer bench-key-123' },
        body: toolCall('get_contact', { id: 'feat' }, i),
      });
    }));
    await gwAuth.stop(1000);

    // With plugins (5 no-op)
    const gwPlug = await makeGateway(mockServer.url);
    const pluginReg = new PluginRegistry();
    for (let p = 0; p < 5; p++) {
      pluginReg.register({
        name: `bench-${p}`, hooks: {
          'before:request': async () => {},
          'after:auth': async () => {},
          'before:cache': async () => {},
          'after:upstream': async () => {},
          'before:response': async () => {},
        },
      });
    }
    // @ts-expect-error — private access
    gwPlug['pipeline'].setPluginRegistry(pluginReg);
    const appPlug = gwPlug.createApp();
    await postReq(appPlug, 'bench', toolCall('get_contact', { id: 'feat' }));
    results.push(await bench('5. Feature Overhead', '+ 5 Plugins (all hooks)', N, async (i) => {
      await postReq(appPlug, 'bench', toolCall('get_contact', { id: 'feat' }, i));
    }));
    await gwPlug.stop(1000);

    // With auth + plugins + rate limits
    const gwFull = await makeGateway(mockServer.url, {
      auth: { method: 'api_key', api_keys: ['bench-key-123'] },
      rate_limits: {
        enabled: true, backend: 'memory',
        global: { requests: 100000, window_seconds: 60 },
        per_client: { requests: 100000, window_seconds: 60 },
      },
    });
    const pluginRegFull = new PluginRegistry();
    for (let p = 0; p < 5; p++) {
      pluginRegFull.register({ name: `full-${p}`, hooks: { 'before:request': async () => {} } });
    }
    // @ts-expect-error — private access
    gwFull['pipeline'].setPluginRegistry(pluginRegFull);
    const appFull = gwFull.createApp();
    await appFull.request('/mcp/bench', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer bench-key-123' },
      body: toolCall('get_contact', { id: 'feat' }),
    });
    results.push(await bench('5. Feature Overhead', '+ Auth + Plugins + Rate Limit', N, async (i) => {
      await appFull.request('/mcp/bench', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer bench-key-123' },
        body: toolCall('get_contact', { id: 'feat' }, i),
      });
    }));
    await gwFull.stop(1000);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Section 6 — Component Microbenchmarks
  // ═══════════════════════════════════════════════════════════════════
  {
    console.log('Section 6/6: Component Microbenchmarks...');

    // Cache key generation
    results.push(await bench('6. Microbenchmarks', 'Cache key gen (SHA-256)', N_MICRO, async (i) => {
      generateCacheKey({ serverId: 'srv', toolName: 'tool', args: { query: `q-${i}`, page: i } });
    }, 100));

    // Redactor
    const redactor = createRedactor(['password', 'token', 'secret', 'api_key']);
    const sampleObj = { user: 'alice', password: 'secret', token: 'abc', nested: { api_key: 'key', data: [1, 2, 3] } };
    results.push(await bench('6. Microbenchmarks', 'Redactor (6 fields, nested)', N_MICRO, async () => {
      redactor(sampleObj);
    }, 100));

    // Plugin hook execution (5 plugins × 1 hook)
    const reg = new PluginRegistry();
    for (let p = 0; p < 5; p++) {
      reg.register({ name: `micro-${p}`, hooks: { 'before:request': async (ctx) => { ctx.metadata[`p${p}`] = true; } } });
    }
    const hookCtx = {
      serverId: 'test', method: 'tools/call', clientId: 'c1', traceId: 'trace',
      message: { jsonrpc: '2.0' as const, id: 1, method: 'tools/call' },
      extraHeaders: {}, metadata: {} as Record<string, unknown>,
    };
    results.push(await bench('6. Microbenchmarks', 'Plugin hooks (5 × before:req)', N_MICRO, async () => {
      hookCtx.metadata = {};
      await reg.runHook('before:request', hookCtx);
    }, 100));

    // Discovery register + poll
    const discBackend = new HttpRegistryBackend(60);
    results.push(await bench('6. Microbenchmarks', 'Discovery register + poll', N_MICRO, async (i) => {
      discBackend.register({ id: `srv-${i % 100}`, url: `http://srv-${i % 100}:3000` });
      await discBackend.poll();
    }, 100));

    // Inflight dedup (instant resolve)
    const tracker = new InflightTracker();
    results.push(await bench('6. Microbenchmarks', 'Inflight dedup (instant)', N_MICRO, async (i) => {
      await tracker.deduplicate(`key-${i}`, async () => ({ value: i }));
    }, 100));

    // CacheStore get (HIT)
    const cstore = new CacheStore({ max_entries: 10000, max_entry_size_kb: 64 });
    cstore.set('bench-hit', { result: { v: 1 }, createdAt: Date.now(), ttl: 9999, toolName: 't', serverId: 's' });
    results.push(await bench('6. Microbenchmarks', 'CacheStore.get (L1 HIT)', N_MICRO, async () => {
      cstore.get('bench-hit');
    }, 100));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Results
  // ═══════════════════════════════════════════════════════════════════
  await mockServer.close();

  printResults(results);

  // Summary
  const totalOps = results.reduce((s, r) => s + r.ops, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors, 0);
  console.log(`Total: ${results.length} scenarios | ${totalOps.toLocaleString()} operations | ${totalErrors} errors`);
  console.log(`Node ${process.version} | ${process.platform} ${process.arch}\n`);

  // JSON export
  if (JSON_MODE) {
    const report = {
      timestamp: new Date().toISOString(),
      node_version: process.version,
      platform: `${process.platform} ${process.arch}`,
      quick_mode: QUICK_MODE,
      results: results.map((r) => ({ ...r })),
    };
    const path = resolve(process.cwd(), 'benchmark-results.json');
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(`JSON report: ${path}`);
  }

  if (totalErrors > 0) {
    console.error(`WARNING: ${totalErrors} error(s) detected during benchmark.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal benchmark error:', err);
  process.exit(1);
});
