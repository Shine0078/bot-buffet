import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dataDir = resolve(process.env.BOT_BUFFET_DATA_DIR ?? '.data');
const backupKey = process.env.BOT_BUFFET_BACKUP_KEY ?? process.env.BOT_BUFFET_MASTER_KEY;
if (
  process.env.BOT_BUFFET_AUTH_MODE === 'production' &&
  (!backupKey || Buffer.byteLength(backupKey) < 32)
)
  throw new Error('production_backup_key_required');
const output = resolve(
  process.argv[2] ?? `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
await mkdir(output, { recursive: true });
const files = ['state.json', 'credentials.enc.json'];
const manifest = { createdAt: new Date().toISOString(), source: dataDir, files: [] };
for (const file of files) {
  try {
    const bytes = await readFile(join(dataDir, file));
    await writeFile(join(output, file), bytes, { mode: 0o600 });
    manifest.files.push({
      file,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const manifestText = JSON.stringify(manifest, null, 2);
await writeFile(join(output, 'manifest.json'), manifestText, { mode: 0o600 });
if (backupKey)
  await writeFile(
    join(output, 'manifest.mac'),
    createHmac('sha256', backupKey).update(manifestText).digest('hex'),
    { mode: 0o600 },
  );
console.log(`Backup created at ${output} (${manifest.files.length} files)`);
