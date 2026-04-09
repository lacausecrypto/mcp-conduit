import { describe, it, expect } from 'vitest';
import { decideCachePolicy, getDefaultTtls } from '../../src/cache/cache-policy.js';
import type { ServerCacheConfig } from '../../src/config/types.js';

const BASE_SERVER_CONFIG: ServerCacheConfig = { default_ttl: 300 };

describe('decideCachePolicy', () => {
  describe('comportement par défaut (aucune annotation, aucune config)', () => {
    it('ne met pas en cache un outil sans annotation', () => {
      const result = decideCachePolicy('unknown_tool', {}, BASE_SERVER_CONFIG);
      expect(result.shouldCache).toBe(false);
      expect(result.isDestructive).toBe(false);
      expect(result.invalidates).toEqual([]);
    });
  });

  describe('annotation readOnlyHint', () => {
    it('met en cache avec TTL par défaut du serveur', () => {
      const result = decideCachePolicy('get_contact', { readOnlyHint: true }, BASE_SERVER_CONFIG);
      expect(result.shouldCache).toBe(true);
      expect(result.ttl).toBe(300);
      expect(result.isDestructive).toBe(false);
    });

    it('utilise le TTL par défaut des annotations si le serveur a TTL = 0', () => {
      const config: ServerCacheConfig = { default_ttl: 0 };
      const result = decideCachePolicy('get_contact', { readOnlyHint: true }, config);
      expect(result.shouldCache).toBe(true);
      expect(result.ttl).toBe(getDefaultTtls().readOnly);
    });
  });

  describe('annotation idempotentHint', () => {
    it('met en cache avec TTL court (min entre serveur et 2min)', () => {
      const result = decideCachePolicy('search', { idempotentHint: true }, BASE_SERVER_CONFIG);
      expect(result.shouldCache).toBe(true);
      expect(result.ttl).toBe(getDefaultTtls().idempotent);
      expect(result.isDestructive).toBe(false);
    });

    it('utilise le TTL du serveur si inférieur au TTL idempotent', () => {
      const config: ServerCacheConfig = { default_ttl: 60 };
      const result = decideCachePolicy('search', { idempotentHint: true }, config);
      expect(result.shouldCache).toBe(true);
      expect(result.ttl).toBe(60);
    });

    it('utilise le TTL par défaut des annotations si le serveur a TTL = 0', () => {
      const config: ServerCacheConfig = { default_ttl: 0 };
      const result = decideCachePolicy('search', { idempotentHint: true }, config);
      expect(result.shouldCache).toBe(true);
      expect(result.ttl).toBe(getDefaultTtls().idempotent);
    });
  });

  describe('annotation destructiveHint', () => {
    it('ne met jamais en cache un outil destructeur', () => {
      const result = decideCachePolicy('delete_contact', { destructiveHint: true }, BASE_SERVER_CONFIG);
      expect(result.shouldCache).toBe(false);
      expect(result.isDestructive).toBe(true);
    });

    it('priorité sur readOnlyHint', () => {
      const result = decideCachePolicy('weird_tool', { destructiveHint: true, readOnlyHint: true }, BASE_SERVER_CONFIG);
      expect(result.shouldCache).toBe(false);
      expect(result.isDestructive).toBe(true);
    });
  });

  describe('annotation openWorldHint', () => {
    it('met en cache avec TTL très court (30 secondes)', () => {
      const result = decideCachePolicy('web_search', { openWorldHint: true }, BASE_SERVER_CONFIG);
      expect(result.shouldCache).toBe(true);
      expect(result.ttl).toBe(getDefaultTtls().openWorld);
    });
  });

  describe('surcharges de configuration explicites', () => {
    it('respecte la surcharge TTL explicite', () => {
      const config: ServerCacheConfig = { default_ttl: 300, overrides: { get_contact: { ttl: 600 } } };
      const result = decideCachePolicy('get_contact', {}, config);
      expect(result.shouldCache).toBe(true);
      expect(result.ttl).toBe(600);
    });

    it('interdit le cache avec ttl: 0', () => {
      const config: ServerCacheConfig = {
        default_ttl: 300,
        overrides: { create_lead: { ttl: 0, invalidates: ['get_contact', 'search_leads'] } },
      };
      const result = decideCachePolicy('create_lead', {}, config);
      expect(result.shouldCache).toBe(false);
      expect(result.isDestructive).toBe(true);
      expect(result.invalidates).toEqual(['get_contact', 'search_leads']);
    });

    it('inclut ignore_args depuis la surcharge', () => {
      const config: ServerCacheConfig = {
        default_ttl: 300,
        overrides: { get_file: { ttl: 60, ignore_args: ['request_id', 'timestamp'] } },
      };
      const result = decideCachePolicy('get_file', {}, config);
      expect(result.ignoreArgs).toEqual(['request_id', 'timestamp']);
    });

    it('la surcharge de config prend priorité sur les annotations', () => {
      const config: ServerCacheConfig = { default_ttl: 300, overrides: { my_tool: { ttl: 999 } } };
      const result = decideCachePolicy('my_tool', { readOnlyHint: true }, config);
      expect(result.shouldCache).toBe(true);
      expect(result.ttl).toBe(999);
    });

    it('utilise le TTL par défaut du serveur si la surcharge ne spécifie pas de TTL', () => {
      const config: ServerCacheConfig = { default_ttl: 300, overrides: { my_tool: { ignore_args: ['ts'] } } };
      const result = decideCachePolicy('my_tool', {}, config);
      expect(result.shouldCache).toBe(true);
      expect(result.ttl).toBe(300);
    });
  });
});
