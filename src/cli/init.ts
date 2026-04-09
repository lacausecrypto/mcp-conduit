/**
 * Interactive config generator: `npx conduit init`
 *
 * Generates a minimal conduit.config.yml by asking a few questions
 * via stdin/stdout. No external dependencies needed.
 */

import { createInterface } from 'node:readline';
import { writeFileSync, existsSync } from 'node:fs';
import { dump as yamlDump } from 'js-yaml';

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`  ${question} (${hint}): `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (!a) return resolve(defaultYes);
      resolve(a === 'y' || a === 'yes');
    });
  });
}

export async function runInit(): Promise<void> {
  console.log('');
  console.log('  MCP Conduit — Configuration Wizard');
  console.log('  ===================================');
  console.log('');

  const outputPath = 'conduit.config.yml';
  if (existsSync(outputPath)) {
    const overwrite = await askYesNo(`${outputPath} already exists. Overwrite?`, false);
    if (!overwrite) {
      console.log('  Aborted.');
      rl.close();
      return;
    }
  }

  // ─── Gateway ────────────────────────────────────────────────
  console.log('  1/5  Gateway');
  const port = await ask('Port', '8080');
  const host = await ask('Host', '0.0.0.0');

  // ─── Servers ────────────────────────────────────────────────
  console.log('');
  console.log('  2/5  MCP Servers');

  interface ServerEntry {
    id: string;
    url?: string;
    transport?: string;
    command?: string;
    args?: string[];
    cache: { default_ttl: number };
  }

  const servers: ServerEntry[] = [];
  let addMore = true;

  while (addMore) {
    const id = await ask('Server ID (e.g. "salesforce")', servers.length === 0 ? 'my-server' : '');
    if (!id) break;

    const transport = await ask('Transport (http/stdio)', 'http');

    if (transport === 'stdio') {
      const command = await ask('Command (e.g. "npx")', 'npx');
      const defaultDir = process.platform === 'win32' ? 'C:\\temp' : '/tmp';
      const argsStr = await ask('Arguments (comma-separated)', `-y,@modelcontextprotocol/server-filesystem,${defaultDir}`);
      const args = argsStr.split(',').map((a) => a.trim()).filter(Boolean);
      const ttl = await ask('Cache TTL seconds (0=disabled)', '60');

      servers.push({
        id,
        transport: 'stdio',
        command,
        args,
        url: `stdio://${command}`,
        cache: { default_ttl: parseInt(ttl, 10) || 0 },
      });
    } else {
      const url = await ask('URL', 'http://localhost:3000/mcp');
      const ttl = await ask('Cache TTL seconds (0=disabled)', '300');

      servers.push({
        id,
        url,
        cache: { default_ttl: parseInt(ttl, 10) || 0 },
      });
    }

    addMore = await askYesNo('Add another server?', false);
  }

  if (servers.length === 0) {
    servers.push({
      id: 'my-server',
      url: 'http://localhost:3000/mcp',
      cache: { default_ttl: 300 },
    });
  }

  // ─── Auth ───────────────────────────────────────────────────
  console.log('');
  console.log('  3/5  Authentication');
  const enableAuth = await askYesNo('Enable API key authentication?', false);
  let auth: Record<string, unknown> | undefined;
  if (enableAuth) {
    const keys = await ask('API keys (comma-separated)', 'sk-my-secret-key');
    auth = {
      method: 'api_key',
      api_keys: keys.split(',').map((k) => k.trim()).filter(Boolean),
    };
  }

  // ─── Admin ──────────────────────────────────────────────────
  console.log('');
  console.log('  4/5  Admin API');
  const enableAdmin = await askYesNo('Protect admin API with a key?', true);
  let adminKey: string | undefined;
  if (enableAdmin) {
    const { randomBytes } = await import('node:crypto');
    const generated = randomBytes(32).toString('hex');
    adminKey = await ask('Admin key', generated);
  }

  // ─── Extras ─────────────────────────────────────────────────
  console.log('');
  console.log('  5/5  Features');
  const enableRateLimit = await askYesNo('Enable rate limiting?', false);
  const enableGuardrails = await askYesNo('Enable AI guardrails?', false);

  rl.close();

  // ─── Build config ───────────────────────────────────────────

  const config: Record<string, unknown> = {
    gateway: {
      port: parseInt(port, 10),
      host,
    },

    router: {
      namespace_strategy: servers.length > 1 ? 'prefix' : 'none',
      health_check: {
        enabled: true,
        interval_seconds: 30,
        timeout_ms: 5000,
        unhealthy_threshold: 3,
        healthy_threshold: 1,
      },
    },

    servers: servers.map((s) => {
      const entry: Record<string, unknown> = { id: s.id, cache: s.cache };
      if (s.transport === 'stdio') {
        entry['transport'] = 'stdio';
        entry['command'] = s.command;
        entry['args'] = s.args;
        entry['url'] = s.url;
      } else {
        entry['url'] = s.url;
      }
      return entry;
    }),

    cache: {
      enabled: true,
      l1: { max_entries: 10000, max_entry_size_kb: 64 },
    },

    observability: {
      log_args: true,
      log_responses: false,
      redact_fields: ['password', 'token', 'secret', 'api_key', 'authorization'],
      retention_days: 30,
      db_path: './conduit-logs.db',
    },

    metrics: {
      enabled: true,
      port: 9090,
    },
  };

  if (auth) config['auth'] = auth;
  if (adminKey) config['admin'] = { key: adminKey };

  if (enableRateLimit) {
    config['rate_limits'] = {
      enabled: true,
      backend: 'memory',
      global: { requests: 1000, window_seconds: 60 },
      per_client: { requests: 100, window_seconds: 60 },
    };
  }

  if (enableGuardrails) {
    config['guardrails'] = {
      enabled: true,
      default_action: 'allow',
      rules: [
        {
          name: 'block-destructive-without-review',
          tools: ['delete_*', 'drop_*', 'remove_*'],
          action: 'block',
          message: 'Destructive tools require manual review',
          severity: 'high',
        },
      ],
    };
  }

  // ─── Write ──────────────────────────────────────────────────

  const yaml = yamlDump(config, { lineWidth: 120, noRefs: true });
  const header = `# MCP Conduit Configuration
# Generated by: npx conduit init
# Docs: https://github.com/lacausecrypto/mcp-conduit/blob/main/docs/CONFIGURATION.md
# JSON Schema: https://github.com/lacausecrypto/mcp-conduit/blob/main/conduit.schema.json
#
# Environment variable overrides (highest priority):
#   CONDUIT_PORT, CONDUIT_HOST, CONDUIT_ADMIN_KEY, CONDUIT_REDIS_URL, etc.

`;

  writeFileSync(outputPath, header + yaml, 'utf-8');

  console.log('');
  console.log(`  Config written to ${outputPath}`);
  console.log('');
  console.log('  Next steps:');
  console.log(`    npx conduit            # start the gateway`);
  console.log(`    npx conduit --help     # show all commands`);
  console.log('');
  if (adminKey) {
    console.log(`  Admin key: ${adminKey}`);
    console.log('  Save this key — it will not be shown again.');
    console.log('');
  }
}
