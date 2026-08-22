import { Agent, Plugin } from './types.js';

/**
 * Return whether an enabled plugin is available to a particular agent.
 *
 * Workspace activation is the broad grant; project and agent assignments are
 * narrower grants. An explicit agent profile allowlist is an additional
 * constraint, while an empty list preserves the default "no per-agent
 * restriction" behaviour used by existing profiles.
 */
export const pluginAppliesToAgent = (plugin: Plugin, agent: Agent): boolean => {
  if (!plugin.enabled) return false;
  const assigned =
    plugin.workspaceEnabled ||
    plugin.projectIds.includes(agent.projectId) ||
    plugin.agentIds.includes(agent.id);
  if (!assigned) return false;
  const allowlist = agent.profile.allowedPluginIds;
  return allowlist.length === 0 || allowlist.includes(plugin.id);
};
