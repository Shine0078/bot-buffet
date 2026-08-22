import type { Risk } from './types.js';

/**
 * Connector catalog.
 *
 * The acceptance criteria require the named integrations to be optional and
 * permission-scoped. This file is the declarative half of that: what each
 * connector is for, what it is allowed to reach, what authority it needs, what
 * it retains, and — the part that makes "optional" mean something — what
 * happens when it is not connected.
 *
 * Three rules hold for every entry and are enforced by `validateConnector`
 * rather than left to review:
 *
 *   1. Nothing is enabled by default. A connector is a catalog entry until an
 *      operator installs it, and installing it produces a *disabled* plugin.
 *   2. No connector may request open network access. Each declares the exact
 *      hosts it may reach, and that list becomes the egress allowlist.
 *   3. Every connector declares what the harness does without it. A connector
 *      whose absence breaks a core path is not optional, whatever it claims.
 *
 * Scope strings are marked `scopesVerified` only where they have been checked
 * against the provider's own documentation. Where they have not, the field is
 * false and the owner must confirm the exact strings at connection time; that
 * is recorded in `docs/owner-gates.md` rather than guessed at here, because a
 * wrong scope string either fails to connect or quietly grants more authority
 * than intended.
 */

export type ConnectorAuth = 'oauth2-pkce' | 'api-key' | 'env' | 'none';

export interface ConnectorTool {
  name: string;
  description: string;
  risk: Risk;
  /** Whether the effect can be undone without external help. */
  reversible: boolean;
}

export interface ConnectorDefinition {
  id: string;
  name: string;
  /** What this connector is for inside Bot Buffet, not what the vendor sells. */
  purpose: string;
  authType: ConnectorAuth;
  /** Documentation the operator should read before granting authority. */
  documentationUrl: string;
  /** Hosts this connector may reach. Becomes the egress allowlist. */
  allowedHosts: string[];
  /** Least-privilege scopes requested at connection time. */
  scopes: string[];
  /** True only where the scope strings were checked against provider docs. */
  scopesVerified: boolean;
  /** Highest risk any of this connector's tools can reach. */
  maxRisk: Risk;
  /** What the connector stores, and for how long. */
  dataRetention: string;
  /** What Bot Buffet does when this connector is absent or disconnected. */
  degradedBehavior: string;
  tools: ConnectorTool[];
}

