import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const source = resolve(process.argv[2] ?? '');
const target = resolve(process.env.BOT_BUFFET_DATA_DIR ?? '.data-restore');
if (!source || source === resolve('.')) throw new Error('restore_requires_backup_directory');
const manifestText = await readFile(join(source, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const backupKey = process.env.BOT_BUFFET_BACKUP_KEY ?? process.env.BOT_BUFFET_MASTER_KEY;
const key = backupKey ? createHash('sha256').update(backupKey).digest() : undefined;
let manifestMac;
try {
  manifestMac = (await readFile(join(source, 'manifest.mac'), 'utf8')).trim();
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
if (manifestMac) {
  if (!backupKey) throw new Error('restore_manifest_key_required');
  const expected = Buffer.from(createHmac('sha256', backupKey).update(manifestText).digest('hex'));
  const presented = Buffer.from(manifestMac);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented))
    throw new Error('restore_manifest_authentication_failed');
} else if (process.env.BOT_BUFFET_AUTH_MODE === 'production') {
  throw new Error('production_signed_manifest_required');
}
await mkdir(target, { recursive: true });
for (const item of manifest.files ?? []) {
  if (
    !item ||
    !['state.json', 'credentials.enc.json'].includes(item.file) ||
    typeof item.sha256 !== 'string'
  )
    throw new Error('restore_manifest_rejected:unexpected_file');
  const stored = await readFile(join(source, item.file));
  const hash = createHash('sha256').update(stored).digest('hex');
  if (hash !== item.sha256) throw new Error(`restore_hash_mismatch:${item.file}`);
  let bytes = stored;
  if (item.encrypted) {
    if (!key) throw new Error('restore_backup_key_required');
    let envelope;
    try {
      envelope = JSON.parse(stored.toString('utf8'));
      if (
        envelope?.version !== 1 ||
        envelope.algorithm !== 'aes-256-gcm' ||
        typeof envelope.nonce !== 'string' ||
        typeof envelope.tag !== 'string' ||
        typeof envelope.ciphertext !== 'string'
      )
        throw new Error('invalid_envelope');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(envelope.nonce, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      bytes = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final(),
      ]);
    } catch {
      throw new Error(`restore_decryption_failed:${item.file}`);
    }
  } else if (process.env.BOT_BUFFET_AUTH_MODE === 'production' && item.file === 'state.json') {
    throw new Error('production_encrypted_state_required');
  }
  const tmp = join(target, `${item.file}.${process.pid}.tmp`);
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, join(target, item.file));
}
console.log(`Restore verified into ${target}; review it before promotion.`);
