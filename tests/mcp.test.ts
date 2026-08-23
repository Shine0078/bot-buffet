import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeMcpServer } from '../src/mcp.js';
import { createBuiltinTools } from '../src/tools.js';
import { createStore } from '../src/store.js';
import { entity, type MCPServer } from '../src/types.js';

const digest = 'a'.repeat(64);

const server = (overrides: Partial<MCPServer> = {}): MCPServer =>
  entity({
    kind: 'mcp-server',
    ownerId: 'u',
    scope: 'w',
    name: 'Docs',
    endpoint: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    enabled: true,
    toolNames: ['search'],
    integritySha256: digest,
    ...overrides,
  }) as MCPServer;

describe('MCP invocation authority', () => {
  it('refuses a disabled server', () => {
    const disabled = server({ enabled: false });
    expect(() => invokeMcpServer([disabled], { serverId: disabled.id, tool: 'search' })).toThrow(
      /mcp_disabled/,
    );
  });

  it('refuses a tool the server did not export', () => {
    const registered = server();
    expect(() =>
      invokeMcpServer([registered], { serverId: registered.id, tool: 'delete' }),
    ).toThrow(/mcp_tool_not_exported/);
  });

  it('refuses a server with no integrity pin', () => {
    const unpinned = server({ integritySha256: undefined });
    expect(() => invokeMcpServer([unpinned], { serverId: unpinned.id, tool: 'search' })).toThrow(
      /mcp_integrity_required/,
    );
  });

  it('returns unavailable instead of inventing a live MCP session', () => {
    const registered = server();
    const result = invokeMcpServer([registered], { serverId: registered.id, tool: 'search' });
    expect(result.status).toBe('unavailable');
    expect(result.serverName).toBe('Docs');
  });
});

describe('mcp.invoke builtin', () => {
  it('is registered and fail-closed without a supplied server catalog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-mcp-'));
    const tools = createBuiltinTools(createStore(dir));
    expect(tools.list().some((tool) => tool.name === 'mcp.invoke')).toBe(true);
    await expect(
      tools.invoke(
        'mcp.invoke',
        { serverId: 'missing', tool: 'search' },
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
    ).rejects.toThrow(/mcp_not_found/);
  });
});