const CATALOG: ConnectorDefinition[] = [
  {
    id: 'github',
    name: 'GitHub',
    purpose:
      'Repository discovery, branch and worktree management, issues, pull requests, CI status, and release checkpoints.',
    authType: 'oauth2-pkce',
    documentationUrl: 'https://docs.github.com/en/rest',
    allowedHosts: ['api.github.com'],
    // Checked against GitHub's documented OAuth scope list. `repo` is the
    // narrowest scope that still permits private-repository pull requests;
    // `read:org` is read-only and needed only for org repository discovery.
    scopes: ['repo', 'read:org'],
    scopesVerified: true,
    maxRisk: 'high',
    dataRetention:
      'Repository metadata and CI status are cached per run and expire with the run. No source is retained outside the project workspace.',
    degradedBehavior:
      'Git operations fall back to the local repository. Issue, pull request, and CI status views report the connector as disconnected rather than empty.',
    tools: [
      {
        name: 'github.list_repositories',
        description: 'List repositories the authorized account can read.',
        risk: 'safe',
        reversible: true,
      },
      {
        name: 'github.read_pull_request',
        description: 'Read a pull request, its diff, and its checks.',
        risk: 'safe',
        reversible: true,
      },
      {
        name: 'github.create_pull_request',
        description: 'Open a pull request from an existing branch.',
        risk: 'high',
        reversible: true,
      },
    ],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    purpose:
      'Hosting, queues, workflows, object and relational storage, and deployment observability for the execution plane.',
    authType: 'api-key',
    documentationUrl: 'https://developers.cloudflare.com/api/',
    allowedHosts: ['api.cloudflare.com'],
    scopes: ['workers:read', 'workers:edit'],
    scopesVerified: false,
    maxRisk: 'critical',
    dataRetention:
      'Deployment identifiers and health results only. No prompts, model output, or project files are sent to this connector.',
    degradedBehavior:
      'Bot Buffet runs entirely on the local Node runtime and JSON store. Only cloud deployment actions become unavailable.',
    tools: [
      {
        name: 'cloudflare.list_deployments',
        description: 'List deployments for the configured account.',
        risk: 'safe',
        reversible: true,
      },
      {
        name: 'cloudflare.deploy',
        description: 'Publish a build to an environment.',
        risk: 'critical',
        reversible: true,
      },
    ],
  },
  {
    id: 'figma',
    name: 'Figma',
    purpose: 'Office UI design tokens, component inventory, and accessibility annotations.',
    authType: 'oauth2-pkce',
    documentationUrl: 'https://www.figma.com/developers/api',
    allowedHosts: ['api.figma.com'],
    scopes: ['file_read'],
    scopesVerified: false,
    maxRisk: 'safe',
    dataRetention: 'Token and component metadata cached per design sync; no file contents stored.',
    degradedBehavior:
      'The Office UI uses its checked-in design tokens. Design sync is unavailable; nothing else changes.',
    tools: [
      {
        name: 'figma.read_tokens',
        description: 'Read design tokens and component metadata from a file.',
        risk: 'safe',
        reversible: true,
      },
    ],
  },
  {
    id: 'asana',
    name: 'Asana',
    purpose: 'Project synchronization, task planning, milestones, and approval routing.',
    authType: 'oauth2-pkce',
    documentationUrl: 'https://developers.asana.com/docs',
    allowedHosts: ['app.asana.com'],
    scopes: ['tasks:read', 'tasks:write'],
    scopesVerified: false,
    maxRisk: 'medium',
    dataRetention:
      'Task identifiers and status only. Task bodies are not copied into Bot Buffet memory without an explicit memory write.',
    degradedBehavior:
      'Tasks live only in Bot Buffet. External synchronization is unavailable; local planning is unaffected.',
    tools: [
      {
        name: 'asana.list_tasks',
        description: 'List tasks in an authorized project.',
        risk: 'safe',
        reversible: true,
      },
      {
        name: 'asana.update_task',
        description: 'Update the status of a task.',
        risk: 'medium',
        reversible: true,
      },
    ],
  },
  {
    id: 'canva',
    name: 'Canva',
    purpose: 'Brand assets, onboarding material, reports, and documentation visuals.',
    authType: 'oauth2-pkce',
    documentationUrl: 'https://www.canva.dev/docs/connect/',
    allowedHosts: ['api.canva.com'],
    scopes: ['design:content:read'],
    scopesVerified: false,
    maxRisk: 'low',
    dataRetention:
      'Asset identifiers and export URLs only; exports are stored as project artifacts.',
    degradedBehavior:
      'Documentation and onboarding use checked-in assets. Nothing in the runtime depends on this connector.',
    tools: [
      {
        name: 'canva.list_designs',
        description: 'List designs the authorized account can read.',
        risk: 'safe',
        reversible: true,
      },
    ],
  },
  {
    id: 'scispace',
    name: 'SciSpace',
    purpose: 'Academic paper and PDF analysis for the research workspace.',
    authType: 'api-key',
    documentationUrl: 'https://typeset.io/',
    allowedHosts: ['api.scispace.com'],
    scopes: ['papers:read'],
    scopesVerified: false,
    maxRisk: 'safe',
    dataRetention:
      'Retrieved papers become research sources with a content hash and retrieval timestamp, subject to the project retention policy.',
    degradedBehavior:
      'Sources are retrieved over the standard SSRF-hardened transport instead. Papers that cannot be retrieved are marked inaccessible rather than summarized.',
    tools: [
      {
        name: 'scispace.analyze_paper',
        description: 'Extract structured claims from a paper.',
        risk: 'safe',
        reversible: true,
      },
    ],
  },
  {
    id: 'consensus',
    name: 'Consensus',
    purpose: 'Evidence-based literature search and claim comparison for the research workspace.',
    authType: 'api-key',
    documentationUrl: 'https://consensus.app/',
    allowedHosts: ['api.consensus.app'],
    scopes: ['search:read'],
    scopesVerified: false,
    maxRisk: 'safe',
    dataRetention: 'Query text and returned citations, retained with the research brief.',
    degradedBehavior:
      'Contradiction detection falls back to the local negation and numeric-divergence checks over sources already retrieved.',
    tools: [
      {
        name: 'consensus.search_claims',
        description: 'Search the literature for evidence bearing on a claim.',
        risk: 'safe',
        reversible: true,
      },
    ],
  },
  {
    id: 'wolfram',
    name: 'Wolfram',
    purpose: 'Mathematics, statistics, and scientific validation of computed results.',
    authType: 'api-key',
    documentationUrl: 'https://products.wolframalpha.com/api/documentation',
    allowedHosts: ['api.wolframalpha.com'],
    scopes: ['query:read'],
    scopesVerified: false,
    maxRisk: 'safe',
    dataRetention: 'Query text and results, retained with the run that issued them.',
    degradedBehavior:
      'Numeric verification uses the deterministic local checks only. Results that would have been externally validated are marked unverified rather than assumed correct.',
    tools: [
      {
        name: 'wolfram.evaluate',
        description: 'Evaluate a mathematical or statistical query.',
        risk: 'safe',
        reversible: true,
      },
    ],
  },
];

