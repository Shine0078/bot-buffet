import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dataDir = resolve(process.env.BOT_BUFFET_DATA_DIR ?? '.data');
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
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(`Backup created at ${output} (${manifest.files.length} files)`);
