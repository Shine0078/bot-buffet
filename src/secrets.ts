import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type EncryptedRecord = { iv: string; tag: string; ciphertext: string };

/** Small local vault. Production should point this contract at a KMS/secret manager. */
export class CredentialVault {
  private readonly records = new Map<string, string>();
  private loaded = false;
  private readonly key: Buffer;
  constructor(
    private readonly filePath: string,
    masterKey = process.env.BOT_BUFFET_MASTER_KEY,
  ) {
    if (!masterKey && process.env.BOT_BUFFET_AUTH_MODE === 'production')
      throw new Error('credential_vault:master_key_required');
    this.key = createHash('sha256')
      .update(masterKey ?? `dev-only-${process.env.USERNAME ?? 'local'}`)
      .digest();
  }
  private encrypt(value: string): EncryptedRecord {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }
  private decrypt(value: EncryptedRecord): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as Record<
        string,
        EncryptedRecord
      >;
      for (const [id, record] of Object.entries(raw)) this.records.set(id, this.decrypt(record));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }
  async set(id: string, secret: string): Promise<void> {
    await this.load();
    this.records.set(id, secret);
    await this.persist();
  }
  async revoke(id: string): Promise<void> {
    await this.load();
    this.records.delete(id);
    await this.persist();
  }
  getSync(id: string | undefined): string | undefined {
    return id ? this.records.get(id) : undefined;
  }
  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const encrypted = Object.fromEntries(
      [...this.records.entries()].map(([id, value]) => [id, this.encrypt(value)]),
    );
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}
