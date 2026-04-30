import { describe, it, expect } from 'vitest';
import { validateConfig, mergeWithDefaults, DEFAULT_GATEWAY_CONFIG } from '../../src/config/schema.js';
import type { ConduitGatewayConfig } from '../../src/config/types.js';

/** Construit une config valide minimale (copie profonde pour éviter les mutations entre tests) */
function makeValidConfig(overrides: Partial<ConduitGatewayConfig> = {}): ConduitGatewayConfig {
  const base: ConduitGatewayConfig = JSON.parse(JSON.stringify(DEFAULT_GATEWAY_CONFIG)) as ConduitGatewayConfig;
  return {
    ...base,
    servers: [
      {
        id: 'test-server',
        url: 'http://localhost:3001/mcp',
        cache: { default_ttl: 300 },
      },
    ],
    ...overrides,
  };
}

describe('validateConfig', () => {
  it('accepte une configuration valide', () => {
    const errors = validateConfig(makeValidConfig());
    expect(errors).toHaveLength(0);
  });

  describe('gateway.port', () => {
    it('rejette un port en dehors de la plage valide (0)', () => {
      const errors = validateConfig(makeValidConfig({ gateway: { port: 0, host: '0.0.0.0' } }));
      expect(errors.some((e) => e.path === 'gateway.port')).toBe(true);
      expect(errors[0]?.message).toMatch(/port invalide|must be between/i);
    });

    it('rejette un port supérieur à 65535', () => {
      const errors = validateConfig(makeValidConfig({ gateway: { port: 65536, host: '0.0.0.0' } }));
      expect(errors.some((e) => e.path === 'gateway.port')).toBe(true);
    });

    it('accepte le port 8080', () => {
      const errors = validateConfig(makeValidConfig({ gateway: { port: 8080, host: '0.0.0.0' } }));
      expect(errors.filter((e) => e.path === 'gateway.port')).toHaveLength(0);
    });
  });

  describe('health_check', () => {
    it('rejette un interval_seconds <= 0', () => {
      const config = makeValidConfig();
      config.router.health_check.interval_seconds = 0;
      const errors = validateConfig(config);
      expect(errors.some((e) => e.path.includes('interval_seconds'))).toBe(true);
    });

    it('rejette un timeout_ms <= 0', () => {
      const config = makeValidConfig();
      config.router.health_check.timeout_ms = 0;
      const errors = validateConfig(config);
      expect(errors.some((e) => e.path.includes('timeout_ms'))).toBe(true);
    });

    it('rejette un unhealthy_threshold < 1', () => {
      const config = makeValidConfig();
      config.router.health_check.unhealthy_threshold = 0;
      const errors = validateConfig(config);
      expect(errors.some((e) => e.path.includes('unhealthy_threshold'))).toBe(true);
    });
  });

  describe('cache.l1', () => {
    it('rejette max_entries < 1', () => {
      const config = makeValidConfig();
      config.cache.l1.max_entries = 0;
      const errors = validateConfig(config);
      expect(errors.some((e) => e.path.includes('max_entries'))).toBe(true);
    });

    it('rejette max_entry_size_kb < 1', () => {
      const config = makeValidConfig();
      config.cache.l1.max_entry_size_kb = 0;
      const errors = validateConfig(config);
      expect(errors.some((e) => e.path.includes('max_entry_size_kb'))).toBe(true);
    });
  });

  describe('observability.retention_days', () => {
    it('rejette retention_days < 1', () => {
      const config = makeValidConfig();
      config.observability.retention_days = 0;
      const errors = validateConfig(config);
      expect(errors.some((e) => e.path.includes('retention_days'))).toBe(true);
    });
  });

  describe('metrics.port', () => {
    it('rejette un port de métriques invalide', () => {
      const config = makeValidConfig();
      config.metrics.port = 70000;
      const errors = validateConfig(config);
      expect(errors.some((e) => e.path === 'metrics.port')).toBe(true);
    });
  });

  describe('servers', () => {
    it('rejette un serveur sans identifiant', () => {
      const config = makeValidConfig({
        servers: [{ id: '', url: 'http://localhost:3001/mcp', cache: { default_ttl: 300 } }],
      });
      const errors = validateConfig(config);
      expect(errors.some((e) => e.path.includes('.id'))).toBe(true);
    });

    it('rejette un serveur sans URL', () => {
      const config = makeValidConfig({
        servers: [{ id: 'my-server', url: '', cache: { default_ttl: 300 } }],
      });
      const errors = validateConfig(config);
      expect(errors.some((e) => e.path.includes('.url'))).toBe(true);
    });

    it('rejette un serveur avec une URL invalide', () => {
      const config = makeValidConfig({
        servers: [{ id: 'my-server', url: 'not-a-url', cache: { default_ttl: 300 } }],
      });
      const errors = validateConfig(config);
      expect(errors.some((e) => e.path.includes('.url'))).toBe(true);
    });

    it('rejette un TTL par défaut négatif', () => {
      const config = makeValidConfig({
        servers: [{ id: 'my-server', url: 'http://localhost:3001/mcp', cache: { default_ttl: -1 } }],
      });
      const errors = validateConfig(config);
      expect(errors.some((e) => e.path.includes('default_ttl'))).toBe(true);
    });

    it('rejette un TTL de surcharge négatif', () => {
      const config = makeValidConfig({
        servers: [{
          id: 'my-server',
          url: 'http://localhost:3001/mcp',
          cache: {
            default_ttl: 300,
            overrides: { get_contact: { ttl: -5 } },
          },
        }],
      });
      const errors = validateConfig(config);
      expect(errors.some((e) => e.path.includes('ttl'))).toBe(true);
    });

    it('accepte un TTL de surcharge à 0 (désactiver le cache)', () => {
      const config = makeValidConfig({
        servers: [{
          id: 'my-server',
          url: 'http://localhost:3001/mcp',
          cache: {
            default_ttl: 300,
            overrides: { create_contact: { ttl: 0 } },
          },
        }],
      });
      const errors = validateConfig(config);
      expect(errors.filter((e) => e.path.includes('ttl'))).toHaveLength(0);
    });

    it('accepte une liste de serveurs vide', () => {
      const errors = validateConfig(makeValidConfig({ servers: [] }));
      expect(errors).toHaveLength(0);
    });

    it('retourne plusieurs erreurs si plusieurs serveurs sont invalides', () => {
      const config = makeValidConfig({
        servers: [
          { id: '', url: 'not-a-url', cache: { default_ttl: -1 } },
          { id: 'ok', url: 'http://localhost', cache: { default_ttl: 0 } },
        ],
      });
      const errors = validateConfig(config);
      // Should have at least errors for id, url, and ttl on first server
      expect(errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('connect.profiles', () => {
    it('accepts a valid custom connect profile', () => {
      const errors = validateConfig(makeValidConfig({
        connect: {
          profiles: [{
            id: 'sales',
            server_ids: ['test-server'],
          }],
        },
      }));
      expect(errors.filter((e) => e.path.startsWith('connect.profiles'))).toHaveLength(0);
    });

    it('rejects duplicate connect profile IDs', () => {
      const errors = validateConfig(makeValidConfig({
        connect: {
          profiles: [
            { id: 'sales', server_ids: ['test-server'] },
            { id: 'sales', server_ids: ['test-server'] },
          ],
        },
      }));
      expect(errors.some((e) => e.path === 'connect.profiles[1].id')).toBe(true);
    });

    it('rejects unknown server IDs inside a connect profile', () => {
      const errors = validateConfig(makeValidConfig({
        connect: {
          profiles: [{
            id: 'sales',
            server_ids: ['unknown-server'],
          }],
        },
      }));
      expect(errors.some((e) => e.path === 'connect.profiles[0].server_ids[0]')).toBe(true);
    });
  });

  describe('connect.registry', () => {
    it('accepts a valid registry configuration override', () => {
      const errors = validateConfig(makeValidConfig({
        connect: {
          registry: {
            base_url: 'https://registry.modelcontextprotocol.io',
            cache_ttl_seconds: 900,
            page_size: 50,
            max_pages: 4,
            latest_only: true,
          },
        },
      }));
      expect(errors.filter((e) => e.path.startsWith('connect.registry'))).toHaveLength(0);
    });

    it('accepts max_pages=0 to follow the full official registry pagination', () => {
      const errors = validateConfig(makeValidConfig({
        connect: {
          registry: {
            base_url: 'https://registry.modelcontextprotocol.io',
            max_pages: 0,
          },
        },
      }));
      expect(errors.filter((e) => e.path.startsWith('connect.registry'))).toHaveLength(0);
    });

    it('rejects an invalid registry base_url', () => {
      const errors = validateConfig(makeValidConfig({
        connect: {
          registry: {
            base_url: 'ftp://registry.modelcontextprotocol.io',
          },
        },
      }));
      expect(errors.some((e) => e.path === 'connect.registry.base_url')).toBe(true);
    });
  });
});

describe('mergeWithDefaults', () => {
  it('retourne les valeurs par défaut pour un objet vide', () => {
    const config = mergeWithDefaults({});
    expect(config.gateway.port).toBe(8080);
    expect(config.router.namespace_strategy).toBe('prefix');
    expect(config.cache.enabled).toBe(true);
    expect(config.servers).toEqual([]);
  });

  it('fusionne les serveurs depuis la configuration partielle', () => {
    const config = mergeWithDefaults({
      servers: [{ id: 'test', url: 'http://localhost/mcp' }],
    });
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]?.id).toBe('test');
    expect(config.servers[0]?.cache.default_ttl).toBe(0);
  });

  it('préserve le TTL explicite d\'un serveur', () => {
    const config = mergeWithDefaults({
      servers: [{ id: 'test', url: 'http://localhost/mcp', cache: { default_ttl: 120 } }],
    });
    expect(config.servers[0]?.cache.default_ttl).toBe(120);
  });

  it('normalise la configuration connect.profiles', () => {
    const config = mergeWithDefaults({
      servers: [{ id: 'test', url: 'http://localhost/mcp' }],
      connect: {
        profiles: [{
          id: 'sales',
          label: 'Sales',
          description: 'Only sales',
          server_ids: ['test'],
        }],
      },
    });

    expect(config.connect?.profiles?.[0]).toEqual({
      id: 'sales',
      label: 'Sales',
      description: 'Only sales',
      server_ids: ['test'],
    });
  });

  it('normalise la configuration connect.registry', () => {
    const config = mergeWithDefaults({
      connect: {
        registry: {
          base_url: 'https://registry.modelcontextprotocol.io',
          cache_ttl_seconds: 900,
          page_size: 50,
          max_pages: 4,
          latest_only: false,
        },
      },
    });

    expect(config.connect?.registry).toEqual({
      base_url: 'https://registry.modelcontextprotocol.io',
      cache_ttl_seconds: 900,
      page_size: 50,
      max_pages: 4,
      latest_only: false,
    });
  });

  it('normalise max_pages=0 pour une sync complète du registry', () => {
    const config = mergeWithDefaults({
      connect: {
        registry: {
          max_pages: 0,
        },
      },
    });

    expect(config.connect?.registry).toEqual({
      max_pages: 0,
    });
  });

  it('préserve admin.allow_private_networks quand il est explicitement activé', () => {
    const config = mergeWithDefaults({
      admin: {
        allow_private_networks: true,
      },
    });

    expect(config.admin?.allow_private_networks).toBe(true);
  });
});
