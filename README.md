# MCP Conduit

**A transparent, high-performance MCP gateway with caching, auth, guardrails, and multi-server routing.**

[![CI](https://github.com/lacausecrypto/mcp-conduit/actions/workflows/ci.yml/badge.svg)](https://github.com/lacausecrypto/mcp-conduit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mcp-conduit.svg)](https://www.npmjs.com/package/mcp-conduit)
[![npm downloads](https://img.shields.io/npm/dm/mcp-conduit.svg)](https://www.npmjs.com/package/mcp-conduit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-green.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/Tests-1300%2B%20passing-brightgreen.svg)](https://github.com/lacausecrypto/mcp-conduit/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)

MCP Conduit sits between your AI agents and MCP servers. It adds caching, authentication, rate limiting, observability, AI guardrails, and intelligent routing — without modifying your existing MCP servers or clients.

Built with [Hono](https://hono.dev/) on Node.js. Open-source under MIT.

---

## Why Conduit

- **Production-grade MCP infrastructure in one binary.** Auth, caching, rate limiting, circuit breakers, guardrails, observability, plugins — configured via YAML, no code changes to existing MCP servers.
- **Fast enough to disappear.** 0.02ms gateway overhead. 46K+ cache-hit RPS sequential, 111K+ RPS with all features enabled. Competitive with Go-based solutions.
- **Multi-server routing with safety nets.** Namespace tools across servers, load-balance replicas, circuit-break failures, health-check backends, and inspect tool calls with rule-based guardrails.
- **Two transport modes.** Proxy HTTP-based MCP servers *or* spawn stdio-based servers as child processes — same gateway, same features.

---

## Performance

All benchmarks run on a single machine. Numbers reflect real gateway overhead, not theoretical limits.

| Scenario | Throughput | Latency (P99) |
|---|---|---|
| Gateway overhead (passthrough) | — | 0.02ms |
| Cache HIT (sequential) | 46,000+ RPS | — |
| Cache HIT (concurrent, c=10) | 64,000+ RPS | — |
| Stdio transport (sequential) | 72,000 RPS | — |
| Stdio transport (concurrent, c=10) | 354,000 RPS | — |
| Full stack (auth + plugins + rate limit + cache) | 111,000+ RPS | 3.24ms |
| Plugin hooks | 2,000,000 ops/s | negligible |

Run benchmarks yourself:

```bash
npm run benchmark        # Full 24-scenario suite
npm run benchmark:quick  # Quick smoke test
npm run benchmark:json   # JSON output for CI
```

---

## Quick Start

### npm

```bash
# Install dependencies
npm install

# Build
npm run build

# Configure (edit to match your MCP servers)
cp conduit.config.yml my-config.yml
# Edit my-config.yml

# Start
CONDUIT_CONFIG=my-config.yml npm start
```

### Docker

```bash
docker build -t conduit .
docker run -p 8080:8080 \
  -v $(pwd)/conduit.config.yml:/app/conduit.config.yml:ro \
  conduit
```

### Development

```bash
npm run dev          # Start with tsx (hot reload)
npm test             # Run all 1226 tests
npm run test:battle  # Battle tests (fault injection, edge cases)
```

---

## Architecture

```
                         MCP Conduit
                    ┌──────────────────────────┐
                    │                          │
  AI Agents ──────>│  Hono HTTP Server        │
  (Claude, etc.)   │    │                      │
                    │    ├─ Auth (JWT / API Key)│
                    │    ├─ ACL Filtering       │
                    │    ├─ Rate Limiter        │
                    │    ├─ Guardrails Engine   │
                    │    ├─ Plugin Hooks        │
                    │    ├─ Cache (L1 + L2)     │
                    │    ├─ Router / LB         │
                    │    │   ├─ Circuit Breaker │
                    │    │   └─ Health Checks   │
                    │    │                      │
                    │    v                      │
                    │  ┌──────────┐ ┌────────┐ │
                    │  │ HTTP     │ │ Stdio  │ │
                    │  │ upstream │ │ spawn  │ │
                    │  └────┬─────┘ └───┬────┘ │
                    └───────┼───────────┼──────┘
                            │           │
                    ┌───────v───┐  ┌────v─────┐
                    │ MCP Server│  │MCP Server │
                    │ (HTTP)    │  │(binary)   │
                    │ + replicas│  └───────────┘
                    └───────────┘

  Observability sidecar:
    ├─ SQLite structured logs (with redaction)
    ├─ Prometheus metrics (:9090/metrics)
    ├─ OpenTelemetry traces (OTLP export)
    └─ Admin dashboard (React SPA)
```

---

## Features

### Multi-Server Routing

Route requests to multiple MCP backend servers. Tools are namespaced (e.g., `github.list_repos`, `slack.send_message`) to avoid collisions, or use flat naming if your tools are unique.

- **Load balancing:** Round-robin or least-connections across replicas
- **Circuit breaker:** Per-replica, with closed/open/half-open states
- **Health checks:** Periodic probes with configurable failure thresholds
- **Service discovery:** HTTP self-registration with heartbeat, DNS SRV resolution

### Transport

- **HTTP:** Streamable HTTP transport — proxy to upstream MCP servers
- **Stdio:** Spawn any MCP server binary as a child process. Same gateway features apply.
- **SSE passthrough** for long-running responses
- **Session propagation** via `Mcp-Session-Id` header

### Caching

Two-tier caching that eliminates redundant upstream calls:

- **L1:** In-memory LRU cache with per-tool TTL
- **L2:** Redis distributed cache (write-through, L2-to-L1 promotion on miss)
- **Smart keys:** SHA-256 deterministic hashing with recursive key sorting, tenant isolation
- **Annotation-aware:** Respects MCP tool annotations (`readOnly`, `idempotent`, `destructive`, `openWorld`)
- **Mutation invalidation:** Clears related cache entries on destructive tool calls
- **Inflight deduplication:** Coalesces identical concurrent requests into a single upstream call
- **`ignore_args`:** Strip non-deterministic fields (timestamps, request IDs) from cache keys

### Authentication & Authorization

- **JWT validation** via JWKS endpoint (auto-rotating keys)
- **API key auth** with constant-time comparison (timing-attack resistant)
- **ACL policies:** Scope access by client, server, and tool using wildcard patterns
- **tools/list filtering:** Clients only see tools they are authorized to use
- **Multi-tenant isolation:** Cache and rate limits partitioned by tenant (extracted from JWT or Bearer token)

### AI Guardrails

Inspect and control tool calls before they reach upstream servers:

- **Rule engine:** Match on tool name patterns and argument values
- **11 condition operators:** `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `not_contains`, `matches` (regex), `exists`, `not_exists`
- **Actions:** `block`, `alert`, `require_approval`, `transform`
- **Scoping:** Rules target specific tools, clients, or servers (wildcard support)
- **Bypass lists** for trusted clients
- **Severity levels:** `low`, `medium`, `high`, `critical`
- **Webhook alerts:** Fire-and-forget notifications on rule triggers
- First-match-wins evaluation

### Rate Limiting

- **Sliding window** algorithm (in-memory or Redis-backed)
- **Hierarchical:** Global, per-client, per-server, and per-tool limits
- **Request queue** with configurable timeout for burst absorption
- **`Retry-After` header** on rejection (429 responses)

### Observability

- **Structured logging** to SQLite with configurable retention and rotation
- **Field redaction:** Recursive, word-boundary-aware, camelCase-aware scrubbing of sensitive data
- **Trace IDs:** `X-Conduit-Trace-Id` generated and propagated on every request
- **W3C Trace Context:** `traceparent`/`tracestate` header support
- **OpenTelemetry:** OTLP trace export with configurable sampling rate
- **Prometheus metrics:** 18 counters, gauges, and histograms exposed on a dedicated port
- **Admin dashboard:** React SPA for inspecting logs, server status, and metrics

### Plugin System

Extend the gateway without forking:

- **5 hook points:** `before:request`, `after:auth`, `before:cache`, `after:upstream`, `before:response`
- **Dynamic loading:** Import JS or TS plugin files at startup
- **Flexible exports:** Factory function or plain object
- **Scoped hooks:** Configure which hooks each plugin receives
- **Resilient:** Plugin errors are caught and logged — they never crash the pipeline

### JSON-RPC 2.0

- Full batch request support with `Promise.allSettled` (individual errors don't fail the batch)
- 10MB request body limit with streaming protection

---

## Configuration

Conduit is configured via a YAML file. Environment variables override config values.

```yaml
# conduit.config.yml (minimal example)

gateway:
  port: 8080
  host: "0.0.0.0"

router:
  namespace_strategy: prefix  # "prefix" or "none"

servers:
  - name: github
    url: "http://localhost:3001/mcp"
    tools: ["*"]
    cache:
      default_ttl: 30

  - name: local-tool
    transport: stdio
    command: "npx"
    args: ["-y", "@my-org/my-mcp-server"]
    tools: ["*"]

cache:
  enabled: true
  l1:
    max_size: 1000
    default_ttl: 60

auth:
  providers:
    - type: api_key
      key: "${CONDUIT_API_KEY}"

logging:
  level: info
  db_path: "./conduit-logs.db"
  redact_fields: ["password", "token", "secret", "authorization"]
```

Key environment variables:

| Variable | Description |
|---|---|
| `CONDUIT_PORT` | Gateway listen port |
| `CONDUIT_HOST` | Bind address |
| `CONDUIT_ADMIN_KEY` | Admin API authentication key |
| `CONDUIT_REDIS_URL` | Redis URL for L2 cache and distributed rate limiting |
| `CONDUIT_DB_PATH` | SQLite log database path |
| `CONDUIT_METRICS_PORT` | Prometheus metrics port |
| `CONDUIT_TLS_ENABLED` | Enable native TLS |
| `CONDUIT_TLS_CERT` | TLS certificate path |
| `CONDUIT_TLS_KEY` | TLS private key path |
| `CONDUIT_LOG_ARGS` | Log tool call arguments (default: false) |

Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

---

## Comparison with Alternatives

Honest assessment as of early 2025. Throughput numbers are from published benchmarks or our own testing.

| Feature | **Conduit** | Bifrost | TrueFoundry | Envoy AI GW | Lunar MCPX | Kong AI MCP |
|---|---|---|---|---|---|---|
| **Language** | TypeScript | Go | TypeScript | C++/Go | Go | Lua/Go |
| **Raw overhead** | 0.02ms | 0.011ms | 3-4ms | 1-2ms | ~4ms P99 | N/A |
| **Cache-hit RPS** | 46K+ seq / 64K+ conc | — | 350/vCPU | — | — | — |
| **Stdio transport** | Yes | No | No | No | No | No |
| **L2 Redis cache** | Yes | No | Partial | No | No | No |
| **Plugin system** | Yes (5 hooks) | No | No | Via Envoy filters | No | Via Kong plugins |
| **AI guardrails** | Yes (11 operators) | No | Enterprise | No | No | Enterprise |
| **Service discovery** | HTTP + DNS SRV | No | Proprietary | Via Envoy | No | Via Kong |
| **OpenTelemetry** | Yes | Partial | Yes | Yes | No | Yes |
| **Circuit breaker** | Yes | No | Yes | Yes | No | Yes |
| **License** | MIT | Apache 2.0 | Proprietary | Apache 2.0 | Apache 2.0 | Enterprise |
| **Focus** | MCP-native gateway | LLM gateway (MCP secondary) | Enterprise MCP platform | General reverse proxy | MCP proxy (incubating) | REST-to-MCP bridge |

**Where Conduit leads:** Feature completeness — the only open-source gateway combining stdio transport, plugin hooks, two-tier cache, service discovery, AI guardrails, and OpenTelemetry in a single package. Throughput is competitive with Go solutions when caching is involved.

**Where others lead:**

- **Bifrost** has lower raw overhead (Go vs. JS — a fundamental language gap)
- **Envoy AI Gateway** benefits from Envoy's mature proxy ecosystem
- **Kong** has enterprise support, GUI management, and a large plugin marketplace
- **TrueFoundry** offers a managed platform with enterprise support
- **Composio** provides 500+ pre-built integrations (different problem — aggregation, not proxying)
- **Docker MCP Gateway** provides container-level isolation per server

---

## What Conduit Does NOT Do

Transparency matters. Here is what this project is not:

- **Not a managed platform.** You deploy and operate it yourself. No hosted offering.
- **Not a cluster.** Single-process deployment. Horizontal scaling requires an external load balancer in front of multiple instances.
- **No built-in GUI for guardrail management.** Rules are defined in YAML config. The admin dashboard covers logs and metrics, not rule editing.
- **No container isolation.** Stdio servers run as child processes in the same OS context, not in sandboxed containers.
- **No pre-built integrations.** This is a proxy layer, not an integration catalog. You bring your own MCP servers.
- **No SOC 2 or compliance certifications.** Use in regulated environments requires your own audit.
- **Raw overhead is higher than Go solutions.** 0.02ms vs 0.011ms — inherent to the Node.js runtime. In practice, caching and connection reuse make this irrelevant for most workloads.

---

## Deployment

### Docker (Production)

The included Dockerfile uses a multi-stage build with a non-root user:

```bash
docker build -t conduit .

docker run -d \
  --name conduit \
  -p 8080:8080 \
  -p 9090:9090 \
  -v $(pwd)/conduit.config.yml:/app/conduit.config.yml:ro \
  -e CONDUIT_ADMIN_KEY=your-secret-key \
  conduit
```

### Kubernetes

Helm chart available in `deploy/helm/`. The gateway exposes liveness and readiness probes and is HPA-compatible.

```bash
helm install conduit deploy/helm/ \
  --set config.adminKey=your-secret-key \
  --set replicaCount=3
```

### Operations

- **Hot reload:** Send `SIGHUP` or `POST /conduit/config/reload` to reload configuration without downtime
- **Dynamic servers:** Add or remove backend servers via the admin API or config reload
- **Graceful shutdown:** In-flight requests drain before the process exits
- **CSRF protection:** Admin mutation endpoints require the `X-Conduit-Admin` header

---

## Testing

```bash
npm test                    # All 1226 tests
npm run test:battle         # Fault injection and edge cases
npm run test:integration    # Integration tests
```

The test suite covers unit, end-to-end, battle (chaos), integration, and security scenarios.

---

## Project Structure

```
src/
  index.ts              # Entry point
  config/               # YAML config loader and validation
  router/               # Multi-server routing, load balancing, circuit breaker
  cache/                # L1/L2 cache, key generation, invalidation
  auth/                 # JWT, API key, ACL
  guardrails/           # Rule engine for tool call inspection
  rate-limiter/         # Sliding window rate limiter
  observability/        # Logging, metrics, tracing
  plugins/              # Plugin loader and hook runner
  transport/            # HTTP and stdio transport adapters
  dashboard/            # Admin dashboard (React SPA)
  discovery/            # Service discovery (HTTP, DNS SRV)
tests/
  unit/                 # Unit tests
  e2e/                  # End-to-end tests
  battle/               # Chaos and fault injection tests
  integration/          # Integration tests
  benchmark/            # Performance benchmarks
docs/
  CONFIGURATION.md      # Full configuration reference
  API_REFERENCE.md      # Admin API documentation
  SECURITY_GUIDE.md     # Security hardening guide
deploy/
  helm/                 # Kubernetes Helm chart
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

[MIT](LICENSE)
