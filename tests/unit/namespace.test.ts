import { describe, it, expect } from 'vitest';
import {
  applyNamespace,
  resolveNamespacedTool,
  detectConflicts,
  buildNamespaceMap,
  resolveTool,
} from '../../src/router/namespace.js';

describe('applyNamespace', () => {
  it('préfixe le nom de l\'outil avec le serverId', () => {
    expect(applyNamespace('salesforce', 'get_contact')).toBe('salesforce.get_contact');
  });

  it('fonctionne avec des noms composés', () => {
    expect(applyNamespace('my-server', 'search_leads')).toBe('my-server.search_leads');
  });

  it('fonctionne avec des tirets dans le serverId', () => {
    expect(applyNamespace('server-id-123', 'tool')).toBe('server-id-123.tool');
  });
});

describe('resolveNamespacedTool', () => {
  it('décompose un nom préfixé valide', () => {
    const result = resolveNamespacedTool('salesforce.get_contact');
    expect(result).toEqual({ serverId: 'salesforce', toolName: 'get_contact' });
  });

  it('retourne null pour un nom sans séparateur', () => {
    expect(resolveNamespacedTool('get_contact')).toBeNull();
  });

  it('retourne null pour un séparateur en première position', () => {
    expect(resolveNamespacedTool('.get_contact')).toBeNull();
  });

  it('retourne null pour un séparateur en dernière position', () => {
    expect(resolveNamespacedTool('salesforce.')).toBeNull();
  });

  it('gère les noms d\'outils contenant un point', () => {
    // "salesforce.get.contact" → serverId="salesforce", toolName="get.contact"
    const result = resolveNamespacedTool('salesforce.get.contact');
    expect(result).toEqual({ serverId: 'salesforce', toolName: 'get.contact' });
  });
});

describe('detectConflicts', () => {
  it('détecte les conflits entre deux serveurs', () => {
    const toolsByServer = new Map([
      ['salesforce', ['get_contact', 'search_leads']],
      ['github', ['get_contact', 'list_repos']],
    ]);

    const conflicts = detectConflicts(toolsByServer);
    expect(conflicts).toContain('get_contact');
    expect(conflicts).not.toContain('search_leads');
    expect(conflicts).not.toContain('list_repos');
  });

  it('retourne une liste vide si pas de conflit', () => {
    const toolsByServer = new Map([
      ['salesforce', ['get_contact']],
      ['github', ['list_repos']],
    ]);

    expect(detectConflicts(toolsByServer)).toEqual([]);
  });

  it('retourne une liste vide si un seul serveur', () => {
    const toolsByServer = new Map([
      ['salesforce', ['get_contact', 'search_leads']],
    ]);
    expect(detectConflicts(toolsByServer)).toEqual([]);
  });

  it('détecte les conflits entre trois serveurs ou plus', () => {
    const toolsByServer = new Map([
      ['a', ['shared_tool']],
      ['b', ['shared_tool']],
      ['c', ['shared_tool']],
    ]);
    const conflicts = detectConflicts(toolsByServer);
    expect(conflicts).toContain('shared_tool');
  });
});

describe('buildNamespaceMap — stratégie "prefix"', () => {
  it('préfixe tous les outils avec leur serverId', () => {
    const toolsByServer = new Map([
      ['salesforce', ['get_contact', 'search_leads']],
      ['github', ['list_repos']],
    ]);

    const map = buildNamespaceMap(toolsByServer, 'prefix');

    expect(map.get('salesforce.get_contact')).toEqual({ serverId: 'salesforce', toolName: 'get_contact' });
    expect(map.get('salesforce.search_leads')).toEqual({ serverId: 'salesforce', toolName: 'search_leads' });
    expect(map.get('github.list_repos')).toEqual({ serverId: 'github', toolName: 'list_repos' });
  });

  it('ne génère pas de conflits même si des outils ont le même nom', () => {
    const toolsByServer = new Map([
      ['salesforce', ['get_contact']],
      ['github', ['get_contact']],
    ]);

    const map = buildNamespaceMap(toolsByServer, 'prefix');
    expect(map.size).toBe(2);
    expect(map.get('salesforce.get_contact')).toBeDefined();
    expect(map.get('github.get_contact')).toBeDefined();
  });
});

describe('buildNamespaceMap — stratégie "none"', () => {
  it('mappe directement les outils sans préfixe', () => {
    const toolsByServer = new Map([
      ['salesforce', ['get_contact']],
      ['github', ['list_repos']],
    ]);

    const map = buildNamespaceMap(toolsByServer, 'none');
    expect(map.get('get_contact')).toEqual({ serverId: 'salesforce', toolName: 'get_contact' });
    expect(map.get('list_repos')).toEqual({ serverId: 'github', toolName: 'list_repos' });
  });

  it('lève une erreur en cas de conflit de noms', () => {
    const toolsByServer = new Map([
      ['salesforce', ['get_contact']],
      ['github', ['get_contact']],
    ]);

    expect(() => buildNamespaceMap(toolsByServer, 'none')).toThrow();
  });
});

describe('resolveTool', () => {
  it('résout un outil depuis la map (stratégie prefix)', () => {
    const map = new Map([
      ['salesforce.get_contact', { serverId: 'salesforce', toolName: 'get_contact' }],
    ]);

    const result = resolveTool('salesforce.get_contact', map, 'prefix');
    expect(result).toEqual({ serverId: 'salesforce', toolName: 'get_contact' });
  });

  it('résout un outil depuis la map (stratégie none)', () => {
    const map = new Map([
      ['get_contact', { serverId: 'salesforce', toolName: 'get_contact' }],
    ]);

    const result = resolveTool('get_contact', map, 'none');
    expect(result).toEqual({ serverId: 'salesforce', toolName: 'get_contact' });
  });

  it('retourne null pour un outil introuvable', () => {
    const map = new Map<string, { serverId: string; toolName: string }>();
    expect(resolveTool('nonexistent', map, 'prefix')).toBeNull();
  });

  it('tente la décomposition si introuvable dans la map (stratégie prefix)', () => {
    const map = new Map<string, { serverId: string; toolName: string }>();
    // La map est vide, mais la décomposition "salesforce.get_contact" devrait fonctionner
    const result = resolveTool('salesforce.get_contact', map, 'prefix');
    expect(result).toEqual({ serverId: 'salesforce', toolName: 'get_contact' });
  });

  it('ne tente pas la décomposition en mode "none"', () => {
    const map = new Map<string, { serverId: string; toolName: string }>();
    const result = resolveTool('salesforce.get_contact', map, 'none');
    expect(result).toBeNull();
  });
});
