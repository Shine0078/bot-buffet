import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const backupScript = join(process.cwd(), 'scripts', 'backup.mjs');
const restoreScript = join(process.cwd(), 'scripts', 'restore.mjs');
const backupKey = 'b'.repeat(32);

const runScript = async (
  script: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string }> => {
  const result = await execFileAsync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

describe('backup and restore scripts', () => {
  it('copies only supported state files, signs the manifest, and restores verified bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bot-buffet-backup-'));
    const data = join(root, 'data');
    const backup = join(root, 'backup');
    const restored = join(root, 'restored');
    await mkdir(data, { recursive: true });
    try {
      await writeFile(join(data, 'state.json'), '{"schemaVersion":1}', { mode: 0o600 });
      await writeFile(join(data, 'credentials.enc.json'), '{"records":[]}', { mode: 0o600 });
      await writeFile(join(data, 'credentials.enc.json.key'), 'development-key', { mode: 0o600 });

      await runScript(backupScript, [backup], {
        BOT_BUFFET_DATA_DIR: data,
        BOT_BUFFET_BACKUP_KEY: backupKey,
        BOT_BUFFET_AUTH_MODE: 'development',
      });

      const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')) as {
        files: Array<{ file: string; sha256: string }>;
      };
      expect(manifest.files.map((item) => item.file)).toEqual([
        'state.json',
        'credentials.enc.json',
      ]);
      expect(await readFile(join(backup, 'manifest.mac'), 'utf8')).toMatch(/^[a-f0-9]{64}$/);
      await expect(access(join(backup, 'credentials.enc.json.key'))).rejects.toBeDefined();

      await runScript(restoreScript, [backup], {
        BOT_BUFFET_DATA_DIR: restored,
        BOT_BUFFET_BACKUP_KEY: backupKey,
        BOT_BUFFET_AUTH_MODE: 'production',
      });
      await expect(readFile(join(restored, 'state.json'), 'utf8')).resolves.toBe(
        '{"schemaVersion":1}',
      );
      await expect(readFile(join(restored, 'credentials.enc.json'), 'utf8')).resolves.toBe(
        '{"records":[]}',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects tampered backup bytes before promotion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bot-buffet-backup-'));
    const data = join(root, 'data');
    const backup = join(root, 'backup');
    const restored = join(root, 'restored');
    await mkdir(data, { recursive: true });
    try {
      await writeFile(join(data, 'state.json'), '{"safe":true}', { mode: 0o600 });
      await runScript(backupScript, [backup], {
        BOT_BUFFET_DATA_DIR: data,
        BOT_BUFFET_BACKUP_KEY: backupKey,
      });
      await writeFile(join(backup, 'state.json'), '{"safe":false}', { mode: 0o600 });

      await expect(
        runScript(restoreScript, [backup], {
          BOT_BUFFET_DATA_DIR: restored,
          BOT_BUFFET_BACKUP_KEY: backupKey,
          BOT_BUFFET_AUTH_MODE: 'production',
        }),
      ).rejects.toThrow(/restore_hash_mismatch:state\.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
