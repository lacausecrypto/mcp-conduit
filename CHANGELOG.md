# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0]: 2026-04-30

Major release. Adds the enterprise platform (identity, governance, connect,
managed runtime), refondue dashboard, and a four-sprint security audit
covering critical, high, medium, and battle-tested DoS layers. **+237 tests
(1458 → 1695 passing, zero regressions)**, 91 test files.

### Added

#### Enterprise platform

- **Identity plane** (`src/identity/`): connected accounts, encrypted secrets,
  workspace ↔ tenant bindings, multi-mode resolution
  (client / tenant / workspace / client-or-workspace).
- **Governance plane** (`src/governance/`): role bindings (owner, admin,
  approver, operator, developer, viewer), tool policies, registry policies,
  approvals workflow with TTL and self-approval guard, per-workspace quotas.
- **Connect plane** (`src/connect/`): exportable profiles, install bundles,
  remote bundles, smart MCP-registry import, descriptor fetch with SSRF
  protection, relay client, TOML rendering for Claude Desktop / Codex.
- **Managed runtime** (`src/runtime/managed.ts`): sandboxed stdio servers,
  pinned releases, rollout + rollback, health gates, env sanitization.
- **`conduit connect` CLI** (`src/cli/connect.ts`): install / list / remove
  Conduit-managed servers from the command line.

#### Dashboard refonte (Operator Slate)

- Linear/Vercel-inspired UI with cyan accent, Inter via Bunny Fonts
  (RGPD-compliant CSP).
- 9 reorganized views: Overview, Logs, Servers & Cache, Limits, Settings,
  Connect, Registry, Identity, Governance.
- Linear-style underline tabs primitive, asymmetric content padding
  (40 px / 32 px), responsive sidebar (icon-only ≤ 1080 px, drawer + hamburger
  ≤ 640 px).
- Registry redesign with `auto-fill minmax(360px, 1fr)` grid, install bar,
  compact cards.

### Security — audit Sprint 3.1 (Critical, +145 tests)

- **JWT hardening**: explicit rejection of `alg: none`, HS/RSA key-confusion
  guard, algorithm whitelist (RS\*/PS\*/ES\*/EdDSA only with JWKS), audience
  validation.
- **Stdio respawn-loop bound + shutdown drain** (code fix in
  `src/proxy/stdio-mcp-client.ts`): exponential backoff `250 ms → 30 s`,
  10-fast-failure ceiling, signal-aware reset, pending requests rejected
  immediately on shutdown / error events.
- **SSRF on descriptor redirects**: cloud metadata `169.254.169.254`, IPv6
  loopback `::1`, RFC1918 chains, scheme upgrade (`http:` → `ftp:`),
  redirect-limit, 301-without-Location.
