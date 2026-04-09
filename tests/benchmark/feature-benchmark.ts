/**
 * Benchmark complet des nouvelles features.
 * Mesure le throughput et la latence de chaque composant.
 *
 * Usage : npx tsx tests/benchmark/feature-benchmark.ts
 */

import { resolve } from 'node:path';
import { ConduitGateway } from '../../src/gateway/gateway.js';
import { startMockMcpServer } from '../e2e/mock-mcp-server.js';
import { StdioMcpClient } from '../../src/proxy/stdio-mcp-client.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { HttpRegistryBackend } from '../../src/discovery/http-registry.js';
import { resetMetrics } from '../../src/observability/metrics.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';

const MOCK_STDIO_SERVER = resolve(import.meta.dirname, '../e2e/mock-stdio-server.ts');

interface BenchResult {
  name: string;
  ops: number;
  totalMs: number;
  rps: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

async function bench(name: string, ops: number, fn: (i: number) => Promise<void>): Promise<BenchResult> {
  const latencies: number[] = [];

  // Warmup
  for (let i = 0; i < Math.min(10, ops); i++) {
    await fn(i);
  }

  const start = performance.now();
  for (let i = 0; i < ops; i++) {
    const t0 = performance.now();
    await fn(i);
    latencies.push(performance.now() - t0);
  }
  const totalMs = performance.now() - start;

  latencies.sort((a, b) => a - b);
  const rps = (ops / totalMs) * 1000;

  return {
    name,
    ops,
    totalMs,
    rps,
    avgMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
  };
}

async function benchConcurrent(name: string, ops: number, concurrency: number, fn: (i: number) => Promise<void>): Promise<BenchResult> {
  const latencies: number[] = [];

  const start = performance.now();
  let idx = 0;

  async function worker() {
    while (idx < ops) {
      const i = idx++;
      const t0 = performance.now();
      await fn(i);
      latencies.push(performance.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const totalMs = performance.now() - start;

  latencies.sort((a, b) => a - b);
  const rps = (ops / totalMs) * 1000;

  return {
    name,
    ops,
    totalMs,
    rps,
    avgMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
  };
}

function printResults(results: BenchResult[]) {
  console.log('\n┌────────────────────────────────────────────────────────────────────────────────────────┐');
  console.log('│              MCP Conduit — Feature Benchmark Results                             │');
  console.log('├────────────────────────────────────────────────────────────────────────────────────────┤');
  console.log('│ Scénario                                  RPS    Avg(ms)    P50     P95     P99   Ops  │');
  console.log('├────────────────────────────────────────────────────────────────────────────────────────┤');
  for (const r of results) {
    const name = r.name.padEnd(40);
    const rps = r.rps.toFixed(0).padStart(6);
    const avg = r.avgMs.toFixed(2).padStart(9);
    const p50 = r.p50Ms.toFixed(2).padStart(7);
    const p95 = r.p95Ms.toFixed(2).padStart(7);
    const p99 = r.p99Ms.toFixed(2).padStart(7);
    const ops = String(r.ops).padStart(5);
    console.log(`│ ${name} ${rps} ${avg} ${p50} ${p95} ${p99} ${ops}  │`);
  }
  console.log('└────────────────────────────────────────────────────────────────────────────────────────┘\n');
}

async function main() {
  console.log('Starting MCP Conduit Feature Benchmark...\n');
  const results: BenchResult[] = [];

  // ─── Setup ──────────────────────────────────────────────────────────
  const mockServer = await startMockMcpServer(0);
  console.log(`Mock HTTP server: ${mockServer.url}`);

  // ─── 1. HTTP Gateway baseline ──────────────────────────────────────
  {
    resetMetrics();
    const config: ConduitGatewayConfig = {
      gateway: { port: 0, host: '127.0.0.1' },
      router: { namespace_strategy: 'none', health_check: { enabled: false, interval_seconds: 60, timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1 } },
      servers: [{ id: 'bench', url: mockServer.url, cache: { default_ttl: 300 } }],
      cache: { enabled: true, l1: { max_entries: 10000, max_entry_size_kb: 256 } },
      tenant_isolation: { enabled: false, header: 'Authorization' },
      observability: { log_args: false, log_responses: false, redact_fields: [], retention_days: 1, db_path: ':memory:' },
      metrics: { enabled: false, port: 0 },
    };
    const gw = new ConduitGateway(config);
    await gw.initialize();
    const app = gw.createApp();

    results.push(await bench('HTTP tools/call (cache MISS)', 500, async (i) => {
      await app.request('/mcp/bench', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'get_contact', arguments: { id: `miss-${i}` } } }),
      });
    }));

    results.push(await bench('HTTP tools/call (cache HIT)', 1000, async (i) => {
      await app.request('/mcp/bench', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'get_contact', arguments: { id: 'cached' } } }),
      });
    }));

    results.push(await benchConcurrent('HTTP concurrent (c=20)', 500, 20, async (i) => {
      await app.request('/mcp/bench', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'get_contact', arguments: { id: 'concurrent' } } }),
      });
    }));

    await gw.stop(1000);
  }

  // ─── 2. Stdio transport ────────────────────────────────────────────
  {
    const stdio = new StdioMcpClient({
      id: 'bench-stdio', url: 'stdio://npx', transport: 'stdio',
      command: 'npx', args: ['tsx', MOCK_STDIO_SERVER],
      cache: { default_ttl: 0 },
    });

    results.push(await bench('Stdio tools/call (sequential)', 200, async (i) => {
      await stdio.forward({
        body: { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'add', arguments: { a: i, b: 1 } } },
      });
    }));

    results.push(await benchConcurrent('Stdio tools/call (c=10)', 200, 10, async (i) => {
      await stdio.forward({
        body: { jsonrpc: '2.0', id: 10000 + i, method: 'tools/call', params: { name: 'echo', arguments: { message: `msg-${i}` } } },
      });
    }));

    await stdio.shutdown();
  }

  // ─── 3. Plugin registry overhead ───────────────────────────────────
  {
    const registry = new PluginRegistry();
    for (let p = 0; p < 5; p++) {
      registry.register({
        name: `bench-plugin-${p}`,
        hooks: {
          'before:request': async (ctx) => { ctx.metadata[`p${p}`] = true; },
        },
      });
    }

    const ctx = {
      serverId: 'test', method: 'tools/call', clientId: 'c1',
      traceId: 'trace', message: { jsonrpc: '2.0' as const, id: 1, method: 'tools/call' },
      extraHeaders: {}, metadata: {} as Record<string, unknown>,
    };

    results.push(await bench('Plugin hooks (5 plugins × 1 hook)', 10000, async () => {
      ctx.metadata = {};
      await registry.runHook('before:request', ctx);
    }));
  }

  // ─── 4. Discovery reconciliation ───────────────────────────────────
  {
    const backend = new HttpRegistryBackend(60);

    results.push(await bench('Discovery register + poll', 5000, async (i) => {
      backend.register({ id: `bench-${i % 100}`, url: `http://srv-${i % 100}:3000/mcp` });
      await backend.poll();
    }));
  }

  // ─── 5. HTTP Gateway with plugins ──────────────────────────────────
  {
    resetMetrics();
    const config: ConduitGatewayConfig = {
      gateway: { port: 0, host: '127.0.0.1' },
      router: { namespace_strategy: 'none', health_check: { enabled: false, interval_seconds: 60, timeout_ms: 1000, unhealthy_threshold: 3, healthy_threshold: 1 } },
      servers: [{ id: 'bench', url: mockServer.url, cache: { default_ttl: 300 } }],
      cache: { enabled: true, l1: { max_entries: 10000, max_entry_size_kb: 256 } },
      tenant_isolation: { enabled: false, header: 'Authorization' },
      observability: { log_args: false, log_responses: false, redact_fields: [], retention_days: 1, db_path: ':memory:' },
      metrics: { enabled: false, port: 0 },
    };
    const gw = new ConduitGateway(config);
    await gw.initialize();

    const pluginRegistry = new PluginRegistry();
    for (let p = 0; p < 5; p++) {
      pluginRegistry.register({
        name: `noop-${p}`,
        hooks: { 'before:request': async () => {}, 'after:upstream': async () => {} },
      });
    }
    // @ts-expect-error — accès pipeline privé
    gw['pipeline'].setPluginRegistry(pluginRegistry);
    const app = gw.createApp();

    results.push(await bench('HTTP + 5 plugins (cache HIT)', 1000, async (i) => {
      await app.request('/mcp/bench', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'get_contact', arguments: { id: 'with-plugins' } } }),
      });
    }));

    await gw.stop(1000);
  }

  // ─── Print results ─────────────────────────────────────────────────
  await mockServer.close();
  printResults(results);
}

main().catch(console.error);
