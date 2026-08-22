import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
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
const key = backupKey ? createHash('sha256').update(backupKey).digest() : undefined;
const encrypt = (bytes) => {
  if (!key) return { bytes, encrypted: false };
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    bytes: Buffer.from(
      JSON.stringify({
        version: 1,
        algorithm: 'aes-256-gcm',
        nonce: nonce.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      }),
    ),
    encrypted: true,
  };
};
const manifest = {
  version: 2,
  createdAt: new Date().toISOString(),
  source: dataDir,
  files: [],
};
for (const file of files) {
  try {
    const plaintext = await readFile(join(dataDir, file));
    if (process.env.BOT_BUFFET_AUTH_MODE === 'production' && file === 'state.json' && !key)
      throw new Error('production_backup_encryption_required');
    // State contains prompts, files, memory, and audit metadata. Encrypt it
    // with authenticated encryption whenever a backup key is available; the
    // credential vault is already encrypted at rest and remains byte-for-byte
    // restorable so its separately provisioned vault key is preserved.
    const stored =
      file === 'state.json' ? encrypt(plaintext) : { bytes: plaintext, encrypted: false };
    await writeFile(join(output, file), stored.bytes, { mode: 0o600 });
    manifest.files.push({
      file,
      bytes: stored.bytes.length,
      sha256: createHash('sha256').update(stored.bytes).digest('hex'),
      encrypted: stored.encrypted,
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
