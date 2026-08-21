import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createBuiltinTools } from '../src/tools.js';

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
});
