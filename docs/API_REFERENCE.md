# Conduit: API Reference

This page documents all endpoints exposed by Conduit.

---

## Admin API Authentication

All `/conduit/*` endpoints (except `/conduit/health` and `/conduit/dashboard`) require the admin key if `CONDUIT_ADMIN_KEY` is set.

**Required header:**

```
Authorization: Bearer <admin_key>
```

**Alternative (custom header):**

```
X-Admin-Key: <admin_key>
```

**On failure:**

```json
HTTP 401 Unauthorized
{"error": "Unauthorized"}
```

## CSRF Protection

All state-changing requests (`POST`, `PUT`, `DELETE`) to the admin API require a custom CSRF header:

```
X-Conduit-Admin: true
```

This header triggers a CORS preflight that blocks cross-origin requests. Without it, the response is:

```json
HTTP 403 Forbidden
{"error": "Missing X-Conduit-Admin header (CSRF protection)"}
```

---

## MCP Transport

### POST /mcp/:serverId

Transparent proxy to a specific MCP server. The request body is a standard MCP JSON-RPC message.

**URL:** `POST /mcp/:serverId`

**Path parameter:**

| Parameter | Description |
|-----------|-------------|
| `serverId` | Server identifier as defined in `servers[].id` |

**Request headers:**

| Header | Required | Description |
|--------|:--------:|-------------|
| `Content-Type` | Yes | `application/json` |
| `Authorization` | If auth enabled | `Bearer <token_or_api_key>` |
| `Mcp-Session-Id` | No | Persistent MCP session |
| `X-Conduit-Group` | No | Session group for cache isolation |

**Request body:** Standard MCP JSON-RPC 2.0 message.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_contact",
    "arguments": {
      "id": "003Qy000001XyZaIAK"
    }
  }
}
```

**Response headers:**

| Header | Description |
|--------|-------------|
| `X-Conduit-Trace-Id` | Trace identifier (format `conduit-<uuid>`) |
| `X-Conduit-Cache` | `HIT`, `MISS`, `SKIP`, or `BYPASS` |
| `X-Conduit-Server` | Identifier of the server that handled the request |

**Success response (200):**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"id\":\"003Qy000001XyZaIAK\",\"name\":\"John Doe\"}"
      }
    ]
  }
}
```

**Error response (200 with JSON-RPC error):**

MCP errors are returned with HTTP status 200 but an `error` field in the JSON-RPC:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "Access denied",
    "data": {
      "reason": "ACL policy 'support-readonly' denies delete_contact for server salesforce"
    }
  }
}
```

**curl example:**

```bash
curl -X POST http://localhost:8080/mcp/salesforce \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-agent-prod-abc123" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "get_contact",
      "arguments": {"id": "003Qy000001XyZaIAK"}
    }
  }'
```

---

### POST /mcp

Aggregated endpoint. All `tools/list` requests return the union of tools from all registered servers (with their namespace prefix if `namespace_strategy: prefix`). All `tools/call` requests are routed to the correct server based on the tool name.

**URL:** `POST /mcp`

Same request and response format as `/mcp/:serverId`.

**curl example:**

```bash
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-agent-prod-abc123" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'
```

---

### GET /mcp/:serverId

SSE (Server-Sent Events) notification stream for a specific MCP server. Maintains a persistent connection for receiving real-time notifications.

**URL:** `GET /mcp/:serverId`

**Response:** `text/event-stream`

**curl example:**

```bash
curl -N http://localhost:8080/mcp/salesforce \
  -H "Authorization: Bearer sk-agent-prod-abc123"