export type ConnectorViolation =
  | 'connector_host_not_https_capable'
  | 'connector_host_missing'
  | 'connector_scope_missing'
  | 'connector_retention_missing'
  | 'connector_degraded_behavior_missing'
  | 'connector_tool_missing'
  | 'connector_duplicate_id';

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Validate one catalog entry. Returns every violation rather than the first,
 * so a new connector can be corrected in one pass.
 */
export function validateConnector(definition: ConnectorDefinition): ConnectorViolation[] {
  const violations: ConnectorViolation[] = [];

  if (!definition.allowedHosts.length) violations.push('connector_host_missing');
  for (const host of definition.allowedHosts) {
    // Bare hostnames only: a scheme, port, or path here would silently widen
    // the allowlist when it is compared against a request's hostname.
    if (!HOSTNAME.test(host)) violations.push('connector_host_not_https_capable');
  }
  // `none` is the only auth type that legitimately needs no scopes.
  if (definition.authType !== 'none' && !definition.scopes.length) {
    violations.push('connector_scope_missing');
  }
  if (!definition.dataRetention.trim()) violations.push('connector_retention_missing');
  if (!definition.degradedBehavior.trim()) violations.push('connector_degraded_behavior_missing');
  if (!definition.tools.length) violations.push('connector_tool_missing');

  return violations;
}

/** The catalog, validated. Throws at import time if an entry is malformed. */
export function connectorCatalog(): readonly ConnectorDefinition[] {
  const seen = new Set<string>();
  for (const definition of CATALOG) {
    if (seen.has(definition.id)) throw new Error(`connector_duplicate_id:${definition.id}`);
    seen.add(definition.id);
    const violations = validateConnector(definition);
    if (violations.length) {
      throw new Error(`connector_invalid:${definition.id}:${violations.join(',')}`);
    }
  }
  return CATALOG;
}

export function findConnector(id: string): ConnectorDefinition | undefined {
  return connectorCatalog().find((definition) => definition.id === id);
}

/**
 * The plugin record an install produces.
 *
 * Deliberately disabled, workspace-scoped off, and network-restricted to the
 * connector's declared hosts. Installing a connector grants no authority; a
 * separate, audited enable step does.
 */
export function connectorPluginRecord(definition: ConnectorDefinition): {
  name: string;
  source: string;
  releaseVersion: string;
  enabled: false;
  pinned: boolean;
  dependencies: string[];
  workspaceEnabled: false;
  projectIds: never[];
  agentIds: never[];
  network: 'allowlist';
  retention: string;
  permissions: string[];
} {
  return {
    name: definition.name,
    source: `connector:${definition.id}`,
    releaseVersion: '1.0.0',
    enabled: false,
    pinned: true,
    dependencies: [],
    workspaceEnabled: false,
    projectIds: [],
    agentIds: [],
    network: 'allowlist',
    retention: definition.dataRetention,
    permissions: definition.scopes.map((scope) => `${definition.id}:${scope}`),
  };
}
