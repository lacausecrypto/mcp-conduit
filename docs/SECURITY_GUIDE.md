# Security Guide — Conduit

## Before You Start

This guide explains how to secure your Conduit deployment, step by step.

**If you read only one page of this documentation, read this one.**

MCP (Model Context Protocol) allows AI agents to call tools that can access your data, send emails, modify databases, and much more. A misconfiguration can expose these capabilities to anyone on the internet. This guide shows you how to prevent that.

---

## 1. Production Checklist

Before deploying Conduit to production, verify each item:

| # | Item | Priority | How to verify |
|---|------|----------|---------------|
| 1 | Authentication enabled (`auth.method` != `none`) | Critical | Check config: `auth.method` should be `jwt` or `api-key` |
| 2 | Admin API key set (`CONDUIT_ADMIN_KEY`) | Critical | `curl http://host/conduit/stats` should return 401 |
| 3 | HTTPS enabled (TLS or reverse proxy) | Critical | `curl -I https://host/conduit/health` should succeed |
| 4 | Secrets not in git (`.env` in `.gitignore`) | Critical | `git grep -l CONDUIT_ADMIN_KEY` should return nothing |
| 5 | Rate limiting enabled | High | Check config: `rate_limits.enabled: true` |
| 6 | ACL configured with `default_action: deny` | High | Check config: `acl.enabled: true` |
| 7 | Sensitive fields redacted in logs | High | Check config: `observability.redact_fields` covers your data |
| 8 | Guardrails block destructive tools | High | Check config: `guardrails.enabled: true` |
| 9 | Circuit breaker enabled | Medium | Check config: `router.circuit_breaker.enabled: true` |
| 10 | Admin port restricted by firewall/network | Medium | `curl http://public-ip:9090` should be unreachable from outside |
| 11 | SQLite database on persistent volume | Medium | Docker: check volume mount for `CONDUIT_DB_PATH` |
| 12 | Log retention configured | Low | Check config: `observability.retention_days` is set |

---

## 2. Authentication Setup

### When to Use JWT vs API Key

| Criterion | JWT | API Key |
|-----------|-----|---------|
| Identity provider available (Auth0, Keycloak, Okta) | Recommended | Not needed |
| Multiple tenants with different permissions | Recommended | Possible (manual) |
| Simple single-tenant deployment | Overkill | Recommended |
| Machine-to-machine (M2M) communication | Possible | Recommended |
| Token rotation | Automatic (short-lived tokens) | Manual key rotation |
| Setup complexity | Higher (requires IdP) | Lower |

### JWT Configuration

Best for multi-tenant environments with an existing identity provider.

```yaml
auth:
  method: jwt
  jwks_url: "https://your-idp.auth0.com/.well-known/jwks.json"
  issuer: "https://your-idp.auth0.com/"
  audience: "conduit"
  tenant_claim: "org_id"    # JWT claim -> tenant_id
  client_claim: "sub"       # JWT claim -> client_id
```

The gateway validates each JWT token by:
1. Fetching public keys from the JWKS endpoint
2. Verifying the token signature
3. Checking `iss` (issuer) and `aud` (audience) claims
4. Extracting `tenant_id` and `client_id` from the configured claims

### API Key Configuration

Best for simple deployments or machine-to-machine communication.

```yaml
auth:
  method: api-key
  api_keys:
    - key: "sk-agent-support-a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5"
      client_id: "agent-support"
      tenant_id: "acme-corp"
    - key: "sk-agent-admin-b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4"
      client_id: "agent-admin"
      tenant_id: "acme-corp"
```

Generate strong random keys:

```bash
# Generate a 64-character hex key
openssl rand -hex 32
```

**Security notes:**
- Never commit API keys to version control
- Inject keys via environment variables or a secret manager (Vault, AWS Secrets Manager, Kubernetes Secrets)
- Rotate keys periodically — add the new key, update clients, then remove the old key

