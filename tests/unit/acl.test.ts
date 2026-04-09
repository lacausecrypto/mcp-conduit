/**
 * Tests unitaires pour le module ACL.
 */

import { describe, it, expect } from 'vitest';
import { evaluateAcl, filterToolsList } from '../../src/auth/acl.js';
import type { AclPolicy } from '../../src/auth/types.js';
import type { ToolMetadata } from '../../src/cache/types.js';

const SALESFORCE_TOOLS: ToolMetadata[] = [
  { name: 'get_contact' },
  { name: 'search_leads' },
  { name: 'create_contact' },
  { name: 'delete_contact' },
  { name: 'update_lead' },
];

const POLICIES: AclPolicy[] = [
  {
    name: 'support-agents',
    clients: ['agent-support-*'],
    allow: [
      { server: 'salesforce', tools: ['get_contact', 'search_leads', 'get_*'] },
      { server: 'zendesk', tools: ['*'] },
    ],
    deny: [
      { server: 'salesforce', tools: ['delete_*', 'create_*'] },
    ],
  },
  {
    name: 'admin-agents',
    clients: ['agent-admin'],
    allow: [{ server: '*', tools: ['*'] }],
  },
  {
    name: 'default',
    clients: ['*'],
    deny: [{ server: '*', tools: ['*'] }],
  },
];

describe('evaluateAcl', () => {
  describe('correspondance de client', () => {
    it('correspondance exacte — politique appliquée', () => {
      const decision = evaluateAcl('agent-admin', 'salesforce', 'delete_contact', POLICIES);
      expect(decision.allowed).toBe(true);
      expect(decision.policy_name).toBe('admin-agents');
    });

    it('wildcard "agent-*" correspond à "agent-support-1"', () => {
      const decision = evaluateAcl('agent-support-1', 'salesforce', 'get_contact', POLICIES);
      expect(decision.allowed).toBe(true);
      expect(decision.policy_name).toBe('support-agents');
    });

    it('wildcard "*" correspond à tout', () => {
      const decision = evaluateAcl('unknown-client', 'salesforce', 'get_contact', POLICIES);
      expect(decision.policy_name).toBe('default');
    });
  });

  describe('règles deny et allow', () => {
    it('règle deny évaluée avant allow', () => {
      // agent-support-1 : deny delete_* sur salesforce AVANT allow
      const decision = evaluateAcl('agent-support-1', 'salesforce', 'delete_contact', POLICIES);
      expect(decision.allowed).toBe(false);
      expect(decision.policy_name).toBe('support-agents');
    });

    it('allow après absence de deny', () => {
      const decision = evaluateAcl('agent-support-1', 'salesforce', 'get_contact', POLICIES);
      expect(decision.allowed).toBe(true);
    });

    it('outil non couvert par deny ni allow → refusé dans la politique', () => {
      // update_lead n'est ni dans deny ni dans allow pour support-agents
      const decision = evaluateAcl('agent-support-1', 'salesforce', 'update_lead', POLICIES);
      expect(decision.allowed).toBe(false);
      expect(decision.policy_name).toBe('support-agents');
    });
  });

  describe('patterns de tools', () => {
    it('pattern "get_*" correspond à "get_contact"', () => {
      const decision = evaluateAcl('agent-support-1', 'salesforce', 'get_lead', POLICIES);
      expect(decision.allowed).toBe(true);
    });

    it('pattern "get_*" ne correspond pas à "create_lead"', () => {
      const decision = evaluateAcl('agent-support-1', 'salesforce', 'create_lead', POLICIES);
      expect(decision.allowed).toBe(false);
    });

    it('pattern "delete_*" correspond à "delete_contact"', () => {
      const decision = evaluateAcl('agent-support-1', 'salesforce', 'delete_contact', POLICIES);
      expect(decision.allowed).toBe(false); // dans deny
    });

    it('pattern "*" correspond à tout outil', () => {
      const decision = evaluateAcl('agent-admin', '*', 'n_importe_quel_outil', [
        { name: 'all', clients: ['agent-admin'], allow: [{ server: '*', tools: ['*'] }] },
      ]);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('default_action', () => {
    it('aucune politique + default deny → refusé', () => {
      const decision = evaluateAcl('unknown', 'srv', 'tool', [], 'deny');
      expect(decision.allowed).toBe(false);
    });

    it('aucune politique + default allow → autorisé', () => {
      const decision = evaluateAcl('unknown', 'srv', 'tool', [], 'allow');
      expect(decision.allowed).toBe(true);
    });
  });

  describe('ordre des politiques (premier match)', () => {
    it('première politique matching gagne, les suivantes ignorées', () => {
      // agent-support-1 matche support-agents (first), pas default
      const decision = evaluateAcl('agent-support-1', 'salesforce', 'get_contact', POLICIES);
      expect(decision.policy_name).toBe('support-agents');
    });
  });

  describe('server patterns', () => {
    it('wildcard serveur "*" correspond à tout serveur', () => {
      const decision = evaluateAcl('agent-admin', 'any-server', 'any-tool', POLICIES);
      expect(decision.allowed).toBe(true);
      expect(decision.policy_name).toBe('admin-agents');
    });

    it('serveur spécifique ne correspond pas à un autre', () => {
      const decision = evaluateAcl('agent-support-1', 'github', 'get_contact', POLICIES);
      // zendesk est autorisé avec *, github n'est pas dans les allow
      // mais salesforce deny ne s'applique pas, et allow ne matche pas github
      // → aucune règle ne matche → refusé dans la politique support-agents
      expect(decision.allowed).toBe(false);
    });

    it('zendesk "*" outils autorisés pour agent-support-*', () => {
      const decision = evaluateAcl('agent-support-1', 'zendesk', 'anything', POLICIES);
      expect(decision.allowed).toBe(true);
    });
  });
});

describe('filterToolsList', () => {
  const policies: AclPolicy[] = [
    {
      name: 'support',
      clients: ['agent-support-1'],
      allow: [
        { server: 'salesforce', tools: ['get_contact', 'search_leads'] },
      ],
      deny: [
        { server: 'salesforce', tools: ['delete_*'] },
      ],
    },
  ];

  it('supprime les outils non autorisés', () => {
    const allowed = filterToolsList('agent-support-1', 'salesforce', SALESFORCE_TOOLS, policies);
    const names = allowed.map((t) => t.name);

    expect(names).toContain('get_contact');
    expect(names).toContain('search_leads');
    expect(names).not.toContain('create_contact');
    expect(names).not.toContain('delete_contact');
  });

  it('retourne la liste complète si acl default allow et pas de politique', () => {
    const allowed = filterToolsList('unknown', 'salesforce', SALESFORCE_TOOLS, [], 'allow');
    expect(allowed).toHaveLength(SALESFORCE_TOOLS.length);
  });

  it('retourne liste vide si tout est refusé', () => {
    const allowed = filterToolsList('unknown', 'salesforce', SALESFORCE_TOOLS, [], 'deny');
    expect(allowed).toHaveLength(0);
  });
});
