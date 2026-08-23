import { describe, expect, it } from 'vitest';
import {
  connectorCatalog,
  connectorPluginRecord,
  findConnector,
  validateConnector,
  type ConnectorDefinition,
} from '../src/connectors.js';

/**
 * The acceptance criteria require every named integration to be optional and
 * permission-scoped. These tests hold the whole catalog to that, so adding a
 * connector that quietly breaks the rule fails the build rather than review.
 */

const REQUIRED_CONNECTORS = [
  'github',
  'cloudflare',
  'figma',
  'asana',
  'canva',
  'scispace',
  'consensus',
  'wolfram',
];

const base = (): ConnectorDefinition => ({
  id: 'test',
  name: 'Test',
  purpose: 'Testing.',
  authType: 'api-key',
  documentationUrl: 'https://example.com/docs',
  allowedHosts: ['api.example.com'],
  scopes: ['read'],
  scopesVerified: false,
  maxRisk: 'safe',
  dataRetention: 'Nothing retained.',
  degradedBehavior: 'Feature unavailable; nothing else changes.',
  tools: [{ name: 'test.read', description: 'Read.', risk: 'safe', reversible: true }],
});

describe('connector catalog', () => {
  it('contains every integration the acceptance criteria name', () => {
    const ids = connectorCatalog().map((connector) => connector.id);
    for (const required of REQUIRED_CONNECTORS) {
      expect(ids, `missing connector: ${required}`).toContain(required);
    }
  });

  it('validates at load, so a malformed entry cannot ship', () => {
    expect(() => connectorCatalog()).not.toThrow();
  });

  it('gives every connector a unique id and a findable entry', () => {
    const ids = connectorCatalog().map((connector) => connector.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(findConnector(id)?.id).toBe(id);
    expect(findConnector('nope')).toBeUndefined();
  });

  it('restricts every connector to explicit hostnames', () => {
    for (const connector of connectorCatalog()) {
      expect(connector.allowedHosts.length, connector.id).toBeGreaterThan(0);
      for (const host of connector.allowedHosts) {
        // A scheme, port, or path here would widen the allowlist when compared
        // against a request hostname.
        expect(host, `${connector.id}: ${host}`).not.toMatch(/[:/]/);
      }
    }
  });

  it('requests scopes for every connector that authenticates', () => {
    for (const connector of connectorCatalog()) {
      if (connector.authType === 'none') continue;
      expect(connector.scopes.length, connector.id).toBeGreaterThan(0);
    }
  });

  it('states what the harness does without each connector', () => {
    // This is what makes "optional" a property rather than a claim.
    for (const connector of connectorCatalog()) {
      expect(connector.degradedBehavior.length, connector.id).toBeGreaterThan(20);
      expect(connector.dataRetention.length, connector.id).toBeGreaterThan(20);
      expect(connector.purpose.length, connector.id).toBeGreaterThan(20);
    }
  });

  it('declares a documentation link the operator can read before granting authority', () => {
    for (const connector of connectorCatalog()) {
      expect(connector.documentationUrl, connector.id).toMatch(/^https:\/\//);
    }
  });

  it('carries no credential material in the catalog itself', () => {
    const serialised = JSON.stringify(connectorCatalog());
    for (const pattern of [/sk-[A-Za-z0-9]{12,}/, /Bearer\s+\S+/, /"(apiKey|token|secret)"\s*:/i]) {
      expect(serialised).not.toMatch(pattern);
    }
  });

  it('marks scope strings as verified only where they were actually checked', () => {
    // Honest metadata: an unverified scope must be confirmed by the owner at
    // connection time rather than trusted because it looks plausible.
    const github = findConnector('github');
    expect(github?.scopesVerified).toBe(true);
    expect(findConnector('figma')?.scopesVerified).toBe(true);
    expect(findConnector('asana')?.scopesVerified).toBe(true);
    expect(findConnector('canva')?.scopesVerified).toBe(true);
    const unverified = connectorCatalog().filter((connector) => !connector.scopesVerified);
    expect(unverified.map((c) => c.id).sort()).toEqual([
      'cloudflare',
      'consensus',
      'scispace',
      'wolfram',
    ]);
  });

  it('gives each connector at least one tool with a risk and reversibility', () => {
    for (const connector of connectorCatalog()) {
      expect(connector.tools.length, connector.id).toBeGreaterThan(0);
      for (const tool of connector.tools) {
        expect(tool.name).toMatch(new RegExp(`^${connector.id}\\.`));
        expect(['safe', 'low', 'medium', 'high', 'critical']).toContain(tool.risk);
        expect(typeof tool.reversible).toBe('boolean');
      }
    }
  });

  it('never lets a tool exceed its connector declared maximum risk', () => {
    const rank = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;
    for (const connector of connectorCatalog()) {
      for (const tool of connector.tools) {
        expect(rank[tool.risk], `${tool.name} exceeds ${connector.id} maxRisk`).toBeLessThanOrEqual(
          rank[connector.maxRisk],
        );
      }
    }
  });
});

describe('connector validation', () => {
  it('accepts a well-formed definition', () => {
    expect(validateConnector(base())).toEqual([]);
  });

  it('rejects a definition with no allowed hosts', () => {
    expect(validateConnector({ ...base(), allowedHosts: [] })).toContain('connector_host_missing');
  });

  it('rejects a host that is a URL, has a port, or has a path', () => {
    for (const host of ['https://api.example.com', 'api.example.com:443', 'api.example.com/v1']) {
      expect(validateConnector({ ...base(), allowedHosts: [host] }), host).toContain(
        'connector_host_not_https_capable',
      );
    }
  });

  it('rejects an authenticating connector with no scopes', () => {
    expect(validateConnector({ ...base(), scopes: [] })).toContain('connector_scope_missing');
    // A connector that authenticates with nothing legitimately has no scopes.
    expect(validateConnector({ ...base(), authType: 'none', scopes: [] })).toEqual([]);
  });

  it('rejects a definition missing retention or degraded behaviour', () => {
    expect(validateConnector({ ...base(), dataRetention: '  ' })).toContain(
      'connector_retention_missing',
    );
    expect(validateConnector({ ...base(), degradedBehavior: '' })).toContain(
      'connector_degraded_behavior_missing',
    );
  });

  it('rejects a connector that contributes no tools', () => {
    expect(validateConnector({ ...base(), tools: [] })).toContain('connector_tool_missing');
  });

  it('reports every violation at once', () => {
    const violations = validateConnector({
      ...base(),
      allowedHosts: [],
      scopes: [],
      dataRetention: '',
      tools: [],
    });
    expect(violations.length).toBeGreaterThanOrEqual(4);
  });
});

describe('connector installation', () => {
  it('produces a disabled, non-workspace, allowlisted plugin for every connector', () => {
    for (const connector of connectorCatalog()) {
      const record = connectorPluginRecord(connector);
      // Installing grants no authority. A separate, audited enable step does.
      expect(record.enabled, connector.id).toBe(false);
      expect(record.workspaceEnabled, connector.id).toBe(false);
      expect(record.projectIds, connector.id).toEqual([]);
      expect(record.agentIds, connector.id).toEqual([]);
      expect(record.network, connector.id).toBe('allowlist');
      expect(record.pinned, connector.id).toBe(true);
    }
  });

  it('never produces an open-network plugin', () => {
    for (const connector of connectorCatalog()) {
      expect(connectorPluginRecord(connector).network).not.toBe('open');
    }
  });

  it('namespaces permissions by connector so scopes cannot collide', () => {
    const record = connectorPluginRecord(findConnector('github')!);
    expect(record.permissions).toEqual(['github:repo', 'github:read:org']);
  });

  it('carries the retention declaration onto the plugin record', () => {
    const connector = findConnector('wolfram')!;
    expect(connectorPluginRecord(connector).retention).toBe(connector.dataRetention);
  });
});
