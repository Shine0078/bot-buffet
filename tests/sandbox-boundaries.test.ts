import { describe, expect, it } from 'vitest';
import { mkdtemp, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createBuiltinTools } from '../src/tools.js';

const context = (dir: string) => ({
  actorId: 'u',
  runId: 'r',
  projectId: 'p',
  workspaceRoot: dir,
  allowedPaths: ['.'],
  protectedPaths: ['.env'],
  network: 'blocked' as const,
});

describe('sandbox boundary hardening', () => {
  it('refuses absolute paths and encoded traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-boundary-'));
    const tools = createBuiltinTools(createStore(dir));
    const ctx = context(dir);
    for (const path of [
      '/etc/passwd',
      'C:/Windows/System32/config/SAM',
      '..\\..\\secret',
      'nested/../../escape',
    ]) {
      await expect(tools.invoke('filesystem.read', { path }, ctx)).rejects.toThrow(/path_rejected/);
    }
  });

  it('refuses a symlink that escapes the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'bot-buffet-outside-'));
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-boundary-'));
    await writeFile(join(outside, 'secret.txt'), 'classified');
    const tools = createBuiltinTools(createStore(dir));
    try {
      await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'));
    } catch {
      // Symlink creation needs privileges on some Windows configurations; the lexical and
      // realpath guards are still exercised by the other cases in this suite.
      return;
    }
    await expect(
      tools.invoke('filesystem.read', { path: 'link.txt' }, context(dir)),
    ).rejects.toThrow(/path_rejected/);
  });

  it('rejects null bytes in paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-boundary-'));
    const tools = createBuiltinTools(createStore(dir));
    await expect(
      tools.invoke('filesystem.read', { path: 'note\u0000.txt' }, context(dir)),
    ).rejects.toThrow(/path_rejected/);
  });

  it('rejects shell injection attempts across several metacharacters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-boundary-'));
    const tools = createBuiltinTools(createStore(dir));
    const ctx = context(dir);
    for (const args of [
      ['--version; rm -rf /'],
      ['--version && whoami'],
      ['--version | cat'],
      ['$(whoami)'],
      ['`whoami`'],
    ]) {
      await expect(tools.invoke('shell.exec', { command: 'node', args }, ctx)).rejects.toThrow();
    }
  });

  it('keeps protected paths unreadable even through a nested directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-boundary-'));
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, '.env'), 'API_KEY=value');
    const tools = createBuiltinTools(createStore(dir));
    await expect(
      tools.invoke('filesystem.read', { path: 'nested/../.env' }, context(dir)),
    ).rejects.toThrow();
  });
});
