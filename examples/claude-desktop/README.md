# Claude Desktop Example

Instead of connecting Claude Desktop to each MCP server individually, connect
it to a single Conduit. The gateway aggregates all your servers, adds
caching to reduce latency, and provides a unified log of every tool call.

## Why use a gateway with Claude Desktop?

| Without gateway | With gateway |
|-----------------|--------------|
| Configure each server in `claude_desktop_config.json` | One entry in `claude_desktop_config.json` |
| No caching — every tool call hits the backend | L1 cache reduces redundant calls |
| No visibility into what Claude called | Full request log at `/conduit/logs` |
| Restart Claude to add/remove servers | Hot-reload to update config |

## Setup

### 1. Start your MCP servers

```bash
# Example — replace with your real servers
npx @salesforce/mcp-server &   # port 3001
npx @github/mcp-server &       # port 3002
npx @modelcontextprotocol/server-filesystem &  # port 3003
```

### 2. Start the gateway

```bash
# From the repository root
CONDUIT_CONFIG=./examples/claude-desktop/conduit.config.yml npm start
```

### 3. Configure Claude Desktop

Copy `claude_desktop_config.json` to the Claude Desktop config location:

**macOS:**
```bash
cp claude_desktop_config.json ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Windows:**
```powershell
Copy-Item claude_desktop_config.json "$env:APPDATA\Claude\claude_desktop_config.json"
```

Or merge the `mcpServers` block into your existing config.

### 4. Restart Claude Desktop

Claude Desktop will now connect to the gateway. All tools from all configured
servers appear in Claude's tool list, prefixed by server name
(`salesforce.get_contact`, `github.list_repos`, `filesystem.read_file`).

## View logs

```bash
# What has Claude been calling?
curl http://localhost:8080/conduit/logs | jq '.logs[] | {tool: .tool_name, status: .status}'

# Cache hit rate
curl http://localhost:8080/conduit/cache/stats | jq '.hit_rate'
```

## Add a new server without restarting Claude

1. Add the server to `conduit.config.yml`
2. Reload the gateway: (note — server URL changes require a full restart)
   ```bash
   kill -HUP $(pgrep -f "node dist/index.js")
   ```
3. Refresh tools in Claude Desktop (usually automatic)

## Troubleshooting

**Gateway not starting:** Check that ports 3001–3003 are bound by your MCP servers.

**Tools not appearing in Claude:** Verify the gateway is healthy:
```bash
curl http://localhost:8080/conduit/health
```

**Slow responses:** Check cache stats — a low hit rate means most calls bypass the cache.
Look at tool annotations and cache TTL config.
