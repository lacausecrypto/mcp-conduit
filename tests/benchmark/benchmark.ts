/**
 * Benchmark de performance pour MCP Conduit.
 *
 * Mesure le débit et la latence de la passerelle dans différents scénarios :
 * - Passthrough pur (sans cache)
 * - Cache L1 HIT (réponse depuis la mémoire)
 * - Requêtes concurrentes avec déduplication inflight
 *
 * Usage :
 *   npx tsx tests/benchmark/benchmark.ts
 */

import { ConduitGateway } from '../../src/gateway/gateway.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';
import { startMockMcpServer } from '../e2e/mock-mcp-server.js';
import { resetMetrics } from '../../src/observability/metrics.js';

/** Résultat d'un scénario de benchmark */
interface BenchmarkResult {
  scenario: string;
  totalRequests: number;
  durationMs: number;
  throughputRps: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  errors: number;
}

/** Options d'un scénario de benchmark */
interface BenchmarkOptions {
  concurrency: number;
  iterations: number;
  warmupIterations?: number;
}

/**
 * Lance N requêtes avec une concurrence donnée et collecte les latences.
 */
async function runBenchmarkScenario(
  scenario: string,
  app: { request: (url: string, init?: RequestInit) => Promise<Response> },
  serverId: string,
  body: unknown,
  options: BenchmarkOptions,
): Promise<BenchmarkResult> {
  const { concurrency, iterations, warmupIterations = 10 } = options;
  const latencies: number[] = [];
  let errors = 0;

  const requestBody = JSON.stringify(body);

  /**
   * Envoie une requête et mesure sa latence.
   */
  async function singleRequest(): Promise<void> {
    const start = performance.now();
    try {
      const res = await app.request(`/mcp/${serverId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      });
      if (!res.ok) {
        errors++;
      } else {
        await res.json(); // Consommation complète de la réponse
        latencies.push(performance.now() - start);
      }
    } catch {
      errors++;
    }
  }

  // Échauffement
  for (let i = 0; i < warmupIterations; i++) {
    await singleRequest();
  }

  latencies.length = 0;
  errors = 0;

  // Mesure réelle
  const startTime = performance.now();
  const batches = Math.ceil(iterations / concurrency);

  for (let b = 0; b < batches; b++) {
    const batchSize = Math.min(concurrency, iterations - b * concurrency);
    await Promise.all(Array.from({ length: batchSize }, () => singleRequest()));
  }

  const totalDuration = performance.now() - startTime;
  const sortedLatencies = [...latencies].sort((a, b) => a - b);

  function percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const idx = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, idx)] ?? 0;
  }

  const avgLatency = latencies.length > 0
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : 0;

  return {
    scenario,
    totalRequests: iterations,
    durationMs: totalDuration,
    throughputRps: (latencies.length / totalDuration) * 1000,
    avgLatencyMs: avgLatency,
    p50LatencyMs: percentile(sortedLatencies, 50),
    p95LatencyMs: percentile(sortedLatencies, 95),
    p99LatencyMs: percentile(sortedLatencies, 99),
    errors,
  };
}

/**
 * Affiche les résultats sous forme de tableau formaté.
 */
function printResults(results: BenchmarkResult[]): void {
  console.log('\n┌─────────────────────────────────────────────────────────────────────────────────┐');
  console.log('│              MCP Conduit — Résultats de benchmark                        │');
  console.log('├─────────────────────────────────────────────────────────────────────────────────┤');
  console.log(`│ ${'Scénario'.padEnd(30)} ${'RPS'.padStart(8)} ${'Moy(ms)'.padStart(9)} ${'P50'.padStart(7)} ${'P95'.padStart(7)} ${'P99'.padStart(7)} ${'Err'.padStart(5)} │`);
  console.log('├─────────────────────────────────────────────────────────────────────────────────┤');

  for (const r of results) {
    const name = r.scenario.substring(0, 30).padEnd(30);
    const rps = r.throughputRps.toFixed(0).padStart(8);
    const avg = r.avgLatencyMs.toFixed(2).padStart(9);
    const p50 = r.p50LatencyMs.toFixed(2).padStart(7);
    const p95 = r.p95LatencyMs.toFixed(2).padStart(7);
    const p99 = r.p99LatencyMs.toFixed(2).padStart(7);
    const err = String(r.errors).padStart(5);
    console.log(`│ ${name} ${rps} ${avg} ${p50} ${p95} ${p99} ${err} │`);
  }

  console.log('└─────────────────────────────────────────────────────────────────────────────────┘\n');
}

async function main(): Promise<void> {
  console.log('Démarrage du benchmark MCP Conduit...\n');

  // Démarrage du serveur simulé
  const mockServer = await startMockMcpServer();
  console.log(`Serveur simulé démarré sur ${mockServer.url}`);

  resetMetrics();

  const config: ConduitGatewayConfig = {
    gateway: { port: 0, host: '127.0.0.1' },
    router: {
      namespace_strategy: 'none',
      health_check: { enabled: false, interval_seconds: 60, timeout_ms: 1000, unhealthy_threshold: 3 },
    },
    servers: [{ id: 'bench', url: mockServer.url, cache: { default_ttl: 300 } }],
    cache: { enabled: true, l1: { max_entries: 10000, max_entry_size_kb: 64 } },
    tenant_isolation: { enabled: false, header: 'Authorization' },
    observability: {
      log_args: false,
      log_responses: false,
      redact_fields: [],
      retention_days: 1,
      db_path: ':memory:',
    },
    metrics: { enabled: false, port: 0 },
  };

  const gateway = new ConduitGateway(config);
  await gateway.initialize();
  const app = gateway.createApp();

  const results: BenchmarkResult[] = [];

  const OPTIONS_SEQUENTIAL: BenchmarkOptions = { concurrency: 1, iterations: 500, warmupIterations: 20 };
  const OPTIONS_CONCURRENT: BenchmarkOptions = { concurrency: 20, iterations: 1000, warmupIterations: 20 };

  // Scénario 1 : passthrough initialize (sans cache)
  console.log('Scénario 1/4 : passthrough initialize (séquentiel)...');
  results.push(await runBenchmarkScenario(
    'passthrough initialize',
    app,
    'bench',
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'bench', version: '1.0.0' } } },
    OPTIONS_SEQUENTIAL,
  ));

  // Scénario 2 : tools/call — premier appel (MISS)
  console.log('Scénario 2/4 : tools/call MISS (séquentiel)...');
  gateway.getCacheStore().clear();
  results.push(await runBenchmarkScenario(
    'tools/call (MISS)',
    app,
    'bench',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_leads', arguments: { query: 'test' } } },
    { ...OPTIONS_SEQUENTIAL, warmupIterations: 1 },
  ));

  // Scénario 3 : tools/call — cache HIT (lecture mémoire L1)
  console.log('Scénario 3/4 : tools/call HIT (séquentiel)...');
  // Pré-chargement du cache
  await app.request('/mcp/bench', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'get_contact', arguments: { id: 'bench' } } }),
  });
  results.push(await runBenchmarkScenario(
    'tools/call (HIT cache L1)',
    app,
    'bench',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_contact', arguments: { id: 'bench' } } },
    OPTIONS_SEQUENTIAL,
  ));

  // Scénario 4 : requêtes concurrentes avec cache
  console.log('Scénario 4/4 : requêtes concurrentes (20 en parallèle)...');
  results.push(await runBenchmarkScenario(
    'concurrent tools/call (c=20)',
    app,
    'bench',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_contact', arguments: { id: 'bench' } } },
    OPTIONS_CONCURRENT,
  ));

  printResults(results);

  // Nettoyage
  gateway.stop();
  await mockServer.close();

  // Code de sortie non-zéro si des erreurs ont été détectées
  const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
  if (totalErrors > 0) {
    console.error(`Attention : ${totalErrors} erreur(s) détectée(s) pendant le benchmark.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Erreur fatale du benchmark :', err);
  process.exit(1);
});
