import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createBuiltinTools, ToolRegistry } from '../src/tools.js';
import { entity, ToolDefinition } from '../src/types.js';

describe('sandboxed builtin tools', () => {
  it('rejects traversal and writes only inside workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-'));
    const store = createStore(dir);
    const tools = createBuiltinTools(store);
    const context = {
      actorId: 'u',
      runId: 'r',
      projectId: 'p',
      workspaceRoot: dir,
      allowedPaths: ['.'],
      protectedPaths: ['.env'],
      network: 'blocked' as const,
    };
    await expect(tools.invoke('filesystem.read', { path: '../secret' }, context)).rejects.toThrow(
      'traversal',
    );
    await tools.invoke('filesystem.write', { path: 'note.txt', content: 'safe' }, context);
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('safe');
    await expect(
      store.list((value) => value.kind === 'audit-event' && value.action === 'tool.executed'),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ resourceId: 'r' })]));
  });
  it('returns durable file hashes and rejects stale write preconditions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-'));
    const store = createStore(dir);
    const tools = createBuiltinTools(store);
    const context = {
      actorId: 'u',
      runId: 'r',
      projectId: 'p',
      workspaceRoot: dir,
      allowedPaths: ['.'],
      protectedPaths: ['.env'],
      network: 'blocked' as const,
    };

    await tools.invoke('filesystem.write', { path: 'note.txt', content: 'one' }, context);
    const observed = (await tools.invoke('filesystem.read', { path: 'note.txt' }, context)) as {
      sha256: string;
      versionLabel: string;
    };
    expect(observed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(observed.versionLabel).toBe('v1');

    const updated = (await tools.invoke(
      'filesystem.write',
      { path: 'note.txt', content: 'two', expectedSha256: observed.sha256 },
      context,
    )) as { versionLabel: string };
    expect(updated.versionLabel).toBe('v2');
    await expect(
      tools.invoke(
        'filesystem.write',
        { path: 'note.txt', content: 'stale', expectedSha256: observed.sha256 },
        context,
      ),
    ).rejects.toThrow('filesystem_write_conflict');
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('two');
    const files = await store.list((value) => value.kind === 'file');
    expect(files).toHaveLength(1);
    expect((files[0] as unknown as { versionLabel: string }).versionLabel).toBe('v2');
  });
  it('blocks protected files and unsafe shell commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-'));
    const store = createStore(dir);
    const tools = createBuiltinTools(store);
    const context = {
      actorId: 'u',
      runId: 'r',
      projectId: 'p',
      workspaceRoot: dir,
      allowedPaths: ['.'],
      protectedPaths: ['.env'],
      network: 'blocked' as const,
    };
    await expect(
      tools.invoke('filesystem.write', { path: '.env', content: 'secret' }, context),
    ).rejects.toThrow('protected_path');
    await expect(
      tools.invoke('filesystem.write', { path: '.env.local', content: 'secret' }, context),
    ).rejects.toThrow('protected_path');
    await writeFile(join(dir, '.env'), 'secret');
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'config'), 'safe');
    await expect(tools.invoke('filesystem.read', { path: '.env' }, context)).rejects.toThrow(
      'protected_path',
    );
    await expect(tools.invoke('filesystem.stat', { path: '.git/config' }, context)).rejects.toThrow(
      'protected_path',
    );
    await expect(
      tools.invoke('shell.exec', { command: 'node', args: ['-e', 'console.log(1);'] }, context),
    ).rejects.toThrow('shell_metacharacter');
  });
  it('enforces the declared tool timeout', async () => {
    const registry = new ToolRegistry();
    const definition = entity({
      kind: 'tool',
      ownerId: 'u',
      scope: 'p',
      name: 'slow',
      description: 'slow test tool',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      requiredScope: 'project',
      resourceScope: 'project',
      risk: 'safe' as const,
      reversible: true,
      authRequired: false,
      timeoutMs: 5,
      rateLimitPerMinute: 60,
      outputLimitBytes: 1000,
      releaseVersion: '1.0.0',
      owner: 'test',
      enabled: true,
    }) as ToolDefinition;
    registry.register({
      definition,
      execute: async () => new Promise((resolve) => setTimeout(() => resolve({}), 50)),
    });
    await expect(
      registry.invoke(
        'slow',
        {},
        {
          actorId: 'u',
          runId: 'r',
          projectId: 'p',
          workspaceRoot: '.',
          allowedPaths: ['.'],
          protectedPaths: [],
          network: 'blocked',
        },
      ),
    ).rejects.toThrow('tool_timeout');
  });

  it('rejects disabled tools before invoking their implementation', async () => {
    const registry = new ToolRegistry();
    const definition = entity({
      kind: 'tool',
      ownerId: 'u',
      scope: 'p',
      name: 'disabled',
      description: 'disabled test tool',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      requiredScope: 'project',
      resourceScope: 'project',
      risk: 'safe' as const,
      reversible: true,
      authRequired: false,
      timeoutMs: 100,
      rateLimitPerMinute: 60,
      outputLimitBytes: 1000,
      releaseVersion: '1.0.0',
      owner: 'test',
      enabled: false,
    }) as ToolDefinition;
    let invoked = false;
    registry.register({
      definition,
      execute: async () => {
        invoked = true;
        return {};
      },
    });
    await expect(
      registry.invoke(
        'disabled',
        {},
        {
          actorId: 'u',
          runId: 'r',
          projectId: 'p',
          workspaceRoot: '.',
          allowedPaths: ['.'],
          protectedPaths: [],
          network: 'blocked',
        },
      ),
    ).rejects.toThrow('tool_disabled');
    expect(invoked).toBe(false);
  });
});