---

## 3. ACL Configuration Patterns

### Pattern 1: Read-Only Support Agents

Support agents can only read data. All write operations are blocked.

```yaml
acl:
  enabled: true
  default_action: deny

  policies:
    - name: "support-readonly"
      clients: ["agent-support-*"]
      allow:
        - server: "*"
          tools: ["get_*", "search_*", "list_*", "fetch_*", "count_*"]
      deny:
        - server: "*"
          tools: ["create_*", "update_*", "delete_*", "send_*", "execute_*"]
```

### Pattern 2: Server-Scoped Access

Each agent team can only access their designated servers.

```yaml
acl:
  enabled: true
  default_action: deny

  policies:
    - name: "sales-team"
      clients: ["agent-sales-*"]
      allow:
        - server: "salesforce"
          tools: ["*"]

    - name: "engineering-team"
      clients: ["agent-eng-*"]
      allow:
        - server: "github"
          tools: ["*"]
        - server: "jira"
          tools: ["*"]

    - name: "admin-full-access"
      clients: ["agent-admin"]
      allow:
        - server: "*"
          tools: ["*"]
```

### Pattern 3: Graduated Permissions

Different permission levels for different agent tiers.

```yaml
acl:
  enabled: true
  default_action: deny

  policies:
    # Tier 1: Read-only
    - name: "tier-1-readonly"
      clients: ["agent-t1-*"]
      allow:
        - server: "*"
          tools: ["get_*", "list_*", "search_*"]

    # Tier 2: Read + Create
    - name: "tier-2-readwrite"
      clients: ["agent-t2-*"]
      allow:
        - server: "*"
          tools: ["get_*", "list_*", "search_*", "create_*", "update_*"]
      deny:
        - server: "*"
          tools: ["delete_*"]

    # Tier 3: Full access
    - name: "tier-3-admin"
      clients: ["agent-t3-*"]
      allow:
        - server: "*"
          tools: ["*"]
```

---

## 4. Guardrails Configuration

Guardrails provide an additional safety layer on top of ACL, inspecting tool arguments and applying rules.

### Scenario: Block Destructive Tools

```yaml
guardrails:
  enabled: true
  default_action: allow

  rules:
    - name: "block-destructive-operations"
      tools: ["delete_*", "remove_*", "drop_*", "truncate_*", "purge_*"]
      action: block
      message: "Destructive operations are not allowed. Contact an administrator."
      severity: critical
      webhook: "https://hooks.slack.com/services/T00/B00/XXXXX"
```

### Scenario: Limit Batch Sizes

Prevent runaway batch operations that could overwhelm downstream systems.

```yaml
guardrails:
  enabled: true
  default_action: allow

  rules:
    - name: "limit-batch-size"
      tools: ["batch_*", "bulk_*"]
      conditions:
        - field: "batch_size"
          operator: gt
          value: 500
      action: block
      message: "Batch size exceeds the maximum of 500. Split into smaller batches."
      severity: high

    - name: "alert-medium-batch"
      tools: ["batch_*", "bulk_*"]
      conditions:
        - field: "batch_size"
          operator: gt
          value: 100
      action: alert
      message: "Medium batch size detected. Monitoring."
      severity: medium
```

### Scenario: Detect PII in Tool Arguments

Block requests that appear to contain personally identifiable information.

```yaml
guardrails:
  enabled: true
  default_action: allow

  rules:
    # Block Social Security Numbers in any field
    - name: "block-ssn-in-query"
      tools: ["*"]
      conditions:
        - field: "query"
          operator: matches
          value: "\\d{3}-\\d{2}-\\d{4}"
      action: block
      message: "Potential SSN detected. Do not include PII in tool arguments."
      severity: critical

    # Alert on email patterns in search queries
    - name: "alert-email-in-search"
      tools: ["search_*"]
      conditions:
        - field: "query"
          operator: matches
          value: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"
      action: alert
      message: "Email address detected in search query."
      severity: medium

    # Admin clients bypass all guardrails
    - name: "admin-bypass"
      clients: ["agent-admin"]
      bypass: true
      action: block
```

