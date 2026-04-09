# MCP Conduit

[![CI](https://github.com/lacausecrypto/mcp-conduit/actions/workflows/ci.yml/badge.svg)](https://github.com/lacausecrypto/mcp-conduit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mcp-conduit.svg)](https://www.npmjs.com/package/mcp-conduit)
[![npm downloads](https://img.shields.io/npm/dt/mcp-conduit.svg)](https://www.npmjs.com/package/mcp-conduit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-1341%20passing-brightgreen.svg)](https://github.com/lacausecrypto/mcp-conduit/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)

**The open-source MCP gateway that makes AI tool calls production-ready.**

Conduit sits between your AI agents and MCP servers. One YAML file gives you caching, auth, rate limiting, guardrails, and multi-server routing. No code changes needed.

```
  AI Agents ──> [ Conduit ] ──> MCP Server A (HTTP)
  (Claude,                 ──> MCP Server B (stdio)
   Cursor,                 ──> MCP Server C (replicas)
   custom)
```

---

## Get Started in 60 Seconds

```bash
npx conduit init   # interactive setup wizard
npx conduit        # start the gateway
```

Or create `conduit.config.yml`:

```yaml
servers:
  - id: my-server
    url: http://localhost:3000/mcp
    cache:
      default_ttl: 300
```

```bash
npm install && npm run build && npm start
```

Your agents now connect to `http://localhost:8080/mcp/my-server` instead of the MCP server directly. Open `http://localhost:8080/conduit/dashboard` to see what's happening.

---

## Performance

Measured on a single machine, single process. These are real numbers, not theoretical limits.

| What we measured | Result | Why it matters |
|---|---|---|
| **Gateway overhead** | **0.02ms** added per request | You won't notice Conduit is there |
| **Cache hit throughput** | **46K RPS** (sequential) / **64K RPS** (concurrent) | Cached responses are instant |
| **All features enabled** | **111K RPS** at P99 = 3.24ms | Auth + plugins + rate limit + cache, still fast |
| **Stdio transport** | **354K RPS** (concurrent) | Faster than HTTP (no network overhead) |
| **Plugin hooks** | **2M ops/sec** | Plugins add zero measurable latency |

<details>
<summary>How we compare to alternatives</summary>

| | **Conduit** | Bifrost (Go) | TrueFoundry | Envoy AI GW |
|---|---|---|---|---|
| Overhead | 0.02ms | 0.011ms | 3-4ms | 1-2ms |
| Cache hit RPS | 46K-64K | not published | 350/vCPU | not published |
| Language | TypeScript | Go | TypeScript | C++/Go |
| License | MIT | Apache 2.0 | Proprietary | Apache 2.0 |

Bifrost has lower raw overhead (Go vs JS). We compensate with aggressive caching. In practice, most requests are cache hits.

</details>

```bash
npm run benchmark         # run it yourself (24 scenarios)
npm run benchmark:quick   # 3-second smoke test
```

---

## What Conduit Does

### Core Gateway

| Feature | Description |
|---|---|
| **Multi-server routing** | Route tools across servers with namespace prefixes (`github.list_repos`) |
| **HTTP + stdio transport** | Proxy HTTP servers or spawn local binaries. Same features for both |
| **Load balancing** | Round-robin or least-connections across replicas |
| **Circuit breaker** | Per-replica failure isolation (closed/open/half-open) |
| **Health checks** | Periodic probes with configurable thresholds |
| **Hot reload** | `SIGHUP` or API call. Add servers, update rules, zero downtime |

### Caching

| Feature | Description |
|---|---|
| **L1 in-memory** | LRU cache with per-tool TTL |
| **L2 Redis** | Distributed cache for multi-instance deployments |
| **Smart invalidation** | Destructive tools auto-invalidate related cache entries |
| **Inflight dedup** | 10 identical requests = 1 upstream call, 10 responses |
| **Annotation-aware** | Respects MCP `readOnly`, `idempotent`, `destructive` hints |

### Security

| Feature | Description |
|---|---|
| **JWT auth** | JWKS validation with auto-rotating keys |
| **API key auth** | Constant-time comparison (timing-attack resistant) |
| **ACL policies** | Per-client, per-server, per-tool access control with wildcards |
| **AI guardrails** | Block/alert/transform tool calls based on name + argument rules |
| **Rate limiting** | Sliding window (memory or Redis), global + per-client + per-tool |
| **CSRF protection** | Admin mutations require `X-Conduit-Admin` header |
| **SSRF protection** | URL validation blocks internal IPs and metadata endpoints |

### Observability

| Feature | Description |
|---|---|
| **Structured logs** | SQLite with retention, field redaction, trace correlation |
| **Prometheus metrics** | 18 counters/gauges/histograms on dedicated port |
| **OpenTelemetry** | W3C Trace Context + OTLP export |
| **Admin dashboard** | React SPA: logs, servers, cache stats, circuit breakers |
| **Admin API** | 40+ endpoints for programmatic access |

### Extensibility

| Feature | Description |
|---|---|
| **Plugin system** | 5 hooks in the pipeline, dynamic JS/TS loading |
| **Service discovery** | HTTP self-registration + DNS SRV |
| **JSON Schema** | Config autocompletion in VS Code / JetBrains |
| **CLI wizard** | `npx conduit init` generates config interactively |

---

## Configuration

Minimal (just your server):

```yaml
servers:
  - id: my-server
    url: http://localhost:3000/mcp
    cache:
      default_ttl: 300
```

With stdio transport:

```yaml
servers:
  - id: filesystem
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    cache:
      default_ttl: 60
```

With everything:

```yaml
servers:
  - id: salesforce
    url: http://salesforce-mcp:3000/mcp
    cache:
      default_ttl: 300
      overrides:
        create_lead:
          ttl: 0
          invalidates: [get_contact, search_leads]

auth:
  method: api_key
  api_keys:
    - key: ${CONDUIT_API_KEY}
      client_id: my-agent
      tenant_id: default

guardrails:
  enabled: true
  default_action: allow
  rules:
    - name: block-destructive
      tools: ["delete_*", "drop_*"]
      action: block
      message: "Destructive tools require manual review"
      severity: high

cache:
  l2:
    enabled: true
    redis_url: ${CONDUIT_REDIS_URL}
    default_ttl_multiplier: 3

admin:
  key: ${CONDUIT_ADMIN_KEY}
```

All config fields: [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Environment variables: [.env.example](.env.example)

---

## Deployment

**Docker:**

```bash
docker build -t conduit .
docker run -d -p 8080:8080 -p 9090:9090 \
  -v ./conduit.config.yml:/app/conduit.config.yml:ro \
  -e CONDUIT_ADMIN_KEY=$(openssl rand -hex 32) \
  conduit
```

**Kubernetes:** Helm chart in `deploy/helm/`. Liveness and readiness probes included.

```bash
helm install conduit deploy/helm/conduit --set config.adminKey=$(openssl rand -hex 32)
```

---

## What Conduit Does NOT Do

We believe in being upfront:

- **Not a managed service.** You host it. No SaaS offering.
- **Not a cluster.** Single process. Scale horizontally with a load balancer.
- **No pre-built integrations.** This is a proxy, not an integration catalog.
- **No container isolation for stdio.** Child processes run in the same OS context.
- **No SOC 2 certification.** Regulated environments need your own audit.
- **Higher raw overhead than Go.** 0.02ms vs 0.011ms (language gap). Caching makes this irrelevant in practice.

---

## Documentation

| Doc | Description |
|---|---|
| [Configuration Reference](docs/CONFIGURATION.md) | Every config field, with defaults and examples |
| [API Reference](docs/API_REFERENCE.md) | All 40+ admin endpoints with curl examples |
| [Security Guide](docs/SECURITY_GUIDE.md) | Production hardening checklist |
| [Wiki](https://github.com/lacausecrypto/mcp-conduit/wiki) | Architecture, plugin dev, FAQ |
| [JSON Schema](conduit.schema.json) | Config autocompletion for your editor |

---

## Testing

```bash
npm test                    # 1341 tests
npm run test:battle         # chaos + fault injection
npm run test:integration    # multi-server end-to-end
```

70 test files covering unit, e2e, battle, integration, security, and benchmarks.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs welcome.

## License

[MIT](LICENSE)
