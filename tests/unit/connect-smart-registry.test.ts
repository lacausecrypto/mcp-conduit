import { describe, expect, it } from 'vitest';
import type { GovernanceRegistryDecision } from '../../src/governance/types.js';
import { listConnectTargets } from '../../src/connect/export.js';
import {
  applySmartRegistryFilters,
  enrichSmartRegistryItem,
} from '../../src/connect/registry-smart.js';
import type {
  ConnectRegistryLibraryItem,
  OfficialRegistryServerDocument,
} from '../../src/connect/registry.js';

function makeItem(overrides: Partial<ConnectRegistryLibraryItem> = {}): ConnectRegistryLibraryItem {
  return {
    name: 'io.github.openai/assistant-mcp',
    conduit_id: 'io-github-openai-assistant-mcp',
    title: 'Assistant MCP',
    description: 'Managed MCP server',
    version: '1.0.0',
    status: 'active',
    is_latest: true,
    install_mode: 'remote',
    readiness: 'ready',
    strategy: 'proxy-remote',
    score: 92,
    score_label: 'excellent',
    auto_importable: true,
    configurable_import: true,
    package_types: ['unknown'],
    package_identifiers: ['@openai/assistant-mcp'],
    remote_patterns: ['https://example.com/mcp'],
    package_count: 0,
    remote_count: 1,
    required_config_count: 0,
    requirement_keys: ['OPENAI_API_KEY'],
    strategy_options: ['proxy-remote'],
    import_requirements: { variables: [], headers: [], env: [] },
    verified_publisher: true,
    publisher_label: 'openai',
    verification_basis: 'namespace-repository-match',
    repository_url: 'https://github.com/openai/assistant-mcp',
    published_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-10T00:00:00.000Z',
    reasons: ['Registry status is active', 'Repository owner matches the published registry namespace'],
    ...overrides,
  };
}

function makeRaw(overrides: Partial<OfficialRegistryServerDocument> = {}): OfficialRegistryServerDocument {
  return {
    name: 'io.github.openai/assistant-mcp',
    title: 'Assistant MCP',
    description: 'Managed MCP server',
    version: '1.0.0',
    repository: {
      url: 'https://github.com/openai/assistant-mcp',
      source: 'github',
    },
    remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
    ...overrides,
  };
}

describe('connect smart registry enrichment', () => {
  it('builds trust, compatibility, and import recommendation for a ready entry', () => {
    const item = enrichSmartRegistryItem({
      item: makeItem(),
      raw: makeRaw(),
      targets: listConnectTargets(),
    });

    expect(item.smart.trust.verified_publisher).toBe(true);
    expect(item.smart.runtime.status).toBe('not-imported');
    expect(item.smart.recommendation.action).toBe('import-to-conduit');
    expect(item.smart.compatibility.targets.some((target) => target.id === 'cursor' && target.recommended)).toBe(true);
    expect(item.smart.badges).toContain('verified-publisher');
    expect(item.smart.badges).toContain('one-click');
  });

  it('switches to install-now once the server is healthy inside Conduit', () => {
    const decision: GovernanceRegistryDecision = {
      allowed: true,
      effect: 'allow',
      policy_name: 'allow-openai',
      reason: 'Workspace policy allows this publisher',
      workspace_id: 'workspace-a',
      roles: ['developer'],
    };

    const item = enrichSmartRegistryItem({
      item: makeItem(),
      raw: makeRaw(),
      targets: listConnectTargets(),
      managedRuntime: {
        managed: true,
        healthy: true,
        tool_count: 12,
        latency_ms: 34,
        last_checked: '2026-04-22T06:00:00.000Z',
        profile_ids: ['default', 'engineering'],
      },
      policy: {
        workspace_id: 'workspace-a',
        roles: ['developer'],
        decision,
      },
    });

    expect(item.smart.runtime.status).toBe('healthy');
    expect(item.smart.runtime.profile_ids).toContain('engineering');
    expect(item.smart.policy_fit.status).toBe('allowed');
    expect(item.smart.recommendation.action).toBe('install-now');
  });

  it('filters enriched entries by verification, runtime, target, and policy fit', () => {
    const allowDecision: GovernanceRegistryDecision = {
      allowed: true,
      effect: 'allow',
      policy_name: 'allow-openai',
      reason: 'Allowed by workspace policy',
      workspace_id: 'workspace-a',
      roles: ['developer'],
    };
    const blockDecision: GovernanceRegistryDecision = {
      allowed: false,
      effect: 'deny',
      policy_name: 'block-community',
      reason: 'Blocked by workspace policy',
      workspace_id: 'workspace-a',
      roles: ['developer'],
    };

    const healthy = enrichSmartRegistryItem({
      item: makeItem(),
      raw: makeRaw(),
      targets: listConnectTargets(),
      managedRuntime: {
        managed: true,
        healthy: true,
        tool_count: 8,
        latency_ms: 20,
        profile_ids: ['default'],
      },
      policy: {
        workspace_id: 'workspace-a',
        roles: ['developer'],
        decision: allowDecision,
      },
    });

    const blocked = enrichSmartRegistryItem({
      item: makeItem({
        name: 'community.example/unverified',
        conduit_id: 'community-example-unverified',
        verified_publisher: false,
        publisher_label: 'community',
        verification_basis: 'unverified',
        score: 38,
        score_label: 'poor',
        auto_importable: false,
        configurable_import: false,
        readiness: 'manual',
        strategy: 'manual',
        strategy_options: [],
        reasons: ['Manual setup required'],
      }),
      raw: makeRaw({
        name: 'community.example/unverified',
        repository: { url: 'https://github.com/other-org/unverified', source: 'github' },
      }),
      targets: listConnectTargets(),
      policy: {
        workspace_id: 'workspace-a',
        roles: ['developer'],
        decision: blockDecision,
      },
    });

    const filtered = applySmartRegistryFilters([healthy, blocked], {
      verified_publisher: true,
      runtime_status: 'healthy',
      policy_fit: 'allowed',
      target: 'cursor',
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe('io.github.openai/assistant-mcp');
  });

  it('matches multi-term search across package identifiers, publishers, and requirement keys', () => {
    const item = enrichSmartRegistryItem({
      item: makeItem({
        title: 'Docs Assistant',
        description: 'Search docs and internal references',
        package_identifiers: ['@openai/docs-mcp'],
        requirement_keys: ['DOCS_API_KEY'],
      }),
      raw: makeRaw(),
      targets: listConnectTargets(),
    });

    const miss = enrichSmartRegistryItem({
      item: makeItem({
        name: 'io.github.community/random-mcp',
        conduit_id: 'io-github-community-random-mcp',
        title: 'Random MCP',
        publisher_label: 'community',
        verified_publisher: false,
        verification_basis: 'unverified',
        package_identifiers: ['@community/random-mcp'],
        requirement_keys: ['COMMUNITY_TOKEN'],
      }),
      raw: makeRaw({
        name: 'io.github.community/random-mcp',
        repository: { url: 'https://github.com/community/random-mcp', source: 'github' },
      }),
      targets: listConnectTargets(),
    });

    const filtered = applySmartRegistryFilters([miss, item], {
      search: 'openai docs api key',
      sort: 'relevance',
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe('io.github.openai/assistant-mcp');
  });
});
