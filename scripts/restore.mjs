import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const source = resolve(process.argv[2] ?? '');
const target = resolve(process.env.BOT_BUFFET_DATA_DIR ?? '.data-restore');
if (!source || source === resolve('.')) throw new Error('restore_requires_backup_directory');
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
await mkdir(target, { recursive: true });
for (const item of manifest.files ?? []) {
  const bytes = await readFile(join(source, item.file));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== item.sha256) throw new Error(`restore_hash_mismatch:${item.file}`);
  const tmp = join(target, `${item.file}.${process.pid}.tmp`);
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, join(target, item.file));
}
console.log(`Restore verified into ${target}; review it before promotion.`);
