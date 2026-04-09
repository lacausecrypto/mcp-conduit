# Conduit — Complete Configuration Reference

This page documents **every field** in the `conduit.config.yml` configuration file, including its type, default value, description, and corresponding environment variable override.

Environment variables **always take precedence** over the configuration file.

---

## Table of Contents

1. [`gateway`](#1-gateway) — HTTP gateway
2. [`router`](#2-router) — Multi-server routing
3. [`servers[]`](#3-servers) — Upstream MCP servers
4. [`cache`](#4-cache) — L1 + L2 cache
5. [`auth`](#5-authentication) — Authentication
6. [`acl`](#6-acl) — Access control
7. [`rate_limits`](#7-rate-limits) — Rate limiting
8. [`tenant_isolation`](#8-tenant-isolation) — Tenant isolation
9. [`guardrails`](#9-guardrails) — AI guardrails
10. [`observability`](#10-observability) — Logs, redaction, OpenTelemetry
11. [`metrics`](#11-metrics) — Prometheus
12. [`admin`](#12-admin) — Administration API
13. [`plugins`](#13-plugins) — Plugin system
14. [`discovery`](#14-discovery) — Service discovery

---

## 1. Gateway

Main HTTP gateway configuration.

### `gateway`

| Field | Type | Default | Env | Description |
|-------|------|---------|-----|-------------|
| `gateway.port` | `number` | `8080` | `CONDUIT_PORT` | TCP listening port |
| `gateway.host` | `string` | `"0.0.0.0"` | `CONDUIT_HOST` | Listening address. `"0.0.0.0"` = all interfaces. `"127.0.0.1"` = localhost only |

**Example:**

```yaml
gateway:
  port: 8080
  host: "0.0.0.0"
```

### `gateway.tls`

Native TLS configuration. Optional — if absent, the gateway runs in HTTP mode.

| Field | Type | Default | Env | Description |
|-------|------|---------|-----|-------------|
| `gateway.tls.enabled` | `boolean` | `false` | `CONDUIT_TLS_ENABLED` | Enable native HTTPS |
| `gateway.tls.cert_path` | `string` | — | `CONDUIT_TLS_CERT` | Absolute path to the PEM certificate file |
| `gateway.tls.key_path` | `string` | — | `CONDUIT_TLS_KEY` | Absolute path to the PEM private key file |
| `gateway.tls.ca_path` | `string` | — | — | CA bundle for mTLS (mutual TLS). Optional |
| `gateway.tls.min_version` | `"TLSv1.2"` \| `"TLSv1.3"` | `"TLSv1.2"` | — | Minimum accepted TLS version |

**Example:**

```yaml
gateway:
  port: 443
  host: "0.0.0.0"
  tls:
    enabled: true
    cert_path: "/etc/letsencrypt/live/mydomain.com/fullchain.pem"
    key_path: "/etc/letsencrypt/live/mydomain.com/privkey.pem"
    min_version: "TLSv1.2"
```

---

## 2. Router

Multi-server routing, health checks, load balancing, and circuit breaker configuration.

### `router`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `router.namespace_strategy` | `"prefix"` \| `"none"` | **required** | Tool naming strategy. `"prefix"`: prefixes with server id (`salesforce.get_contact`). `"none"`: raw name (`get_contact`) — startup error if two servers share a tool name |
| `router.load_balancing` | `"round-robin"` \| `"least-connections"` | `"round-robin"` | Request distribution strategy between replicas |

### `router.health_check`

Periodic health checks for upstream backends.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `router.health_check.enabled` | `boolean` | `true` | Enable health checks |
| `router.health_check.interval_seconds` | `number` | `30` | Interval between checks in seconds |
| `router.health_check.timeout_ms` | `number` | `5000` | Timeout per health check in milliseconds |
| `router.health_check.unhealthy_threshold` | `number` | `3` | Consecutive failures before marking a backend as unhealthy |
| `router.health_check.healthy_threshold` | `number` | `1` | Consecutive successes to mark a backend as healthy |

### `router.circuit_breaker`

Circuit breaker per replica. Optional — disabled by default.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `router.circuit_breaker.enabled` | `boolean` | `false` | Enable the circuit breaker |
| `router.circuit_breaker.failure_threshold` | `number` | `5` | Consecutive failures that trigger circuit opening |
| `router.circuit_breaker.reset_timeout_ms` | `number` | `30000` | Duration in open state (ms) before transitioning to half-open |
| `router.circuit_breaker.half_open_max_requests` | `number` | `1` | Requests allowed in half-open state for recovery testing |
| `router.circuit_breaker.success_threshold` | `number` | `2` | Consecutive successes in half-open needed to close the circuit |

**Example:**

```yaml
router:
  namespace_strategy: prefix
  load_balancing: least-connections
  health_check:
    enabled: true
    interval_seconds: 15
    timeout_ms: 3000
    unhealthy_threshold: 2
    healthy_threshold: 1
  circuit_breaker:
    enabled: true
    failure_threshold: 5
    reset_timeout_ms: 30000
    half_open_max_requests: 1
    success_threshold: 2
```

---

## 3. Servers

List of upstream MCP servers. At least one server is required.

### `servers[]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `servers[].id` | `string` | **required** | Unique server identifier. Used in URLs (`/mcp/:id`) and logs. Letters, digits, hyphens only |
| `servers[].url` | `string` | **required** | Full URL of the MCP endpoint (HTTP) or identifier string (stdio: `"stdio://server-name"`) |
| `servers[].transport` | `"http"` \| `"stdio"` | `"http"` | Transport type. `"http"`: communicates over HTTP. `"stdio"`: launches a child process communicating via stdin/stdout |
| `servers[].command` | `string` | — | Command to execute (required if `transport: stdio`) |
| `servers[].args` | `string[]` | `[]` | Command arguments (for `transport: stdio`) |
| `servers[].env` | `Record<string, string>` | `{}` | Additional environment variables passed to the child process (for `transport: stdio`) |
| `servers[].replicas[]` | `string[]` | `[]` | Additional URLs for load balancing (HTTP only). Requests are distributed across `url` + `replicas` |
| `servers[].timeout_ms` | `number` | `30000` | Timeout in milliseconds for calls to this server |

### `servers[].cache`

Cache configuration for a given server.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `servers[].cache.default_ttl` | `number` | **required** | Default TTL in seconds for cached tools on this server. `0` disables caching for this server |
| `servers[].cache.overrides` | `Record<string, ToolOverrideConfig>` | `{}` | Per-tool overrides. Key is the tool name (without namespace prefix) |
| `servers[].cache.overrides.<tool>.ttl` | `number` | — | Specific TTL for this tool. `0` = do not cache |
| `servers[].cache.overrides.<tool>.ignore_args` | `string[]` | `[]` | Arguments excluded from the cache key. Useful for timestamps, non-deterministic request IDs |
| `servers[].cache.overrides.<tool>.invalidates` | `string[]` | `[]` | List of tools whose cache is invalidated when this tool is called (e.g., a write tool invalidates reads) |

**Example (HTTP transport):**

```yaml
servers:
  - id: salesforce
    url: "http://sf-primary:3001/mcp"
    replicas:
      - "http://sf-replica-1:3001/mcp"
      - "http://sf-replica-2:3001/mcp"
    timeout_ms: 15000
    cache:
      default_ttl: 300
      overrides:
        get_contact:
          ttl: 600
        create_contact:
          ttl: 0
          invalidates:
            - get_contact
            - search_leads
        get_report:
          ttl: 300
          ignore_args:
            - timestamp
            - request_id
```

**Example (stdio transport):**

```yaml
servers:
  - id: local-tools
    transport: stdio
    command: "node"
    args: ["./mcp-server/index.js"]
    env:
      NODE_ENV: "production"
      API_KEY: "${LOCAL_TOOLS_API_KEY}"
    url: "stdio://local-tools"
    cache:
      default_ttl: 120
```

---

## 4. Cache

### `cache` (L1 — In-Memory)

Global L1 in-memory LRU cache configuration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cache.enabled` | `boolean` | `true` | Enable or disable caching. If `false`, all requests go to the backend |
| `cache.l1.max_entries` | `number` | `10000` | Maximum entries in the LRU cache. Beyond this, least recently used entries are evicted |
| `cache.l1.max_entry_size_kb` | `number` | `64` | Maximum size of a cache entry in KB. Larger responses are not cached |

**Example:**

```yaml
cache:
  enabled: true
  l1:
    max_entries: 50000
    max_entry_size_kb: 128
```

### `cache.l2` (L2 — Distributed Redis)

Optional distributed Redis cache layer. Provides shared caching across multiple gateway instances.

| Field | Type | Default | Env | Description |
|-------|------|---------|-----|-------------|
| `cache.l2.enabled` | `boolean` | `false` | — | Enable the L2 Redis cache |
| `cache.l2.redis_url` | `string` | — | `CONDUIT_REDIS_URL` | Redis connection URL. Format: `redis://[user:password@]host:port[/db]` |
| `cache.l2.default_ttl_multiplier` | `number` | `3` | — | L2 TTL = L1 TTL x this multiplier. Keeps L2 entries alive longer than L1 |
| `cache.l2.key_prefix` | `string` | `"conduit:cache:"` | — | Prefix for all Redis cache keys. Change if multiple gateways share the same Redis instance |
| `cache.l2.max_entry_size_kb` | `number` | `512` | — | Maximum entry size in KB for L2 storage |

**Example:**

```yaml
cache:
  enabled: true
  l1:
    max_entries: 10000
    max_entry_size_kb: 64
  l2:
    enabled: true
    redis_url: "redis://redis:6379"
    default_ttl_multiplier: 3
    key_prefix: "conduit:cache:"
    max_entry_size_kb: 512
```

---

## 5. Authentication

Client authentication configuration. Optional — if absent, `method: none` is used.

**WARNING:** `method: none` should only be used in development or on a fully secured private network.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auth.method` | `"jwt"` \| `"api-key"` \| `"none"` | `"none"` | Authentication method |

### JWT Mode (`method: jwt`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auth.jwks_url` | `string` | **required** | JWKS endpoint URL of your identity provider (e.g., Auth0, Keycloak, Okta) |
| `auth.issuer` | `string` | — | Expected value of the `iss` claim in the JWT. Recommended |
| `auth.audience` | `string` | — | Expected value of the `aud` claim in the JWT. Recommended |
| `auth.tenant_claim` | `string` | `"org_id"` | Name of the JWT claim containing the tenant identifier (used for isolation) |
| `auth.client_claim` | `string` | `"sub"` | Name of the JWT claim containing the client identifier (used for ACL and logs) |

**Example:**

```yaml
auth:
  method: jwt
  jwks_url: "https://my-idp.auth0.com/.well-known/jwks.json"
  issuer: "https://my-idp.auth0.com/"
  audience: "conduit"
  tenant_claim: "org_id"
  client_claim: "sub"
```

**Client-side usage:**

```
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

### API Key Mode (`method: api-key`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auth.api_keys[]` | `ApiKeyEntry[]` | **required** | List of authorized API keys |
| `auth.api_keys[].key` | `string` | **required** | The API key (arbitrary string, minimum 32 characters recommended) |
| `auth.api_keys[].client_id` | `string` | **required** | Client identifier associated with this key (used in logs and ACL) |
| `auth.api_keys[].tenant_id` | `string` | **required** | Tenant identifier associated with this key (used for isolation) |

**Example:**

```yaml
auth:
  method: api-key
  api_keys:
    - key: "sk-agent-support-a3f8b2c1d4e5f6a7b8c9"
      client_id: "agent-support"
      tenant_id: "acme-corp"
    - key: "sk-agent-admin-b9c8d7e6f5a4b3c2d1e0"
      client_id: "agent-admin"
      tenant_id: "acme-corp"
```

**Client-side usage:**

```
Authorization: Bearer sk-agent-support-a3f8b2c1d4e5f6a7b8c9
```

---

## 6. ACL

Granular access control by client, server, and tool. Optional — if absent, everything is allowed.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `acl.enabled` | `boolean` | `false` | Enable ACL policies |
| `acl.default_action` | `"allow"` \| `"deny"` | `"allow"` | Action applied if no policy matches the request. `"deny"` is more secure (whitelist approach) |
| `acl.policies[]` | `AclPolicy[]` | `[]` | Ordered list of policies. The **first** policy whose `clients` pattern matches is applied |

### ACL Policy (`acl.policies[]`)

| Field | Type | Description |
|-------|------|-------------|
| `policies[].name` | `string` | Policy name (for logs and debugging) |
| `policies[].clients` | `string[]` | `client_id` patterns using wildcards. E.g., `"agent-support-*"` matches `agent-support-1`, `agent-support-prod`, etc. `"*"` matches all |
| `policies[].allow[]` | `AclRule[]` | Allow rules |
| `policies[].allow[].server` | `string` | Server identifier (`"*"` = all servers) |
| `policies[].allow[].tools` | `string[]` | Allowed tool name patterns (`"get_*"`, `"*"`) |
| `policies[].deny[]` | `AclRule[]` | Deny rules (take priority over `allow`) |
| `policies[].deny[].server` | `string` | Server identifier |
| `policies[].deny[].tools` | `string[]` | Denied tool name patterns |

**Evaluation rule:** For each request, the first policy whose `client_id` matches is applied. Within that policy, if a `deny` rule matches, the request is denied. Otherwise, if an `allow` rule matches, the request is allowed. If nothing matches within the policy, `default_action` applies.

**Example:**

```yaml
acl:
  enabled: true
  default_action: deny

  policies:
    # Support agents: read-only
    - name: "support-readonly"
      clients: ["agent-support-*"]
      allow:
        - server: "*"
          tools: ["get_*", "search_*", "list_*", "fetch_*"]
      deny:
        - server: "*"
          tools: ["create_*", "update_*", "delete_*", "send_*"]

    # Admin agents: full access
    - name: "admin-full-access"
      clients: ["agent-admin"]
      allow:
        - server: "*"
          tools: ["*"]

    # Salesforce-only agent
    - name: "salesforce-only"
      clients: ["agent-sales-*"]
      allow:
        - server: "salesforce"
          tools: ["*"]
      deny:
        - server: "github"
          tools: ["*"]
```

---

## 7. Rate Limits

Request rate limiting. Optional — if absent, no limits are applied.

| Field | Type | Default | Env | Description |
|-------|------|---------|-----|-------------|
| `rate_limits.enabled` | `boolean` | `false` | — | Enable rate limiting |
| `rate_limits.backend` | `"memory"` \| `"redis"` | `"memory"` | Counter storage backend. `"memory"`: local to each instance. `"redis"`: shared across instances |
| `rate_limits.redis_url` | `string` | — | `CONDUIT_REDIS_URL` | Redis URL (required if `backend: redis`). E.g., `redis://localhost:6379` |

### Global Limits (`rate_limits.global`)

Applied to all requests regardless of client.

| Field | Type | Description |
|-------|------|-------------|
| `rate_limits.global.requests_per_minute` | `number` | Maximum requests per minute |
| `rate_limits.global.requests_per_hour` | `number` | Maximum requests per hour |
| `rate_limits.global.requests_per_day` | `number` | Maximum requests per day |

### Per-Client Limits (`rate_limits.per_client`)

Applied individually to each `client_id`.

| Field | Type | Description |
|-------|------|-------------|
| `rate_limits.per_client.requests_per_minute` | `number` | Maximum requests per client per minute |
| `rate_limits.per_client.requests_per_hour` | `number` | Maximum requests per client per hour |
| `rate_limits.per_client.requests_per_day` | `number` | Maximum requests per client per day |

### Per-Server Overrides (`rate_limits.overrides[]`)

| Field | Type | Description |
|-------|------|-------------|
| `overrides[].server` | `string` | Server identifier |
| `overrides[].requests_per_minute` | `number` | Global limit on this server |
| `overrides[].requests_per_hour` | `number` | Hourly limit on this server |
| `overrides[].requests_per_day` | `number` | Daily limit on this server |
| `overrides[].per_tool.<tool>.requests_per_minute` | `number` | Per-tool minute limit |
| `overrides[].per_tool.<tool>.requests_per_hour` | `number` | Per-tool hourly limit |
| `overrides[].per_tool.<tool>.requests_per_day` | `number` | Per-tool daily limit |

### Wait Queue (`rate_limits.queue`)

Instead of immediately rejecting a request that exceeds the limit, place it in a wait queue.

| Field | Type | Description |
|-------|------|-------------|
| `rate_limits.queue.enabled` | `boolean` | Enable the wait queue |
| `rate_limits.queue.max_wait_ms` | `number` | Maximum wait time in ms before rejecting the request |
| `rate_limits.queue.max_queue_size` | `number` | Maximum number of queued requests. Beyond this, immediate rejection |

**Example:**

```yaml
rate_limits:
  enabled: true
  backend: redis
  redis_url: "redis://redis:6379"

  global:
    requests_per_minute: 2000
    requests_per_hour: 50000

  per_client:
    requests_per_minute: 120
    requests_per_hour: 3000
    requests_per_day: 30000

  overrides:
    - server: salesforce
      requests_per_minute: 500
      per_tool:
        create_contact:
          requests_per_minute: 10
          requests_per_hour: 100
        send_email:
          requests_per_minute: 5

  queue:
    enabled: true
    max_wait_ms: 5000
    max_queue_size: 100
```

---

## 8. Tenant Isolation

Tenant-based isolation using an HTTP header.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tenant_isolation.enabled` | `boolean` | `false` | Enable tenant isolation |
| `tenant_isolation.header` | `string` | `"Authorization"` | HTTP header serving as the tenant identifier source. The header value is used to segment caches and logs by tenant |

**Example:**

```yaml
tenant_isolation:
  enabled: true
  header: "X-Tenant-Id"   # Clients send their tenant in X-Tenant-Id
```

---

## 9. Guardrails

AI guardrails inspect tool calls (tool name + arguments) and can block, alert, require approval, or transform arguments. Rules are evaluated in order — first match wins.

### `guardrails`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `guardrails.enabled` | `boolean` | `false` | Enable guardrails |
| `guardrails.default_action` | `"allow"` \| `"block"` | `"allow"` | Action applied if no rule matches |

### Guardrail Rules (`guardrails.rules[]`)

| Field | Type | Description |
|-------|------|-------------|
| `rules[].name` | `string` | Unique rule name (for logs and debugging) |
| `rules[].tools` | `string[]` | Tool name patterns with wildcards: `"delete_*"`, `"*"`. Optional — if omitted, matches all tools |
| `rules[].clients` | `string[]` | Client scoping patterns. Optional — if omitted, matches all clients |
| `rules[].servers` | `string[]` | Server scoping patterns. Optional — if omitted, matches all servers |
| `rules[].bypass` | `boolean` | If `true`, skip all guardrails for matching clients. The `action` field is irrelevant when bypass is enabled |
| `rules[].conditions` | `GuardrailCondition[]` | Conditions on tool arguments. All conditions must match (AND logic) |
| `rules[].action` | `"block"` \| `"alert"` \| `"require_approval"` \| `"transform"` | Action to take when the rule matches |
| `rules[].message` | `string` | Message returned to the client on block, or included in alert logs |
| `rules[].severity` | `"low"` \| `"medium"` \| `"high"` \| `"critical"` | Severity level for logging and alerting |
| `rules[].webhook` | `string` | Webhook URL for alerts (fire-and-forget HTTP POST) |

### Guardrail Conditions (`rules[].conditions[]`)

| Field | Type | Description |
|-------|------|-------------|
| `conditions[].field` | `string` | Dot-path in tool arguments: `"batch_size"`, `"options.limit"` |
| `conditions[].operator` | `ConditionOperator` | Comparison operator (see table below) |
| `conditions[].value` | `any` | Reference value (not required for `exists`/`not_exists`) |

**Available operators:**

| Operator | Description |
|----------|-------------|
| `eq` | Equal to value |
| `neq` | Not equal to value |
| `gt` | Greater than value |
| `gte` | Greater than or equal to value |
| `lt` | Less than value |
| `lte` | Less than or equal to value |
| `contains` | String contains value |
| `not_contains` | String does not contain value |
| `matches` | Matches regex pattern |
| `exists` | Field exists (value not required) |
| `not_exists` | Field does not exist (value not required) |

**Example:**

```yaml
guardrails:
  enabled: true
  default_action: allow

  rules:
    # Block destructive tools without explicit confirmation
    - name: "block-destructive-tools"
      tools: ["delete_*", "remove_*", "drop_*"]
      action: block
      message: "Destructive operations are blocked by policy. Contact an administrator."
      severity: high
      webhook: "https://hooks.slack.com/services/T00/B00/XXXXX"

    # Alert on large batch sizes
    - name: "alert-large-batch"
      tools: ["*"]
      conditions:
        - field: "batch_size"
          operator: gt
          value: 100
      action: alert
      message: "Large batch size detected."
      severity: medium

    # Block requests containing PII patterns
    - name: "block-ssn-in-args"
      tools: ["*"]
      conditions:
        - field: "query"
          operator: matches
          value: "\\d{3}-\\d{2}-\\d{4}"
      action: block
      message: "Potential SSN detected in tool arguments."
      severity: critical

    # Bypass guardrails for admin clients
    - name: "admin-bypass"
      clients: ["agent-admin"]
      bypass: true
      action: block
```

---

## 10. Observability

Structured logging, field redaction, and distributed tracing.

### `observability`

| Field | Type | Default | Env | Description |
|-------|------|---------|-----|-------------|
| `observability.log_args` | `boolean` | `true` | `CONDUIT_LOG_ARGS` | Log tool call arguments. Disable if arguments are large or contain sensitive data |
| `observability.log_responses` | `boolean` | `false` | — | Log tool responses. Enable only for debugging (very verbose) |
| `observability.redact_fields` | `string[]` | see below | — | Field names to mask in logs (case-insensitive comparison). Values are replaced with `"[REDACTED]"` |
| `observability.retention_days` | `number` | `30` | — | SQLite log retention in days. Older logs are automatically deleted |
| `observability.db_path` | `string` | `"./conduit-logs.db"` | `CONDUIT_DB_PATH` | Path to the SQLite log database. Use a persistent volume in production |

**Default redacted fields:** `password`, `api_key`, `token`, `secret`, `authorization`, `ssn`

### `observability.opentelemetry`

Optional OpenTelemetry distributed tracing integration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `observability.opentelemetry.enabled` | `boolean` | `false` | Enable OpenTelemetry trace export |
| `observability.opentelemetry.endpoint` | `string` | **required** | OTLP HTTP endpoint for trace export (e.g., `http://otel-collector:4318/v1/traces`) |
| `observability.opentelemetry.service_name` | `string` | `"conduit"` | Service name reported in traces |
| `observability.opentelemetry.sample_rate` | `number` | `1.0` | Sampling rate from `0.0` (no traces) to `1.0` (all traces) |

**Example:**

```yaml
observability:
  log_args: true
  log_responses: false
  redact_fields:
    - password
    - api_key
    - apikey
    - token
    - secret
    - authorization
    - bearer
    - private_key
    - ssn
    - credit_card
    - card_number
    - cvv
    # Add your domain-specific fields:
    - employee_id
    - social_security
  retention_days: 90
  db_path: "/data/conduit-logs.db"
  opentelemetry:
    enabled: true
    endpoint: "http://otel-collector:4318/v1/traces"
    service_name: "conduit"
    sample_rate: 0.5
```

---

## 11. Metrics

Prometheus metrics export.

| Field | Type | Default | Env | Description |
|-------|------|---------|-----|-------------|
| `metrics.enabled` | `boolean` | `true` | — | Enable Prometheus export |
| `metrics.port` | `number` | `9090` | `CONDUIT_METRICS_PORT` | Dedicated metrics server port. Metrics are also available at `/conduit/metrics` on the main port |

**Example:**

```yaml
metrics:
  enabled: true
  port: 9090
```

---

## 12. Admin

Administration API configuration.

| Field | Type | Default | Env | Description |
|-------|------|---------|-----|-------------|
| `admin.key` | `string` | — | `CONDUIT_ADMIN_KEY` | Bearer key protecting all `/conduit/*` endpoints (except `/conduit/health` and `/conduit/dashboard`). If absent, the admin API is open. **Always set in production** |

The key comparison uses `timingSafeEqual` to prevent timing attacks.

**Example:**

```yaml
admin:
  key: ""  # Leave empty here, use CONDUIT_ADMIN_KEY environment variable
```

---

## 13. Plugins

Extend the gateway pipeline with custom middleware plugins.

### `plugins[]`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `plugins[].name` | `string` | **required** | Display name of the plugin (for logs) |
| `plugins[].path` | `string` | **required** | Path to the plugin JS/TS file |
| `plugins[].hooks` | `HookName[]` | **required** | Hooks to activate for this plugin |
| `plugins[].config` | `Record<string, unknown>` | `{}` | Plugin-specific configuration passed to the plugin at initialization |

**Available hooks:**

| Hook | Description |
|------|-------------|
| `before:request` | Before authentication. Can reject or modify the request |
| `after:auth` | After successful authentication. Client identity is available |
| `before:cache` | Before cache lookup. Can bypass the cache |
| `after:upstream` | After the upstream backend response. Can modify the response |
| `before:response` | Before sending the response to the client. Last chance to modify |

**Example:**

```yaml
plugins:
  - name: "audit-logger"
    path: "./plugins/audit-logger.js"
    hooks:
      - "after:auth"
      - "before:response"
    config:
      log_level: "info"
      output_file: "/var/log/conduit-audit.log"

  - name: "request-enricher"
    path: "./plugins/enricher.js"
    hooks:
      - "before:request"
```

---

## 14. Discovery

Service discovery for automatic MCP server registration.

### `discovery`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `discovery.enabled` | `boolean` | `false` | Enable service discovery |
| `discovery.poll_interval_seconds` | `number` | `30` | How often to poll discovery backends (in seconds) |
| `discovery.stale_timeout_seconds` | `number` | `90` | Remove servers with no heartbeat after this delay (in seconds) |
| `discovery.default_cache` | `ServerCacheConfig` | **required** | Default cache configuration applied to discovered servers |
| `discovery.default_cache.default_ttl` | `number` | **required** | Default TTL in seconds for discovered server tools |

### Discovery Backends (`discovery.backends[]`)

| Field | Type | Description |
|-------|------|-------------|
| `backends[].type` | `"http"` \| `"dns"` \| `"consul"` | Backend type |
| `backends[].domain` | `string` | DNS SRV domain (required for `type: dns`). E.g., `"_mcp._tcp.services.local"` |
| `backends[].consul_url` | `string` | Consul server URL (required for `type: consul`) |
| `backends[].service_name` | `string` | Service name in Consul (required for `type: consul`) |

**HTTP backend:** MCP servers call `POST /conduit/discover/register` periodically as a heartbeat. No additional configuration is needed beyond `type: http`.

**DNS backend:** Discovers servers via DNS SRV records. The gateway periodically resolves the specified domain and registers any new servers found.

**Example:**

```yaml
discovery:
  enabled: true
  poll_interval_seconds: 30
  stale_timeout_seconds: 90
  default_cache:
    default_ttl: 120

  backends:
    - type: http
    - type: dns
      domain: "_mcp._tcp.services.local"
```

---

## Environment Variables Summary

All environment variables take precedence over the YAML configuration file.

| Variable | Config Field | Type | Default | Description |
|----------|-------------|------|---------|-------------|
| `CONDUIT_CONFIG` | — | string | `conduit.config.yml` | Path to the YAML configuration file |
| `CONDUIT_PORT` | `gateway.port` | number | `8080` | Gateway listening port |
| `CONDUIT_HOST` | `gateway.host` | string | `0.0.0.0` | Listening address |
| `CONDUIT_ADMIN_KEY` | `admin.key` | string | _(empty)_ | Bearer key for the admin API. If empty, the API is open |
| `CONDUIT_DB_PATH` | `observability.db_path` | string | `./conduit-logs.db` | SQLite log database path |
| `CONDUIT_METRICS_PORT` | `metrics.port` | number | `9090` | Prometheus server port |
| `CONDUIT_TLS_ENABLED` | `gateway.tls.enabled` | boolean | `false` | Enable native HTTPS |
| `CONDUIT_TLS_CERT` | `gateway.tls.cert_path` | string | — | Path to the PEM certificate |
| `CONDUIT_TLS_KEY` | `gateway.tls.key_path` | string | — | Path to the PEM private key |
| `CONDUIT_REDIS_URL` | `rate_limits.redis_url` / `cache.l2.redis_url` | string | — | Redis URL for distributed rate limiting and L2 cache |
| `CONDUIT_LOG_ARGS` | `observability.log_args` | boolean | `true` | Log tool arguments (`false` to disable) |
