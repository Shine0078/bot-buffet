import { findConnector } from './connectors.js';
import type { Agent, Plugin } from './types.js';

export interface PluginInvocationInput {
  pluginId: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface PluginInvocationResult {
  pluginId: string;
  pluginName: string;
  tool: string;
  connectorId?: string;
  status: 'unavailable';
  reason: string;
}

const CONNECTOR_SOURCE = /^connector:([a-z0-9-]+)$/;

export function invokePlugin(
  agent: Pick<Agent, 'id' | 'projectId' | 'profile'>,
  plugins: readonly Plugin[],
  input: PluginInvocationInput,
): PluginInvocationResult {
  if (!agent.profile.allowedPluginIds.includes(input.pluginId)) {
    throw new Error(`plugin_not_allowed:${input.pluginId}`);
  }
  const plugin = plugins.find((candidate) => candidate.id === input.pluginId);
  if (!plugin) throw new Error(`plugin_not_found:${input.pluginId}`);
  if (plugin.kind !== 'plugin') throw new Error(`plugin_not_found:${input.pluginId}`);
  if (!plugin.enabled || !plugin.workspaceEnabled) {
    throw new Error(`plugin_disabled:${input.pluginId}`);
  }
  if (plugin.projectIds.length > 0 && !plugin.projectIds.includes(agent.projectId)) {
    throw new Error(`plugin_project_denied:${input.pluginId}`);
  }
  if (plugin.agentIds.length > 0 && !plugin.agentIds.includes(agent.id)) {
    throw new Error(`plugin_not_bound:${input.pluginId}`);
  }
  const match = plugin.source.match(CONNECTOR_SOURCE);
  const connector = match ? findConnector(match[1]!) : undefined;
  const tool = connector?.tools.find((entry) => entry.name === input.tool);
  if (connector && !tool) {
    throw new Error(`plugin_tool_unknown:${input.tool}`);
  }
  return {
    pluginId: plugin.id,
    pluginName: plugin.name,
    tool: input.tool,
    connectorId: connector?.id,
    status: 'unavailable',
    reason: connector
      ? `Connector ${connector.id} is installed but has no live credential; ${connector.degradedBehavior}`
      : 'Plugin has no live invocation backend.',
  };
}