- **Sandbox path traversal**: `/etc/passwd`, `/root`, `/proc`, `..`,
  shell metachars (`;`, `` ` ``, `$()`) in package identifiers.
- **Cache stampede single-flight**: 50 concurrent identical requests yield 1
  upstream call.
- **Hot-reload mid-flight**: 20 in-flight requests survive a config reload;
  10 reloads × 30 traffic without crash.
- Full coverage of governance store, identity store, metrics label
  sanitization, connect bundle expiry / token format.

### Security — audit Sprint 3.2 (High, +30 tests)

- **`admin.key` required on non-loopback host**: explicit
  `admin.allow_unauthenticated: true` opt-in for operators who genuinely
  want to expose the admin API without auth.
- **Authorization header forwarding now opt-in per server**
  (`server.forward_authorization`). Default: bearer presented to Conduit is
  not propagated upstream — closes credential exfiltration vector.
- **Circuit breaker default-config deadlock fix**: release `halfOpenRequests`
  on success so `success_threshold` (default 2) can be reached with
  `half_open_max_requests` (default 1).
- **Descriptor body size cap**: 1 MiB hard limit (Content-Length fast path
  + streaming-bytes slow path).
- **MCP `isError` tool responses skip cache**: new `SKIP_ERROR` cache
  status, no poisoning of subsequent callers.

### Security — audit Sprint 3.3 (Medium / Hardening, +34 tests)

- **IPv4-mapped IPv6 SSRF**: `::ffff:a.b.c.d`, hex form (`::ffff:7f00:1`),
  6to4 (`2002::/16`) wrapping private IPv4, IPv6 site-local (`fec0::/10`),
  multicast, IPv4 multicast / reserved ranges.
- **Approver impersonation guard**: when `auth.method` is `jwt` or
  `api-key`, the authenticated principal must match the body's
  `approver_client_id` — prevents admin-key holders from posing as any
  approver.
- **Replica/server URL credential redaction** in `GET /conduit/servers`.
- **Tenant-isolation header spoofing blocked** when auth is active —
  authenticated `tenant_id` always wins over caller-supplied header.
- **Governance Redis quotas**: pluggable `RateLimitBackend`. When
  `rate_limits.backend === 'redis'`, governance reuses the same Redis
  connection for cross-pod quota enforcement.
- **Sandbox env strip**: `npm_config_*`, `PIP_*`, `PIPX_*`, `POETRY_*`,
  `UV_*`, `CARGO_*` prefixes plus `NPM_TOKEN`, `GITHUB_TOKEN`, `AWS_*`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `CONDUIT_ADMIN_KEY` removed even when
  `sanitize_env: false`.
- **L2 cache write coalescing**: 200 ms window kills 50× duplicate Redis
  SETs under stampede; new `writes_coalesced` stat exposed via `getStats()`.

### Security — audit Sprint 4 (Battle-test / DoS, +28 tests)

- **Rate limiter unbounded keys** (HIGH): empty buckets pruned in
  `getValid()`; hard cap of 50 000 buckets with insertion-order eviction
  at 90 %. Closes the 100k-unique-key OOM vector verified at runtime
  (~44 MiB heap → bounded).
- **JSON-RPC batch DoS** (MEDIUM-HIGH): `MAX_BATCH_SIZE = 100` hard cap on
  batch entries.
- **JSON-RPC per-message errors**: spec-compliant `parseJsonRpcBatchPartial`
  returns `Invalid Request` per malformed entry instead of rejecting the
  whole batch.
- **Plugin loader directory allowlist**: default `./plugins`. Blocks
  registration of arbitrary files under CWD (compromised npm dependency
  vector). Explicit opt-out via `allowedDirs: []`.
- **Identity store NULL discrimination**: explicit `(NULL AND NULL) OR =`
  predicate replaces `COALESCE(x, '')` conflation. Defense in depth
  against direct DB writes injecting `''` rows.
- **Cache key undefined normalization**: `undefined` values explicitly
  stripped (documented contract: `undefined` ≡ missing); `null` preserved
  as a distinct value.
- **DNS rebinding TOCTOU mitigation**: new `pinnedFetch` (`node:https` /
  `node:http` with custom `lookup` + SNI `servername`) wires the
  descriptor fetcher to the IP validated by `validateServerUrlWithDns`.
  Closes the window between validate → fetch.

### Changed

- `parseJsonRpc()` now caps batches at `MAX_BATCH_SIZE` (100). Oversize
  batches yield 400 Invalid Request before reaching the pipeline.
- Batch responses now mix successful results and per-message errors
  (JSON-RPC 2.0 spec compliance) instead of all-or-nothing rejection.
- `validateServerUrlWithDns` returns the validated `resolvedIps[]` for
  callers that want to pin subsequent fetches.
- `CacheLogStatus` extended with `SKIP_ERROR`.
- Default config validation refuses to start when `gateway.host` is
  non-loopback and `admin.key` is missing — explicit opt-in required.

### Migration notes (1.x → 2.0)

1. **Admin key**: deployments binding to `0.0.0.0` or any non-loopback
   address must now set `admin.key` (or `CONDUIT_ADMIN_KEY` env), or
   explicitly `admin.allow_unauthenticated: true`. Loopback deployments
   are unaffected.
2. **Authorization header forwarding**: if your upstream MCP servers
   relied on the gateway forwarding the client's `Authorization` header,
   set `forward_authorization: true` on those `servers[]` entries. Default
   is now no-forward.
3. **JWT auth with HS\* algorithms via JWKS**: explicitly disallowed.
   Use asymmetric algorithms (RS\*/PS\*/ES\*/EdDSA).
4. **Plugins**: must live under `./plugins` by default. Move existing
   plugin files there or pass `allowedDirs` to `loadPlugins()`.
5. **Tool responses with `isError: true`** are no longer cached. If your
   pipeline relied on caching error envelopes, invert the upstream
   contract or override `cache.overrides[tool].ttl`.

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
