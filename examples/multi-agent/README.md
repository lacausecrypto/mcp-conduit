# Multi-Agent Example

Three AI agents share a single gateway that routes to Salesforce, GitHub, and
Slack MCP servers. The gateway enforces per-agent ACL policies, rate limits,
and differentiated cache TTLs — all without modifying the agents themselves.

## Architecture

```
support-agent (key: support-agent-key-abc123)
    │
    ├── POST /mcp/salesforce/...  → salesforce-mcp:3001  (allowed)
    └── POST /mcp/slack/...       → slack-mcp:3003       (allowed)
        POST /mcp/github/...      → DENIED by ACL

sales-agent (key: sales-agent-key-def456)
    │
    ├── POST /mcp/salesforce/...  → salesforce-mcp:3001  (get_contact, search_leads, create_lead only)
    └── POST /mcp/github/...      → github-mcp:3002      (list_repos, get_repo only)

admin-agent (key: admin-agent-key-xyz789)
    └── POST /mcp/*               → all backends         (full access)
```

## What this demonstrates

- **API-key auth** — each agent uses its own API key
- **ACL policies** — granular per-agent, per-server, per-tool access control
- **Rate limiting** — 200 req/min per agent, 1000 req/min global
- **Multi-server routing** — tool names prefixed (`salesforce.get_contact`)
- **Differentiated TTLs** — Salesforce contacts cached 10 min, Slack 30 sec
- **Cache invalidation** — creating a lead invalidates contact/search caches

## Quick Start

```bash
cd examples/multi-agent
docker compose up
```

Replace the mock MCP server images with your real server images before going to production.

## Test the ACL

```bash
# support-agent can reach Salesforce
curl -X POST http://localhost:8080/mcp/salesforce \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer support-agent-key-abc123" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# support-agent is blocked from GitHub
curl -X POST http://localhost:8080/mcp/github \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer support-agent-key-abc123" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# → 403 Forbidden

# Check ACL decision without making a real call
curl "http://localhost:8080/conduit/acl/check?client=support-agent-key-abc123&server=github&tool=list_repos" \
  -H "Authorization: Bearer admin-secret"
```

## Hot-Reload ACL

Update `conduit.config.yml` to add a new policy, then:

```bash
curl -X POST -H "Authorization: Bearer admin-secret" \
  http://localhost:8080/conduit/config/reload
```

The new policy applies immediately — no restart needed.
