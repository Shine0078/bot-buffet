import { describe, expect, it } from 'vitest';
import { pluginAppliesToAgent } from '../src/plugins.js';
import type { Agent, Plugin } from '../src/types.js';

const agent = (overrides: Partial<Agent['profile']> = {}): Agent =>
  ({
    id: 'agent-1',
    kind: 'agent',
    ownerId: 'user-1',
    scope: 'project-1',
    projectId: 'project-1',
    environmentId: 'environment-1',
    status: 'idle',
    profile: { allowedPluginIds: [], ...overrides } as Agent['profile'],
  }) as Agent;

const plugin = (overrides: Partial<Plugin> = {}): Plugin =>
  ({
    id: 'plugin-1',
    kind: 'plugin',
    ownerId: 'user-1',
    scope: 'workspace-1',
    version: 1,
    enabled: true,
    workspaceEnabled: false,
    projectIds: [],
    agentIds: [],
    ...overrides,
  }) as Plugin;

describe('plugin activation policy', () => {
  it('requires an enabled workspace, project, or agent assignment', () => {
    expect(pluginAppliesToAgent(plugin(), agent())).toBe(false);
    expect(pluginAppliesToAgent(plugin({ projectIds: ['project-1'] }), agent())).toBe(true);
    expect(pluginAppliesToAgent(plugin({ agentIds: ['agent-1'] }), agent())).toBe(true);
    expect(pluginAppliesToAgent(plugin({ workspaceEnabled: true }), agent())).toBe(true);
  });

  it('applies the explicit agent profile allowlist as an additional constraint', () => {
    const assigned = plugin({ projectIds: ['project-1'] });
    expect(pluginAppliesToAgent(assigned, agent({ allowedPluginIds: ['other-plugin'] }))).toBe(
      false,
    );
    expect(pluginAppliesToAgent(assigned, agent({ allowedPluginIds: ['plugin-1'] }))).toBe(true);
  });

  it('fails closed when the plugin is disabled', () => {
    expect(pluginAppliesToAgent(plugin({ enabled: false, workspaceEnabled: true }), agent())).toBe(
      false,
    );
  });
});
