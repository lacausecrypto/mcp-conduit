import { describe, it, expect } from 'vitest';
import { generateCacheKey, extractTenantId } from '../../src/cache/cache-key.js';

describe('generateCacheKey', () => {
  it('génère une clé SHA-256 hexadécimale de 64 caractères', () => {
    const key = generateCacheKey({ serverId: 'test-server', toolName: 'get_contact', args: { id: '123' } });
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produit la même clé pour les mêmes entrées', () => {
    const opts = { serverId: 's1', toolName: 'tool', args: { a: 1, b: 2 } };
    expect(generateCacheKey(opts)).toBe(generateCacheKey(opts));
  });

  it('produit la même clé quel que soit l\'ordre des arguments', () => {
    const k1 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: { a: 1, b: 2 } });
    const k2 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: { b: 2, a: 1 } });
    expect(k1).toBe(k2);
  });

  it('produit des clés différentes pour des outils différents', () => {
    const k1 = generateCacheKey({ serverId: 's1', toolName: 'tool_a', args: {} });
    const k2 = generateCacheKey({ serverId: 's1', toolName: 'tool_b', args: {} });
    expect(k1).not.toBe(k2);
  });

  it('produit des clés différentes pour des serveurs différents', () => {
    const k1 = generateCacheKey({ serverId: 'server_a', toolName: 'tool', args: {} });
    const k2 = generateCacheKey({ serverId: 'server_b', toolName: 'tool', args: {} });
    expect(k1).not.toBe(k2);
  });

  it('produit des clés différentes pour des arguments différents', () => {
    const k1 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: { id: '123' } });
    const k2 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: { id: '456' } });
    expect(k1).not.toBe(k2);
  });

  it('inclut le tenantId dans la clé quand fourni', () => {
    const k1 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: {}, tenantId: 'tenant-a' });
    const k2 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: {}, tenantId: 'tenant-b' });
    const k3 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: {} });
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k2).not.toBe(k3);
  });

  it('inclut le groupId dans la clé quand fourni', () => {
    const k1 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: {}, groupId: 'group-x' });
    const k2 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: {}, groupId: 'group-y' });
    const k3 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: {} });
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('exclut les arguments listés dans ignoreArgs', () => {
    const k1 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: { id: '123', request_id: 'req-abc' }, ignoreArgs: ['request_id'] });
    const k2 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: { id: '123', request_id: 'req-xyz' }, ignoreArgs: ['request_id'] });
    expect(k1).toBe(k2);
  });

  it('un argument ignoré différent ne masque pas une vraie différence', () => {
    const k1 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: { id: '123', ts: 'old' }, ignoreArgs: ['ts'] });
    const k2 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: { id: '456', ts: 'new' }, ignoreArgs: ['ts'] });
    expect(k1).not.toBe(k2);
  });

  it('gère les arguments vides', () => {
    expect(() => generateCacheKey({ serverId: 's1', toolName: 'tool', args: {} })).not.toThrow();
  });

  it('gère les arguments imbriqués avec tri récursif', () => {
    const k1 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: { filter: { status: 'active', type: 'contact' } } });
    const k2 = generateCacheKey({ serverId: 's1', toolName: 'tool', args: { filter: { type: 'contact', status: 'active' } } });
    expect(k1).toBe(k2);
  });
});

describe('extractTenantId', () => {
  it('retourne undefined pour un en-tête absent', () => {
    expect(extractTenantId(undefined)).toBeUndefined();
  });

  it('retourne la valeur brute pour un en-tête non-JWT', () => {
    expect(extractTenantId('my-tenant-id')).toBe('my-tenant-id');
  });

  it('extrait le claim tenant_id d\'un JWT Bearer', () => {
    const payload = Buffer.from(JSON.stringify({ tenant_id: 'acme-corp', sub: 'user-123' })).toString('base64url');
    const token = `header.${payload}.signature`;
    expect(extractTenantId(`Bearer ${token}`)).toBe('acme-corp');
  });

  it('extrait le claim sub d\'un JWT quand tenant_id est absent', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user-456' })).toString('base64url');
    const token = `header.${payload}.signature`;
    expect(extractTenantId(`Bearer ${token}`)).toBe('user-456');
  });

  it('retourne la valeur brute pour un JWT Bearer malformé', () => {
    expect(extractTenantId('Bearer not-a-jwt')).toBe('not-a-jwt');
  });

  it('est insensible à la casse du préfixe Bearer', () => {
    const payload = Buffer.from(JSON.stringify({ tenant_id: 'my-tenant' })).toString('base64url');
    const token = `header.${payload}.signature`;
    expect(extractTenantId(`BEARER ${token}`)).toBe('my-tenant');
    expect(extractTenantId(`bearer ${token}`)).toBe('my-tenant');
  });
});
