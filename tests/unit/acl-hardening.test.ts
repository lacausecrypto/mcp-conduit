/**
 * Tests de durcissement pour le module ACL.
 * Couvre : tableaux vides, patterns chevauchants, priorité deny/allow,
 * caractères spéciaux, politiques nombreuses, comportement du wildcard seul.
 */

import { describe, it, expect } from 'vitest';
import { evaluateAcl, filterToolsList } from '../../src/auth/acl.js';
import type { AclPolicy } from '../../src/auth/types.js';
import type { ToolMetadata } from '../../src/cache/types.js';

// ─── matchesPattern edge cases ────────────────────────────────────────────────

describe('evaluateAcl — hardening', () => {
  describe('tableaux vides dans la politique', () => {
    it('politique avec clients=[] ne matche aucun client', () => {
      const policies: AclPolicy[] = [
        { name: 'empty-clients', clients: [], allow: [{ server: '*', tools: ['*'] }] },
      ];
      const r = evaluateAcl('any-client', 'srv', 'tool', policies, 'deny');
      // Aucune politique ne matche → default deny
      expect(r.allowed).toBe(false);
      expect(r.policy_name).toBe('');
    });

    it('politique avec allow=[] et deny=[] → refus dans la politique (aucune règle)', () => {
      const policies: AclPolicy[] = [
        { name: 'empty-rules', clients: ['*'], allow: [], deny: [] },
      ];
      const r = evaluateAcl('any', 'srv', 'tool', policies);
      // La politique matche le client, mais aucune règle ne matche l'outil → refus
      expect(r.allowed).toBe(false);
      expect(r.policy_name).toBe('empty-rules');
    });

    it('politique avec allow défini mais deny absent', () => {
      const policies: AclPolicy[] = [
        { name: 'no-deny', clients: ['*'], allow: [{ server: '*', tools: ['*'] }] },
      ];
      const r = evaluateAcl('client', 'srv', 'any-tool', policies);
      expect(r.allowed).toBe(true);
    });

    it('politique avec deny défini mais allow absent', () => {
      const policies: AclPolicy[] = [
        { name: 'deny-only', clients: ['*'], deny: [{ server: '*', tools: ['delete_*'] }] },
      ];
      // delete_contact correspond au deny → refus
      const r1 = evaluateAcl('c', 'srv', 'delete_contact', policies);
      expect(r1.allowed).toBe(false);

      // read_contact ne correspond pas au deny — mais aucune allow non plus → refus
      const r2 = evaluateAcl('c', 'srv', 'read_contact', policies);
      expect(r2.allowed).toBe(false);
    });
  });

  describe('patterns chevauchants', () => {
    it('"agent-support-*" et "agent-*" — la première politique matchante gagne', () => {
      const policies: AclPolicy[] = [
        {
          name: 'specific',
          clients: ['agent-support-*'],
          allow: [{ server: '*', tools: ['get_*'] }],
        },
        {
          name: 'generic',
          clients: ['agent-*'],
          allow: [{ server: '*', tools: ['*'] }],
        },
      ];

      // agent-support-1 matche specific (premier) → seuls les get_* sont autorisés
      const r1 = evaluateAcl('agent-support-1', 'srv', 'get_contact', policies);
      expect(r1.allowed).toBe(true);
      expect(r1.policy_name).toBe('specific');

      // delete_contact ne correspond pas à get_* → refus dans specific
      const r2 = evaluateAcl('agent-support-1', 'srv', 'delete_contact', policies);
      expect(r2.allowed).toBe(false);
      expect(r2.policy_name).toBe('specific');

      // agent-ops-1 ne matche pas specific → tombe sur generic → tout autorisé
      const r3 = evaluateAcl('agent-ops-1', 'srv', 'delete_contact', policies);
      expect(r3.allowed).toBe(true);
      expect(r3.policy_name).toBe('generic');
    });

    it('deny sur tool spécifique + allow sur * → deny l\'emporte', () => {
      const policies: AclPolicy[] = [
        {
          name: 'p',
          clients: ['*'],
          deny: [{ server: 'srv', tools: ['dangerous_tool'] }],
          allow: [{ server: 'srv', tools: ['*'] }],
        },
      ];

      const rDeny = evaluateAcl('c', 'srv', 'dangerous_tool', policies);
      expect(rDeny.allowed).toBe(false);

      const rAllow = evaluateAcl('c', 'srv', 'safe_tool', policies);
      expect(rAllow.allowed).toBe(true);
    });
  });

  describe('patterns de tools spéciaux', () => {
    it('pattern "*" autorise tout outil', () => {
      const policies: AclPolicy[] = [
        { name: 'p', clients: ['*'], allow: [{ server: '*', tools: ['*'] }] },
      ];
      expect(evaluateAcl('c', 's', 'any_tool_whatsoever', policies).allowed).toBe(true);
    });

    it('pattern "" (vide) ne matche que la chaîne vide exacte', () => {
      const policies: AclPolicy[] = [
        { name: 'p', clients: ['*'], allow: [{ server: '*', tools: [''] }] },
      ];
      // Le pattern "" correspond uniquement à la valeur "" exacte
      const r1 = evaluateAcl('c', 's', '', policies);
      expect(r1.allowed).toBe(true);

      // Une chaîne non vide ne correspond pas au pattern ""
      const r2 = evaluateAcl('c', 's', 'tool', policies);
      expect(r2.allowed).toBe(false);
    });

    it('pattern préfixe "get_*" ne matche pas "get" (sans underscore)', () => {
      const policies: AclPolicy[] = [
        { name: 'p', clients: ['*'], allow: [{ server: '*', tools: ['get_*'] }] },
      ];
      const r = evaluateAcl('c', 's', 'get', policies);
      // "get_*" → startsWith("get_") → "get" ne commence pas par "get_"
      expect(r.allowed).toBe(false);
    });
  });

  describe('caractères spéciaux dans les IDs', () => {
    it('serverId avec tirets et underscores', () => {
      const policies: AclPolicy[] = [
        { name: 'p', clients: ['c-1'], allow: [{ server: 'srv_with-special.chars', tools: ['*'] }] },
      ];
      const r = evaluateAcl('c-1', 'srv_with-special.chars', 'any', policies);
      expect(r.allowed).toBe(true);
    });

    it('clientId avec caractères spéciaux', () => {
      const policies: AclPolicy[] = [
        { name: 'p', clients: ['user@domain.com'], allow: [{ server: '*', tools: ['*'] }] },
      ];
      const r = evaluateAcl('user@domain.com', 'srv', 'tool', policies);
      expect(r.allowed).toBe(true);
    });
  });

  describe('100 politiques — performance', () => {
    it('évalue 100 politiques sans erreur et dans un temps raisonnable', () => {
      const policies: AclPolicy[] = Array.from({ length: 99 }, (_, i) => ({
        name: `policy-${i}`,
        clients: [`client-${i}`],
        allow: [{ server: '*', tools: ['*'] }],
      }));
      // La 100e politique matche notre client
      policies.push({
        name: 'last',
        clients: ['target-client'],
        allow: [{ server: '*', tools: ['*'] }],
      });

      const start = Date.now();
      const r = evaluateAcl('target-client', 'srv', 'tool', policies);
      const elapsed = Date.now() - start;

      expect(r.allowed).toBe(true);
      expect(r.policy_name).toBe('last');
      expect(elapsed).toBeLessThan(50); // doit être quasi instantané
    });
  });

  describe('deny → allow → deny dans la même politique', () => {
    it('deny spécifique prend priorité même si allow générique suit', () => {
      const policies: AclPolicy[] = [
        {
          name: 'p',
          clients: ['*'],
          deny: [{ server: 'prod', tools: ['nuke_database'] }],
          allow: [{ server: 'prod', tools: ['nuke_database'] }], // never reached
        },
      ];
      const r = evaluateAcl('c', 'prod', 'nuke_database', policies);
      expect(r.allowed).toBe(false);
    });
  });

  describe('default_action', () => {
    it('default allow quand aucune politique ne correspond', () => {
      expect(evaluateAcl('x', 's', 't', [], 'allow').allowed).toBe(true);
    });

    it('default deny quand aucune politique ne correspond', () => {
      expect(evaluateAcl('x', 's', 't', [], 'deny').allowed).toBe(false);
    });
  });
});

// ─── filterToolsList ──────────────────────────────────────────────────────────

describe('filterToolsList — hardening', () => {
  const tools: ToolMetadata[] = [
    { name: 'read_data' },
    { name: 'write_data' },
    { name: 'delete_data' },
  ];

  it('filtre la liste avec deny * → liste vide', () => {
    const policies: AclPolicy[] = [
      { name: 'deny-all', clients: ['*'], deny: [{ server: '*', tools: ['*'] }] },
    ];
    expect(filterToolsList('c', 'srv', tools, policies)).toHaveLength(0);
  });

  it('filtre avec allow uniquement certains outils', () => {
    const policies: AclPolicy[] = [
      { name: 'read-only', clients: ['*'], allow: [{ server: '*', tools: ['read_*'] }] },
    ];
    const allowed = filterToolsList('c', 'srv', tools, policies);
    expect(allowed.map((t) => t.name)).toEqual(['read_data']);
  });

  it('liste vide en entrée → liste vide en sortie', () => {
    expect(filterToolsList('c', 'srv', [], [], 'allow')).toHaveLength(0);
  });

  it('default allow + aucune politique → tout autorisé', () => {
    expect(filterToolsList('c', 'srv', tools, [], 'allow')).toHaveLength(tools.length);
  });
});