---

## 5. Rate Limiting Strategies

### Single Instance (Development / Small Production)

```yaml
rate_limits:
  enabled: true
  backend: memory

  global:
    requests_per_minute: 500
    requests_per_hour: 10000

  per_client:
    requests_per_minute: 60
    requests_per_hour: 1000
    requests_per_day: 10000

  queue:
    enabled: true
    max_wait_ms: 3000
    max_queue_size: 20
```

### Multi-Instance (Kubernetes / Distributed)

Requires Redis for shared counters across instances.

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
      per_tool:
        # Expensive tools get stricter limits
        create_contact:
          requests_per_minute: 10
        send_email:
          requests_per_minute: 5
          requests_per_hour: 100

  queue:
    enabled: true
    max_wait_ms: 5000
    max_queue_size: 100
```

### Cost-Sensitive API Protection

When upstream MCP servers call expensive paid APIs.

```yaml
rate_limits:
  enabled: true
  backend: memory

  per_client:
    requests_per_minute: 30
    requests_per_hour: 500
    requests_per_day: 5000

  overrides:
    - server: openai-tools
      requests_per_minute: 50
      per_tool:
        generate_text:
          requests_per_minute: 10
          requests_per_hour: 100
        generate_image:
          requests_per_minute: 2
          requests_per_hour: 20