```

---

## Admin API

### Health and Status

#### GET /conduit/health

Liveness probe. Returns 200 as long as the process is running, even if backends are degraded. Exempt from admin authentication to allow Kubernetes probes.

**Auth required:** No
**CSRF header required:** No

**Response 200:**

```json
{
  "status": "ok",
  "uptime_seconds": 3612.4,
  "db_writable": true,
  "backends": [
    {
      "id": "salesforce",
      "healthy": true,
      "latency_ms": 12,
      "last_checked": "2026-04-09T12:00:00.000Z"
    }
  ],
  "redis": {
    "connected": true
  }
}
```

**Response 503 (degraded):**

```json
{
  "status": "degraded",
  "uptime_seconds": 3612.4,
  "db_writable": false,
  "backends": [...]
}
```

> Note: The `redis` field is only present when Redis is configured.

**curl example:**

```bash
curl http://localhost:8080/conduit/health
```

---

#### GET /conduit/readyz

Readiness probe. Returns 200 only when at least one backend is healthy AND the database is writable. Kubernetes should use this endpoint as `readinessProbe`.

**Auth required:** Yes (if admin key is set)
**CSRF header required:** No

**Response 200:**

```json
{"ready": true}
```

**Response 503:**

```json
{
  "ready": false,
  "backends_healthy": false,
  "db_writable": true
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/readyz
```

---

#### GET /conduit/version

Returns the gateway version and Node.js runtime version.

**Auth required:** Yes (if admin key is set)
**CSRF header required:** No

**Response 200:**

```json
{
  "version": "0.1.0",
  "node_version": "v22.11.0"
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/version
```

---

### Configuration

#### POST /conduit/config/reload

Hot-reloads reloadable configuration sections (ACL, rate limits, cache TTLs, observability, guardrails) without restarting the gateway. Equivalent to sending `SIGHUP` to the process.

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Response 200:**

```json
{
  "reloaded": ["acl", "rate_limits", "cache_ttls", "observability"],
  "skipped": [],
  "errors": [],
  "reloaded_at": "2026-04-09T12:30:00.000Z"
}
```

**Response 500 (YAML error):**

```json
{
  "reloaded": [],
  "skipped": [],
  "errors": ["YAML syntax error at line 42: unexpected token"],
  "reloaded_at": "2026-04-09T12:30:00.000Z"
}
```

On error, the running configuration remains **unchanged**.

**curl example:**

```bash
curl -X POST http://localhost:8080/conduit/config/reload \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true"
```

---

### Logs

#### GET /conduit/logs

Query logs stored in SQLite with optional filters.

**Auth required:** Yes
**CSRF header required:** No

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Filter by server identifier |
| `tool` | string | Filter by tool name |
| `status` | string | `"ok"`, `"error"`, `"cache_hit"` |
| `from` | string | ISO 8601 start date (e.g., `2026-04-09T00:00:00Z`) |
| `to` | string | ISO 8601 end date |
| `trace_id` | string | Filter by trace ID |
| `client_id` | string | Filter by client identifier |
| `limit` | number | Number of results (default: 50) |
| `offset` | number | Pagination offset (default: 0) |

**Response 200:**

```json
{
  "count": 2,
  "offset": 0,
  "limit": 50,
  "logs": [
    {
      "id": 1,
      "trace_id": "conduit-abc123",
      "server": "salesforce",
      "tool": "get_contact",
      "client_id": "agent-support-1",
      "status": "ok",
      "duration_ms": 45,
      "cache_status": "MISS",
      "timestamp": "2026-04-09T12:00:00.000Z"
    }
  ]
}
```

**curl example:**

```bash
# Last 20 errors on the salesforce server
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  "http://localhost:8080/conduit/logs?server=salesforce&status=error&limit=20"
```

---

#### GET /conduit/logs/trace/:traceId

Returns all logs associated with a trace ID.

**Auth required:** Yes
**CSRF header required:** No

**Path parameter:**

| Parameter | Description |
|-----------|-------------|
| `traceId` | Trace identifier (format `conduit-<uuid>`) |

**Response 200:**

```json
{
  "trace_id": "conduit-abc123",
  "count": 3,
  "logs": [...]
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/logs/trace/conduit-abc123
```

---

### Statistics

#### GET /conduit/stats

Global gateway statistics.

**Auth required:** Yes
**CSRF header required:** No

**Response 200:**

```json
{
  "requests": {
    "total": 15420,
    "ok": 15100,
    "error": 320,
    "cache_hits": 8900
  },
  "cache": {
    "size": 4521,
    "max_size": 10000,
    "hit_rate": 0.577
  },
  "inflight": 3,
  "servers": ["salesforce", "github"]
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/stats
```

---

#### GET /conduit/stats/server/:id

Statistics for a specific server.

**Auth required:** Yes
**CSRF header required:** No

**Response 200:**

```json
{
  "server_id": "salesforce",
  "url": "http://localhost:3001/mcp",
  "healthy": true,
  "latency_ms": 23,
  "tools_count": 12,
  "total_requests": 5420,
  "error_rate": 0.021,
  "cache_hit_rate": 0.643
}
```

**Response 404:**

```json
{"error": "Serveur introuvable : salesforce"}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/stats/server/salesforce
```

---

#### GET /conduit/stats/tool/:name

Statistics for a specific tool.

**Auth required:** Yes
**CSRF header required:** No

**Response 200:**

```json
{
  "tool_name": "get_contact",
  "total_requests": 2100,
  "error_rate": 0.005,
  "cache_hit_rate": 0.82,
  "avg_duration_ms": 34.2
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/stats/tool/get_contact
```

---

#### GET /conduit/stats/client/:id

Statistics for a specific client.

**Auth required:** Yes
**CSRF header required:** No

**Response 200:**

```json
{
  "client_id": "agent-support-1",
  "total_requests": 430,
  "error_rate": 0.014
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/stats/client/agent-support-1
```

---

### Cache

#### GET /conduit/cache/stats

Detailed cache statistics for both L1 (in-memory) and L2 (Redis, if configured).

**Auth required:** Yes
**CSRF header required:** No

**Response 200:**

```json
{
  "l1": {
    "size": 4521,
    "max_size": 10000,
    "hit_rate": 0.577,
    "hits": 8900,
    "misses": 6520
  },
  "l2": {
    "size": 12300,
    "hits": 3200,
    "misses": 1800,
    "hit_rate": 0.64
  }
}
```

> Note: The `l2` field is only present when L2 Redis cache is configured.

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/cache/stats
```

---

#### DELETE /conduit/cache/server/:id

Invalidate all cache entries for a server.

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Response 200:**

```json
{
  "server_id": "salesforce",
  "deleted_count": 342
}
```

**curl example:**

```bash
curl -X DELETE \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true" \
  http://localhost:8080/conduit/cache/server/salesforce
```

---

#### DELETE /conduit/cache/key/:key

Delete a cache entry by its exact key (SHA-256 hash).

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Response 200:**

```json
{
  "deleted": true,
  "key": "abc123..."
}
```

**curl example:**

```bash
curl -X DELETE \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true" \
  http://localhost:8080/conduit/cache/key/abc123def456
```

---

#### DELETE /conduit/cache/l2/flush

Flush the entire L2 Redis cache.

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Response 200 (L2 configured):**

```json
{
  "flushed": true,
  "deleted_count": 5430,
  "flushed_at": "2026-04-09T12:00:00.000Z"
}
```

**Response 200 (L2 not configured):**

```json
{
  "flushed": false,
  "reason": "L2 cache not configured"
}
```

**curl example:**

```bash
curl -X DELETE \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true" \
  http://localhost:8080/conduit/cache/l2/flush
```

---

### Prometheus Metrics

#### GET /conduit/metrics

Returns metrics in Prometheus text exposition format.

**Auth required:** Yes
**CSRF header required:** No

**Content-Type:** `text/plain; version=0.0.4`

**Response 200:**

```
# HELP conduit_requests_total Total requests proxied
# TYPE conduit_requests_total counter
conduit_requests_total{server="salesforce",method="tools/call",tool="get_contact",status="ok"} 2100
conduit_requests_total{server="github",method="tools/call",tool="list_repos",status="ok"} 850
...
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/metrics
```

---

### Backend Servers

#### GET /conduit/servers

List all registered servers with their health status and tools.

**Auth required:** Yes
**CSRF header required:** No

**Response 200:**

```json
{
  "servers": [
    {
      "id": "salesforce",
      "url": "http://localhost:3001/mcp",
      "healthy": true,
      "latency_ms": 12,
      "tools_count": 12,
      "tools": ["get_contact", "create_contact", "search_leads"],
      "replicas": [
        {
          "index": 0,
          "url": "http://localhost:3001/mcp",
          "healthy": true,
          "latency_ms": 12,
          "active_connections": 2
        }
      ]
    }
  ]
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/servers
```

---

#### POST /conduit/servers

Register a new server dynamically at runtime.

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Request body:**

```json
{
  "id": "new-server",
  "url": "http://new-server:3003/mcp",
  "transport": "http",
  "cache": {
    "default_ttl": 300
  },
  "timeout_ms": 15000
}
```

**Response 201:**

```json
{
  "server_id": "new-server",
  "tools_count": 8,
  "registered_at": "2026-04-09T12:00:00.000Z"
}
```

**Response 409 (already exists):**

```json
{"error": "Server \"new-server\" already exists"}
```

**curl example:**

```bash
curl -X POST http://localhost:8080/conduit/servers \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "new-server",
    "url": "http://new-server:3003/mcp",
    "cache": {"default_ttl": 300}
  }'
```

---

#### DELETE /conduit/servers/:id

Remove a server dynamically.

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Response 200:**

```json
{
  "server_id": "new-server",
  "removed": true,
  "removed_at": "2026-04-09T12:00:00.000Z"
}
```

**Response 404:**

```json
{"error": "Serveur introuvable : new-server"}
```

**curl example:**

```bash
curl -X DELETE \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true" \
  http://localhost:8080/conduit/servers/new-server
```

---

#### POST /conduit/servers/:id/refresh

Force a refresh of a server's tool list (calls `tools/list` on the upstream).

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Response 200:**

```json
{
  "server_id": "salesforce",
  "tools_count": 14,
  "refreshed_at": "2026-04-09T12:00:00.000Z"
}
```

**curl example:**

```bash
curl -X POST \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true" \
  http://localhost:8080/conduit/servers/salesforce/refresh
```

---

#### GET /conduit/dedup/inflight

Requests currently being deduplicated (waiting for the result of a first identical request).

**Auth required:** Yes
**CSRF header required:** No

**Response 200:**

```json
{
  "count": 2,
  "inflight": [
    {
      "key": "salesforce:get_contact:abc123",
      "waiters": 3
    }
  ]
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/dedup/inflight
```

---

### ACL

#### GET /conduit/acl/check

Test an ACL policy without making an actual call. Useful for debugging access policies.

**Auth required:** Yes
**CSRF header required:** No

**Query parameters:**

| Parameter | Required | Description |
|-----------|:--------:|-------------|
| `client` | Yes | Client identifier |
| `server` | Yes | Server identifier |
| `tool` | Yes | Tool name |

**Response 200 (ACL enabled):**

```json
{
  "allowed": false,
  "policy": "support-readonly",
  "reason": "Denied by policy 'support-readonly': delete_contact matches deny rule on server salesforce"
}
```

**Response 200 (ACL disabled):**

```json
{
  "allowed": true,
  "policy": "",
  "reason": "ACL disabled"
}
```

**Response 400 (missing parameters):**

```json
{"error": "Paramètres requis : client, server, tool"}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  "http://localhost:8080/conduit/acl/check?client=agent-support-1&server=salesforce&tool=delete_contact"
```

---

### Guardrails

#### GET /conduit/guardrails/rules

List all configured guardrail rules.

**Auth required:** Yes
**CSRF header required:** No

**Response 200 (enabled):**

```json
{
  "enabled": true,
  "default_action": "allow",
  "rules": [
    {
      "name": "block-destructive-tools",
      "tools": ["delete_*"],
      "action": "block",
      "message": "Destructive operations are blocked.",
      "severity": "high"
    }
  ]
}
```

**Response 200 (disabled):**

```json
{"enabled": false, "rules": []}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/guardrails/rules
```

---

#### GET /conduit/guardrails/check

Test a tool call against guardrails without making the actual call. Useful for debugging rules.

**Auth required:** Yes
**CSRF header required:** No

**Query parameters:**

| Parameter | Required | Description |
|-----------|:--------:|-------------|
| `client` | Yes | Client identifier |
| `server` | Yes | Server identifier |
| `tool` | Yes | Tool name |
| `args` | No | JSON string of tool arguments (default: `{}`) |

**Response 200:**

```json
{
  "action": "block",
  "rule_name": "block-destructive-tools",
  "reason": "Tool delete_contact matches rule 'block-destructive-tools'",
  "severity": "high"
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  "http://localhost:8080/conduit/guardrails/check?client=agent-support&server=salesforce&tool=delete_contact&args=%7B%7D"
```

---

#### GET /conduit/guardrails/stats

Guardrail action statistics derived from logs.

**Auth required:** Yes
**CSRF header required:** No

**Response 200:**

```json
{
  "total_actions": 42,
  "total_blocks": 15,
  "total_alerts": 27,
  "by_rule": {
    "block-destructive-tools": {"blocks": 15, "alerts": 0},
    "alert-large-batch": {"blocks": 0, "alerts": 27}
  }
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/guardrails/stats
```

---

### Rate Limits

#### GET /conduit/limits

All rate limit buckets with their current usage.

**Auth required:** Yes
**CSRF header required:** No

**Response 200:**

```json
{
  "enabled": true,
  "buckets": [
    {
      "key": "global:minute",
      "limit": 1000,
      "current": 245,
      "window_ms": 60000,
      "reset_at": 1744200060000
    },
    {
      "key": "client:agent-support-1:minute",
      "limit": 60,
      "current": 14,
      "window_ms": 60000,
      "reset_at": 1744200060000
    }
  ]
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/limits
```

---

#### GET /conduit/limits/client/:id

Detailed quota for a specific client.

**Auth required:** Yes
**CSRF header required:** No

**Response 200:**

```json
{
  "client_id": "agent-support-1",
  "enabled": true,
  "limits": [
    {
      "label": "per client / minute",
      "limit": 60,
      "remaining": 46,
      "reset_at": 1744200060000
    }
  ]
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/limits/client/agent-support-1
```

---

#### DELETE /conduit/limits/reset

Reset all rate limit counters.

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Response 200:**

```json
{
  "reset": true,
  "reset_at": "2026-04-09T12:00:00.000Z"
}
```

**curl example:**

```bash
curl -X DELETE \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true" \
  http://localhost:8080/conduit/limits/reset
```

---

#### DELETE /conduit/limits/client/:id/reset

Reset rate limit counters for a specific client.

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Response 200:**

```json
{
  "reset": true,
  "client_id": "agent-support-1",
  "reset_at": "2026-04-09T12:00:00.000Z"
}
```

**curl example:**

```bash
curl -X DELETE \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true" \
  http://localhost:8080/conduit/limits/client/agent-support-1/reset
```

---

### Circuit Breakers

#### GET /conduit/circuits

State of all circuit breakers.

**Auth required:** Yes
**CSRF header required:** No

**Response 200:**

```json
{
  "count": 2,
  "circuits": [
    {
      "server_id": "salesforce",
      "replica_index": 0,
      "state": "closed",
      "failure_count": 0,
      "last_failure": null
    },
    {
      "server_id": "github",
      "replica_index": 0,
      "state": "open",
      "failure_count": 5,
      "last_failure": "2026-04-09T11:58:00.000Z"
    }
  ]
}
```

**Possible states:**

| State | Description |
|-------|-------------|
| `closed` | Normal: requests pass through |
| `open` | Circuit open: all requests are rejected immediately |
| `half-open` | Test: a probe request is sent to check recovery |

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/circuits
```

---

#### POST /conduit/circuits/:serverId/reset

Reset the circuit breaker for all replicas of a server (forces the `closed` state).

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Response 200:**

```json
{
  "server_id": "github",
  "reset": true,
  "reset_at": "2026-04-09T12:00:00.000Z"
}
```

**curl example:**

```bash
curl -X POST \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true" \
  http://localhost:8080/conduit/circuits/github/reset
```

---

#### POST /conduit/circuits/:serverId/replicas/:idx/reset

Reset the circuit breaker for a specific replica.

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Path parameters:**

| Parameter | Description |
|-----------|-------------|
| `serverId` | Server identifier |
| `idx` | Replica index (0-based) |

**Response 200:**

```json
{
  "server_id": "salesforce",
  "replica_index": 1,
  "reset": true,
  "reset_at": "2026-04-09T12:00:00.000Z"
}
```

**curl example:**

```bash
curl -X POST \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true" \
  http://localhost:8080/conduit/circuits/salesforce/replicas/1/reset
```

---

### Service Discovery

These endpoints are available only when `discovery` is enabled with an `http` backend.

#### POST /conduit/discover/register

Self-registration endpoint. MCP servers call this periodically as a heartbeat.

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Request body:**

```json
{
  "id": "my-mcp-server",
  "url": "http://10.0.1.5:3001/mcp",
  "transport": "http",
  "metadata": {
    "version": "1.2.0",
    "region": "us-east-1"
  }
}
```

**Response 200:**

```json
{
  "registered": true,
  "server_id": "my-mcp-server"
}
```

**curl example:**

```bash
curl -X POST http://localhost:8080/conduit/discover/register \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-mcp-server", "url": "http://10.0.1.5:3001/mcp"}'
```

---

#### DELETE /conduit/discover/deregister/:id

Manual deregistration of a discovered server.

**Auth required:** Yes
**CSRF header required:** Yes (`X-Conduit-Admin: true`)

**Response 200:**

```json
{
  "deregistered": true,
  "server_id": "my-mcp-server"
}
```

**curl example:**

```bash
curl -X DELETE \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  -H "X-Conduit-Admin: true" \
  http://localhost:8080/conduit/discover/deregister/my-mcp-server
```

---

#### GET /conduit/discover/status

Current discovery registrations.

**Auth required:** Yes
**CSRF header required:** No

**Response 200:**

```json
{
  "count": 3,
  "servers": [
    {
      "id": "my-mcp-server",
      "url": "http://10.0.1.5:3001/mcp",
      "transport": "http",
      "metadata": {"version": "1.2.0"}
    }
  ]
}
```

**curl example:**

```bash
curl -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" \
  http://localhost:8080/conduit/discover/status
```

---

### Dashboard

#### GET /conduit/dashboard

Serves the built-in React dashboard (SPA). Accessible without authentication: the HTML page itself contains no secrets. All API calls made from within the dashboard include the admin key from `localStorage`.

**Auth required:** No
**CSRF header required:** No

**curl example:**

```bash
# Open in browser
open http://localhost:8080/conduit/dashboard
```

---

## Error Codes

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success (for MCP: may contain a JSON-RPC error in the body) |
| 201 | Created (server registered) |
| 400 | Missing or invalid parameters |
| 401 | Authentication required (admin key missing or invalid) |
| 403 | Access denied (ACL or missing CSRF header) |
| 404 | Resource not found (unknown server, etc.) |
| 409 | Conflict (server already exists) |
| 429 | Rate limit exceeded |
| 500 | Internal gateway error |
| 501 | Feature not available |
| 503 | Service degraded (all backends down) |

### JSON-RPC MCP Error Codes

MCP errors use the standard JSON-RPC format with codes in the `-32000` to `-32603` range:

| Code | Meaning | Cause |
|------|---------|-------|
| `-32600` | Invalid Request | Malformed JSON-RPC request |
| `-32601` | Method Not Found | Unknown MCP method |
| `-32000` | Access denied | Denied by ACL |
| `-32000` | Rate limit exceeded | Quota exceeded |
| `-32000` | Authentication failed | Invalid JWT token or incorrect API key |
| `-32000` | Circuit breaker open | Backend circuit is open |
| `-32000` | Guardrail blocked | Request blocked by a guardrail rule |
| `-32000` | Server not found | Unknown server identifier |
| `-32603` | Internal error | Internal gateway or backend error |

**Full error format:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "Rate limit exceeded",
    "data": {
      "limit": 60,
      "window": "minute",
      "retry_after": 45
    }
  }
}
```
