# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in MCP Conduit, **do not open a public GitHub issue**.

Instead, please send a report to:

**security@lacause.dev**

Include as much detail as possible: steps to reproduce, affected versions, and potential impact. You will receive an acknowledgment within 48 hours and a detailed response within 7 days. We will work with you to understand and address the issue before any public disclosure.

## Supported Versions

| Version | Supported            |
|---------|----------------------|
| 0.2.x   | Yes                 |
| 0.1.x   | Security fixes only |
| < 0.1   | No                  |

## Security Best Practices

Follow these recommendations when deploying MCP Conduit:

1. **Always set an admin key.** The admin API must be protected by a strong, unique key (`CONDUIT_ADMIN_KEY`). Without one, anyone with network access can reconfigure the gateway.

2. **Enable authentication.** Configure JWT or API key authentication so that only authorized clients can reach upstream MCP servers. The default `none` mode is only appropriate for local development.

3. **Enable rate limiting.** Activate sliding window rate limiting (memory or Redis backend) to protect against abuse and denial-of-service attempts.

4. **Enable guardrails for destructive tools.** Use the AI Guardrails system to inspect, block, or require approval for tool calls that modify state. Define rules for any tool annotated as `destructive`.

5. **Never expose `/conduit/*` endpoints publicly.** The admin API, metrics, and health endpoints are intended for internal or operator access only. Place them behind a firewall, VPN, or authenticated reverse proxy.

6. **Use environment variables for secrets.** Store keys, tokens, and credentials in environment variables or a secrets manager. Never commit them to configuration files.

7. **Enable TLS or use a reverse proxy.** Run the gateway with native TLS enabled, or terminate TLS at a reverse proxy (nginx, Caddy, a cloud load balancer). Do not transmit credentials or tool call data over plain HTTP in production.

8. **Configure field redaction.** Enable the field redaction system to strip sensitive values (API keys, tokens, PII) from logs before they are written to SQLite. Expand the default redaction list if your tools handle additional sensitive fields.

9. **Restrict SQLite file access.** The SQLite log database contains tool call records. Set file permissions (`chmod 600`) so that only the gateway process and authorized operators can read it.

10. **Review ACL policies regularly.** Audit wildcard patterns and namespace-level permissions to ensure the principle of least privilege. Remove stale entries when servers or users are decommissioned.

## What NOT to Expose

The following endpoints must not be accessible to untrusted networks:

- `/conduit/admin/*` — gateway administration
- `/conduit/servers` — dynamic server management
- `/conduit/metrics` — Prometheus metrics
- `/conduit/health` — health check details (leaks version information)
- `/conduit/cache/*` — cache inspection and invalidation
- `/conduit/logs/*` — structured log queries
- `/conduit/guardrails/*` — guardrail configuration and status

## Known Limitations

We believe in being transparent about the current security boundaries:

- **Tool names are logged without redaction.** The redaction system covers field values but does not mask tool names in log records. Avoid encoding secrets in tool names.
- **SQLite contains tool call records.** Even with redaction enabled, the log database stores metadata about every tool invocation. Treat the SQLite file as sensitive data.
- **JWT trusts the configured JWKS endpoint.** The gateway fetches signing keys from the JWKS URL without additional pinning. A compromised JWKS endpoint can issue trusted tokens.
- **No encryption at rest for cache or logs.** Neither the in-memory/Redis cache nor the SQLite log database encrypts data at rest. Rely on disk encryption or infrastructure-level controls.
- **Guardrails are configuration-only.** Rules are defined in the configuration file or applied via hot-reload. There is no runtime API for creating, updating, or deleting individual guardrail rules.
- **The plugin system loads arbitrary code.** Plugins are loaded via dynamic `import()` from paths specified in configuration. Only configure plugin paths that you trust. A malicious plugin has full access to the gateway process.
