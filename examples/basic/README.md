# Basic Example

Minimal single-server setup. One MCP server behind the gateway, no authentication,
cache enabled with a 5-minute default TTL.

## What this demonstrates

- Proxying all MCP requests through the gateway
- L1 in-memory cache (5-minute TTL by default)
- Prometheus metrics on port 9090
- Structured logging to SQLite

## Quick start

```bash
cd examples/basic
docker compose up
```

Gateway is available at `http://localhost:8080`.

## MCP client configuration

Point any MCP client at the gateway instead of directly at your server:

```json
{
  "mcpServers": {
    "my-server": {
      "url": "http://localhost:8080/mcp/my-server"
    }
  }
}
```

## Admin API

```bash
# Health check
curl http://localhost:8080/conduit/health

# Cache stats
curl -H "Authorization: Bearer changeme" http://localhost:8080/conduit/cache/stats

# Request logs
curl -H "Authorization: Bearer changeme" http://localhost:8080/conduit/logs

# Prometheus metrics
curl http://localhost:9090/
```

## Hot-reload

Edit `conduit.config.yml`, then:

```bash
# Via admin API
curl -X POST -H "Authorization: Bearer changeme" http://localhost:8080/conduit/config/reload

# Or via SIGHUP (find the container PID)
docker compose exec gateway kill -HUP 1
```