```

---

## 6. TLS Configuration

### Option A: Reverse Proxy (Recommended)

Place a reverse proxy (Caddy, nginx, Traefik) in front of Conduit. The proxy handles TLS termination; Conduit listens on HTTP internally.

**Caddy (simplest — automatic Let's Encrypt):**

```
# Caddyfile
mydomain.com {
    reverse_proxy localhost:8080
}
```

**nginx:**

```nginx
server {
    listen 443 ssl http2;
    server_name mydomain.com;

    ssl_certificate /etc/letsencrypt/live/mydomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mydomain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Restrict admin endpoints to internal network
    location /conduit/ {
        allow 10.0.0.0/8;
        allow 192.168.0.0/16;
        deny all;
        proxy_pass http://localhost:8080;
    }

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Option B: Native TLS

For simple deployments without a reverse proxy.

```bash
# Obtain certificates with Let's Encrypt
certbot certonly --standalone -d mydomain.com
```

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

Set up automatic certificate renewal:

```bash
# Add to crontab
0 3 * * * certbot renew --quiet && curl -X POST http://localhost:8080/conduit/config/reload \
  -H "Authorization: Bearer $CONDUIT_ADMIN_KEY" -H "X-Conduit-Admin: true"
```

---

## 7. Docker / Kubernetes Security

### Docker Compose

```yaml
# docker-compose.yml
services:
  gateway:
    image: conduit:latest
    ports:
      - "8080:8080"       # MCP port — exposed to clients
      # Do NOT expose port 9090 externally (Prometheus metrics)
    environment:
      - CONDUIT_ADMIN_KEY=${CONDUIT_ADMIN_KEY}
      - CONDUIT_DB_PATH=/data/conduit-logs.db
      - CONDUIT_REDIS_URL=redis://redis:6379
    volumes:
      - conduit-data:/data                        # Persistent SQLite storage
      - ./conduit.config.yml:/app/conduit.config.yml:ro
    read_only: true                             # Read-only filesystem
    security_opt:
      - no-new-privileges:true
    user: "1000:1000"                           # Non-root user
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/conduit/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis-data:/data
    # Do NOT expose Redis port externally

volumes:
  conduit-data:
  redis-data:
```

### Kubernetes

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: conduit
spec:
  replicas: 3
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: gateway
          image: conduit:latest
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 9090
              name: metrics
          env:
            - name: CONDUIT_ADMIN_KEY
              valueFrom:
                secretKeyRef:
                  name: conduit-secrets
                  key: admin-key
            - name: CONDUIT_REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: conduit-secrets
                  key: redis-url
            - name: CONDUIT_DB_PATH
              value: "/data/conduit-logs.db"
          volumeMounts:
            - name: data
              mountPath: /data
            - name: config
              mountPath: /app/conduit.config.yml
              subPath: conduit.config.yml
              readOnly: true
          livenessProbe:
            httpGet:
              path: /conduit/health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /conduit/readyz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: conduit-data
        - name: config
          configMap:
            name: conduit-config
```

**Network Policy — restrict Prometheus port to monitoring namespace:**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: conduit-policy
spec:
  podSelector:
    matchLabels:
      app: conduit
  ingress:
    # Allow MCP traffic from any source
    - ports:
        - port: 8080
    # Allow metrics only from monitoring namespace
    - from:
        - namespaceSelector:
            matchLabels:
              name: monitoring
      ports:
        - port: 9090
```

---

## 8. Monitoring and Alerting

### Key Metrics to Monitor

| Metric | Alert Threshold | Description |
|--------|-----------------|-------------|
| `conduit_requests_total{status="error"}` | Error rate > 5% | High error rate indicates backend issues |
| `conduit_request_duration_seconds` | p99 > 5s | Slow responses indicate overloaded backends |
| `conduit_cache_hit_rate` | Drop below 30% | Cache may be misconfigured or undersized |
| `conduit_circuit_breaker_state` | `open` | Backend is failing — investigate immediately |
| `conduit_rate_limit_rejections_total` | Spike | Client may be abusive or limits too strict |
| `conduit_guardrail_blocks_total` | Spike | Potential abuse or misconfigured guardrails |

### Prometheus Alerting Rules

```yaml
# prometheus-alerts.yml
groups:
  - name: conduit
    rules:
      - alert: ConduitHighErrorRate
        expr: rate(conduit_requests_total{status="error"}[5m]) / rate(conduit_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Conduit error rate exceeds 5%"

      - alert: ConduitBackendDown
        expr: conduit_backend_healthy == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "All backends are unhealthy"

      - alert: ConduitCircuitBreakerOpen
        expr: conduit_circuit_breaker_state == 2
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Circuit breaker is open for {{ $labels.server_id }}"
```

### Grafana Dashboard Queries

```
# Request rate by server
rate(conduit_requests_total[5m])

# Cache hit rate
conduit_cache_hit_rate

# Error rate by server
rate(conduit_requests_total{status="error"}[5m])

# p95 latency
histogram_quantile(0.95, rate(conduit_request_duration_seconds_bucket[5m]))
```

---

## 9. Incident Response

### What Logs to Check

When investigating an incident, use these queries:

```bash
export GW="http://localhost:8080"
export AUTH="Authorization: Bearer $CONDUIT_ADMIN_KEY"

# 1. Check overall health
curl -H "$AUTH" $GW/conduit/health

# 2. Check circuit breaker states (is a backend failing?)
curl -H "$AUTH" $GW/conduit/circuits

# 3. Recent errors (last 50)
curl -H "$AUTH" "$GW/conduit/logs?status=error&limit=50"

# 4. Errors on a specific server
curl -H "$AUTH" "$GW/conduit/logs?server=salesforce&status=error&limit=20"

# 5. Trace a specific request
curl -H "$AUTH" "$GW/conduit/logs/trace/conduit-abc123-def456"

# 6. Check rate limit usage (is a client being throttled?)
curl -H "$AUTH" $GW/conduit/limits

# 7. Check a specific client's quota
curl -H "$AUTH" "$GW/conduit/limits/client/agent-support-1"

# 8. Check cache stats (is the cache working?)
curl -H "$AUTH" $GW/conduit/cache/stats

# 9. Check guardrail statistics (unexpected blocks?)
curl -H "$AUTH" $GW/conduit/guardrails/stats

# 10. Server-level statistics
curl -H "$AUTH" "$GW/conduit/stats/server/salesforce"
```

### Common Incident Patterns

| Symptom | Likely Cause | Resolution |
|---------|-------------|------------|
| All requests returning 503 | All backends unhealthy | Check backend health, reset circuit breakers |
| Specific tool returning errors | Backend tool failing | Check `/conduit/logs?tool=X&status=error` |
| Client receiving 429 | Rate limit exceeded | Check `/conduit/limits/client/:id`, consider increasing limits |
| High latency spike | Backend overloaded, cache miss storm | Check cache stats, check backend latency |
| Unexpected 403 errors | ACL misconfiguration | Use `/conduit/acl/check?client=X&server=Y&tool=Z` |
| Guardrail blocking valid requests | Rule too broad | Use `/conduit/guardrails/check` to test, adjust rules |

### Emergency Actions

```bash
# Reset all circuit breakers (unblock backends)
curl -X POST -H "$AUTH" -H "X-Conduit-Admin: true" \
  $GW/conduit/circuits/salesforce/reset

# Reset rate limits for a specific client
curl -X DELETE -H "$AUTH" -H "X-Conduit-Admin: true" \
  $GW/conduit/limits/client/agent-support-1/reset

# Flush L1 cache for a specific server
curl -X DELETE -H "$AUTH" -H "X-Conduit-Admin: true" \
  $GW/conduit/cache/server/salesforce

# Hot-reload config after making changes
curl -X POST -H "$AUTH" -H "X-Conduit-Admin: true" \
  $GW/conduit/config/reload
```

---

## 10. Security Audit Script

Run this script to verify your deployment is properly secured:

```bash
#!/bin/bash
# =============================================================
# Conduit — Security Audit Script
# Run this against your production deployment to verify security.
# Usage: ./security-audit.sh http://localhost:8080
# =============================================================

GW="${1:-http://localhost:8080}"
PASS=0
WARN=0
FAIL=0

echo "======================================"
echo "Conduit Security Audit"
echo "Target: $GW"
echo "Date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "======================================"
echo ""

# Helper functions
pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
warn() { echo "[WARN] $1"; WARN=$((WARN + 1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); }

# 1. Health check responds
echo "--- Basic Connectivity ---"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GW/conduit/health" 2>/dev/null)
if [ "$STATUS" = "200" ] || [ "$STATUS" = "503" ]; then
  pass "Health endpoint responds (HTTP $STATUS)"
else
  fail "Health endpoint unreachable (HTTP $STATUS)"
fi

# 2. Admin API is protected (should return 401 without key)
echo ""
echo "--- Admin API Authentication ---"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GW/conduit/stats" 2>/dev/null)
if [ "$STATUS" = "401" ]; then
  pass "Admin API requires authentication"
else
  fail "Admin API is OPEN without authentication (HTTP $STATUS) — set CONDUIT_ADMIN_KEY"
fi

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GW/conduit/version" 2>/dev/null)
if [ "$STATUS" = "401" ]; then
  pass "Version endpoint requires authentication"
else
  fail "Version endpoint is OPEN (HTTP $STATUS)"
fi

# 3. CSRF protection on state-changing endpoints
echo ""
echo "--- CSRF Protection ---"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$GW/conduit/config/reload" 2>/dev/null)
if [ "$STATUS" = "403" ] || [ "$STATUS" = "401" ]; then
  pass "POST endpoints have CSRF or auth protection (HTTP $STATUS)"
else
  fail "POST endpoint accessible without CSRF header (HTTP $STATUS)"
fi

# 4. MCP authentication (should not be open)
echo ""
echo "--- MCP Client Authentication ---"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$GW/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null)
if [ "$STATUS" = "401" ] || [ "$STATUS" = "403" ]; then
  pass "MCP endpoint requires client authentication (HTTP $STATUS)"
elif [ "$STATUS" = "200" ]; then
  warn "MCP endpoint is open (HTTP $STATUS) — ensure this is on a private network or enable auth"
else
  pass "MCP endpoint returned HTTP $STATUS (likely auth or server not found)"
fi

# 5. TLS check
echo ""
echo "--- TLS Configuration ---"
if echo "$GW" | grep -q "^https://"; then
  pass "Using HTTPS"
  # Check TLS version
  TLS_VERSION=$(curl -s -o /dev/null -w "%{ssl_version}" "$GW/conduit/health" 2>/dev/null)
  if [ -n "$TLS_VERSION" ]; then
    pass "TLS version: $TLS_VERSION"
  fi
else
  warn "Using HTTP — ensure a reverse proxy provides HTTPS in production"
fi

# 6. Security headers
echo ""
echo "--- Security Headers ---"
HEADERS=$(curl -s -I "$GW/conduit/health" 2>/dev/null)

if echo "$HEADERS" | grep -qi "x-content-type-options: nosniff"; then
  pass "X-Content-Type-Options: nosniff"
else
  warn "Missing X-Content-Type-Options header"
fi

if echo "$HEADERS" | grep -qi "x-frame-options: DENY"; then
  pass "X-Frame-Options: DENY"
else
  warn "Missing X-Frame-Options header"
fi

if echo "$HEADERS" | grep -qi "cache-control: no-store"; then
  pass "Cache-Control: no-store"
else
  warn "Missing Cache-Control: no-store header"
fi

# 7. Prometheus metrics port
echo ""
echo "--- Metrics Port ---"
METRICS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GW:9090/metrics" 2>/dev/null)
if [ "$METRICS_STATUS" = "000" ]; then
  pass "Metrics port not reachable from this host"
elif [ "$METRICS_STATUS" = "200" ]; then
  warn "Metrics port (9090) is reachable — restrict to monitoring network only"
else
  pass "Metrics port returned HTTP $METRICS_STATUS"
fi

# 8. Dashboard accessibility
echo ""
echo "--- Dashboard ---"
DASHBOARD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GW/conduit/dashboard" 2>/dev/null)
if [ "$DASHBOARD_STATUS" = "200" ]; then
  warn "Dashboard is publicly accessible (by design) — admin key is required for API calls from the dashboard"
fi

# Summary
echo ""
echo "======================================"
echo "AUDIT SUMMARY"
echo "======================================"
echo "  PASS: $PASS"
echo "  WARN: $WARN"
echo "  FAIL: $FAIL"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "RESULT: FAILED — Fix the issues above before deploying to production."
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "RESULT: PASSED WITH WARNINGS — Review the warnings above."
  exit 0
else
  echo "RESULT: PASSED — All checks passed."
  exit 0
fi
```

Save this script as `security-audit.sh` and run it:

```bash
chmod +x security-audit.sh
./security-audit.sh http://localhost:8080
```

Expected output for a properly secured deployment:

```
[PASS] Health endpoint responds (HTTP 200)
[PASS] Admin API requires authentication
[PASS] Version endpoint requires authentication
[PASS] POST endpoints have CSRF or auth protection (HTTP 401)
[PASS] MCP endpoint requires client authentication (HTTP 401)
...
RESULT: PASSED — All checks passed.
```

---

## Reporting a Vulnerability

If you discover a security vulnerability in Conduit, **do not create a public GitHub issue**. Public issues can be read by malicious actors before a fix is available.

**Contact:** Open a [private GitHub Security Advisory](https://github.com/your-org/mcp-conduit/security/advisories/new) in the repository.

Include:
- The affected version
- A description of the vulnerability
- Steps to reproduce
- Potential impact

We commit to responding within 72 hours and publishing a fix within 7 days for critical vulnerabilities.
