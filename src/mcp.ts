import { assertSafeEndpoint } from './security.js';
import type { MCPServer } from './types.js';

export interface McpInvocationInput {
  serverId: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface McpInvocationResult {
  serverId: string;
  serverName: string;
  tool: string;
  status: 'unavailable';
  reason: string;
}

export function invokeMcpServer(
  servers: readonly MCPServer[],
  input: McpInvocationInput,
): McpInvocationResult {
  const server = servers.find((candidate) => candidate.id === input.serverId);
  if (!server || server.kind !== 'mcp-server') {
    throw new Error(`mcp_not_found:${input.serverId}`);
  }
  if (!server.enabled) throw new Error(`mcp_disabled:${input.serverId}`);
  if (!input.tool.trim()) throw new Error('mcp_tool_required');
  if (server.toolNames.length > 0 && !server.toolNames.includes(input.tool)) {
    throw new Error(`mcp_tool_not_exported:${input.tool}`);
  }
  if (server.transport !== 'stdio') {
    assertSafeEndpoint(server.endpoint);
  } else if (!server.endpoint.trim()) {
    throw new Error('mcp_endpoint_required');
  }
  if (!server.integritySha256) {
    throw new Error(`mcp_integrity_required:${input.serverId}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(server.integritySha256)) {
    throw new Error(`mcp_integrity_invalid:${input.serverId}`);
  }
  return {
    serverId: server.id,
    serverName: server.name,
    tool: input.tool,
    status: 'unavailable',
    reason:
      'MCP servers are registered and permission-checked, but live stdio/SSE/streamable-http execution is not enabled without a verified runtime and credential.',
  };
}
