import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokePlugin } from '../src/plugins.js';
import { createBuiltinTools } from '../src/tools.js';
import { createStore } from '../src/store.js';
import { entity, type Agent, type Plugin } from '../src/types.js';

const agent = (allowedPluginIds: string[]): Agent =>
  entity({
    kind: 'agent',
    ownerId: 'u',
    scope: 'p',
    projectId: 'p',
    environmentId: 'e',
    status: 'idle',
    profile: {
      name: 'A',
      mission: 'test',
      systemInstructions: 'test',
      projectRules: [],
      skills: [],
      allowedModels: [],
      fallbackModelIds: [],
      allowedToolIds: ['plugin.invoke'],
      allowedPluginIds,
      allowedPaths: ['.'],
      protectedPaths: [],
      network: 'blocked',
      environmentKeys: [],
      maxSteps: 1,
      timeLimitMs: 1000,
      tokenLimit: 1000,
      costLimitCents: 0,
      concurrencyLimit: 1,
      approvalPolicy: {
        requiredRisks: [],
        autoApproveReversible: true,
        expiryMs: 1000,
        delegates: [],
      },
      verificationPolicy: { deterministic: [], inferential: [], requireEvidence: false },
      memoryPolicy: {
        readableScopes: [],
        writableScopes: [],
        requireApproval: false,
        retentionDays: 0,
      },
      outputFormat: 'text',
      escalationPolicy: 'pause',
      mode: 'supervised',
      version: 1,
      changelog: [],
    },
  }) as Agent;

const plugin = (overrides: Partial<Plugin> = {}): Plugin =>
  entity({
    kind: 'plugin',
    ownerId: 'u',
    scope: 'p',
    name: 'GitHub',
    releaseVersion: '1.0.0',
    source: 'connector:github',
    enabled: true,
    pinned: true,
    dependencies: [],
    workspaceEnabled: true,
    projectIds: [],
    agentIds: [],
    network: 'allowlist',
    retention: 'none',
    permissions: [],
    ...overrides,
  }) as Plugin;

describe('plugin invocation authority', () => {
  const plug = plugin();

  it('refuses a plugin that is not on the agent allowlist', () => {
    expect(() =>
      invokePlugin(agent([]), [plug], {
        pluginId: plug.id,
        tool: 'github.list_repositories',
      }),
    ).toThrow(/plugin_not_allowed/);
  });

  it('refuses a disabled plugin even when it is allowlisted', () => {
    const disabled = plugin({ enabled: false });
    expect(() =>
      invokePlugin(agent([disabled.id]), [disabled], {
        pluginId: disabled.id,
        tool: 'github.list_repositories',
      }),
    ).toThrow(/plugin_disabled/);
  });

  it('refuses an unknown connector tool rather than inventing a live call', () => {
    expect(() =>
      invokePlugin(agent([plug.id]), [plug], {
        pluginId: plug.id,
        tool: 'github.delete.everything',
      }),
    ).toThrow(/plugin_tool_unknown/);
  });

  it('returns an unavailable result for a known tool instead of claiming a live account', () => {
    const result = invokePlugin(agent([plug.id]), [plug], {
      pluginId: plug.id,
      tool: 'github.list_repositories',
    });
    expect(result.status).toBe('unavailable');
    expect(result.connectorId).toBe('github');
    expect(result.reason).toMatch(/no live credential/i);
  });

  it('refuses a plugin bound to a different project', () => {
    const other = plugin({ projectIds: ['other-project'] });
    expect(() =>
      invokePlugin(agent([other.id]), [other], {
        pluginId: other.id,
        tool: 'github.list_repositories',
      }),
    ).toThrow(/plugin_project_denied/);
  });

  it('refuses open network mode instead of treating it as allowlisted', () => {
    const opened = plugin({ network: 'open' });
    expect(() =>
      invokePlugin(agent([opened.id]), [opened], {
        pluginId: opened.id,
        tool: 'github.list_repositories',
      }),
    ).toThrow(/plugin_network_open_forbidden/);
  });

  it('refuses an allowlisted plugin that has no connector hosts', () => {
    const empty = plugin({ source: 'custom:local', network: 'allowlist' });
    expect(() =>
      invokePlugin(agent([empty.id]), [empty], {
        pluginId: empty.id,
        tool: 'custom.tool',
      }),
    ).toThrow(/plugin_allowlist_empty/);
  });
});

describe('plugin.invoke builtin', () => {
  it('is registered and cannot be executed outside the orchestrator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-plugin-'));
    const tools = createBuiltinTools(createStore(dir));
    expect(tools.list().some((tool) => tool.name === 'plugin.invoke')).toBe(true);
    await expect(
      tools.invoke(
        'plugin.invoke',
        { pluginId: 'plugin-1', tool: 'github.list_repositories' },
        {
          actorId: 'u',
          runId: 'r',
          projectId: 'p',
          workspaceRoot: dir,
          allowedPaths: ['.'],
          protectedPaths: [],
          network: 'blocked',
        },
      ),
    ).rejects.toThrow(/plugin_invoke_requires_orchestrator/);
  });
});
