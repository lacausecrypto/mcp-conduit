# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0]: 2026-04-09

### Added

- **Windows compatibility**: full support for Windows (spawn shell resolution, process termination, path handling).
- CI now tests on Ubuntu, Windows, and macOS.
- Plugin path blocking for Windows system directories (`C:\Windows\`, `C:\Program Files\`).

### Changed

- `spawn()` uses `shell: true` + `windowsHide: true` on win32 to resolve `.cmd` executables (e.g., `npx.cmd`).
- Process kill uses `TerminateProcess` on Windows instead of Unix signals (`SIGTERM`/`SIGKILL`).
- `SIGHUP` handler is skipped on Windows. Use `POST /conduit/config/reload` instead.
- CLI init wizard uses platform-aware temp directory (`C:\temp` on Windows, `/tmp` on Unix).

## [1.0.0]: 2026-04-09

Initial public release. See [release notes](https://github.com/lacausecrypto/mcp-conduit/releases/tag/v1.0.0).

## [0.2.0]: 2026-04-09

### Added

- **Stdio transport support**: proxy any MCP server via child process (spawn, JSON-RPC over stdin/stdout, automatic restart, circuit breaker integration).
- **IMcpClient interface** and client factory for transport abstraction (HTTP and stdio behind a single API).
- **Redis L2 distributed cache**: write-through strategy, L2-to-L1 promotion on read, configurable TTL multiplier, SCAN-based invalidation.
- **Plugin/middleware system**: five hook points (`before:request`, `after:auth`, `before:cache`, `after:upstream`, `before:response`), dynamic import loader, try/catch resilience per plugin.
- **OpenTelemetry integration**: W3C Trace Context propagation (`traceparent`/`tracestate`), OTEL SDK spans, OTLP HTTP export, configurable sampling rate.
- **Dynamic server management**: add or remove servers at runtime via admin API (`POST /conduit/servers`, `DELETE /conduit/servers/:id`) or configuration hot-reload.
- **Service discovery**: HTTP self-registration with heartbeat TTL, DNS SRV discovery, reconciliation manager for convergence.
- **AI Guardrails**: rule-based tool call inspection with `block`, `alert`, `require_approval`, and `transform` actions; 11 condition operators; webhook alerts; severity levels.
- **SSE/streaming passthrough** for `tools/call` responses.
- **CSRF protection** on admin mutation endpoints (requires `X-Conduit-Admin` header).
- **Integration test suite** covering HTTP and stdio multi-server topologies.
- **Competitive analysis benchmark** with 24 scenarios.

### Changed

- Cache stats endpoint now returns `{ l1: {...}, l2?: {...} }` structure instead of flat stats.
- Hot-reload now supports adding and removing servers (previously blocked by validation).
- Health checks adapted for stdio transport (uses `client.forward` instead of `fetch`).
- Redactor uses word-boundary matching instead of substring `includes` (fewer false positives).

### Fixed

- Batch JSON-RPC now uses `Promise.allSettled` to return individual error responses per spec.
- Body size check frees memory before returning 413.
- Inflight deduplication handles synchronous `factory()` throws.
- SQLite auto-recovery on database corruption.

## [0.1.0]: 2026-04-09

### Added

- **Transparent MCP proxy** over Streamable HTTP.
- **In-memory LRU cache** with TTL, deterministic keys (SHA-256), and inflight deduplication.
- **Tool annotation-based cache policy**: automatic behavior derived from `readOnly`, `destructive`, `idempotent`, and `openWorld` annotations.
- **JWT and API key authentication**, ACL policies with wildcard patterns.
- **Sliding window rate limiting** (memory and Redis backends), request queue for overflow.
- **Multi-server routing** with namespace strategy, round-robin and least-connections load balancing.
- **Circuit breaker** per replica with configurable thresholds, backend health checks.
- **Structured logging to SQLite**, field redaction, Prometheus-compatible metrics endpoint.
- **Admin API** with 15+ endpoints and React dashboard.
- **Native TLS support**, graceful shutdown, Docker multi-stage build.
- 860 tests (unit, end-to-end, battle, benchmark).
