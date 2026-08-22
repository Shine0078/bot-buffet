import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { CredentialVault } from '../src/secrets.js';

/**
 * The credential vault.
 *
 * Everything a provider connection needs to authenticate lives here, so the
 * properties that matter are that nothing is written in the clear, that a
 * tampered record fails rather than decrypting to something, and that
 * production refuses to run on a placeholder key.
 */

const saved = {
  auth: process.env.BOT_BUFFET_AUTH_MODE,
  master: process.env.BOT_BUFFET_MASTER_KEY,
};

afterEach(() => {
  if (saved.auth === undefined) delete process.env.BOT_BUFFET_AUTH_MODE;
  else process.env.BOT_BUFFET_AUTH_MODE = saved.auth;
  if (saved.master === undefined) delete process.env.BOT_BUFFET_MASTER_KEY;
  else process.env.BOT_BUFFET_MASTER_KEY = saved.master;
});

const vaultPath = async () => join(await mkdtemp(join(tmpdir(), 'bot-buffet-vault-')), 'creds.json');

const STRONG_KEY = 'a-master-key-of-at-least-32-characters-long';

describe('storing and retrieving secrets', () => {
  it('round-trips a secret through disk', async () => {
    const path = await vaultPath();
    const vault = new CredentialVault(path, STRONG_KEY);
    await vault.set('provider-1', 'sk-the-actual-secret');

    // A fresh instance over the same file, which is what a restart looks like.
    const reopened = new CredentialVault(path, STRONG_KEY);
    await reopened.load();
    expect(reopened.getSync('provider-1')).toBe('sk-the-actual-secret');
  });

  it('never writes the secret in the clear', async () => {
    const path = await vaultPath();
    const vault = new CredentialVault(path, STRONG_KEY);
    await vault.set('provider-1', 'sk-the-actual-secret');

    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).not.toContain('sk-the-actual-secret');
    const record = JSON.parse(onDisk)['provider-1'] as Record<string, string>;
    // AES-GCM: an initialisation vector and an authentication tag, not just
    // ciphertext, so tampering is detectable rather than merely garbled.
    expect(record).toHaveProperty('iv');
    expect(record).toHaveProperty('tag');
    expect(record).toHaveProperty('ciphertext');
  });

  it('returns undefined for an unknown or absent id', async () => {
    const vault = new CredentialVault(await vaultPath(), STRONG_KEY);
    await vault.load();
    expect(vault.getSync('nope')).toBeUndefined();
    expect(vault.getSync(undefined)).toBeUndefined();
  });

  it('replaces a secret rather than keeping both', async () => {
    const path = await vaultPath();
    const vault = new CredentialVault(path, STRONG_KEY);
    await vault.set('provider-1', 'first');
    await vault.set('provider-1', 'second');

    const reopened = new CredentialVault(path, STRONG_KEY);
    await reopened.load();
    expect(reopened.getSync('provider-1')).toBe('second');
    expect(await readFile(path, 'utf8')).not.toContain('first');
  });

  it('revokes a secret from disk, not only from memory', async () => {
    const path = await vaultPath();
    const vault = new CredentialVault(path, STRONG_KEY);
    await vault.set('provider-1', 'sk-revoke-me');
    await vault.set('provider-2', 'sk-keep-me');
    await vault.revoke('provider-1');

    const reopened = new CredentialVault(path, STRONG_KEY);
    await reopened.load();
    expect(reopened.getSync('provider-1')).toBeUndefined();
    expect(reopened.getSync('provider-2')).toBe('sk-keep-me');
  });

  it('revoking something absent is not an error', async () => {
    const vault = new CredentialVault(await vaultPath(), STRONG_KEY);
    await expect(vault.revoke('never-existed')).resolves.toBeUndefined();
  });

  it('handles a vault file that does not exist yet', async () => {
    const vault = new CredentialVault(await vaultPath(), STRONG_KEY);
    await expect(vault.load()).resolves.toBeUndefined();
    expect(vault.getSync('anything')).toBeUndefined();
  });
});

describe('key separation', () => {
  it('cannot read records written under a different key', async () => {
    const path = await vaultPath();
    await new CredentialVault(path, STRONG_KEY).set('provider-1', 'sk-secret');

    const wrongKey = new CredentialVault(path, 'a-different-master-key-that-is-long-enough');
    // The authentication tag fails rather than yielding plausible plaintext.
    await expect(wrongKey.load()).rejects.toThrow();
  });

  it('detects a tampered ciphertext instead of decrypting it', async () => {
    const path = await vaultPath();
    await new CredentialVault(path, STRONG_KEY).set('provider-1', 'sk-secret');

    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      { iv: string; tag: string; ciphertext: string }
    >;
    const flipped = Buffer.from(raw['provider-1']!.ciphertext, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;
    raw['provider-1']!.ciphertext = flipped.toString('base64');
    await writeFile(path, JSON.stringify(raw));

    await expect(new CredentialVault(path, STRONG_KEY).load()).rejects.toThrow();
  });

  it('detects a tampered authentication tag', async () => {
    const path = await vaultPath();
    await new CredentialVault(path, STRONG_KEY).set('provider-1', 'sk-secret');

    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      { iv: string; tag: string; ciphertext: string }
    >;
    raw['provider-1']!.tag = Buffer.alloc(16).toString('base64');
    await writeFile(path, JSON.stringify(raw));

    await expect(new CredentialVault(path, STRONG_KEY).load()).rejects.toThrow();
  });
});

describe('production key requirements', () => {
  it('refuses to start with no master key', async () => {
    process.env.BOT_BUFFET_AUTH_MODE = 'production';
    const path = await vaultPath();
    expect(() => new CredentialVault(path, undefined)).toThrow(
      /strong_master_key_required/,
    );
  });

  it('refuses a key that is too short', async () => {
    process.env.BOT_BUFFET_AUTH_MODE = 'production';
    const path = await vaultPath();
    expect(() => new CredentialVault(path, 'short')).toThrow(/strong_master_key_required/);
  });

  it('refuses a placeholder key that is long enough to look real', async () => {
    // The .env.example value is exactly this shape, and it would otherwise
    // pass a length check and ship as the production key.
    process.env.BOT_BUFFET_AUTH_MODE = 'production';
    const path = await vaultPath();
    for (const placeholder of [
      'replace-with-a-32-byte-secret-value-here',
      'this-is-an-example-key-of-sufficient-length',
      'changeme-changeme-changeme-changeme-1234',
    ]) {
      expect(() => new CredentialVault(path, placeholder), placeholder).toThrow(
        /strong_master_key_required/,
      );
    }
  });

  it('accepts a strong key in production', async () => {
    process.env.BOT_BUFFET_AUTH_MODE = 'production';
    const path = await vaultPath();
    expect(() => new CredentialVault(path, STRONG_KEY)).not.toThrow();
  });

  it('allows a generated local key outside production', async () => {
    delete process.env.BOT_BUFFET_AUTH_MODE;
    const path = await vaultPath();
    const vault = new CredentialVault(path, undefined);
    await vault.set('provider-1', 'sk-dev-secret');
    // The generated key is stored beside the vault, and reopening finds it.
    const reopened = new CredentialVault(path, undefined);
    await reopened.load();
    expect(reopened.getSync('provider-1')).toBe('sk-dev-secret');
  });

  it('writes the generated development key with owner-only permissions', async () => {
    delete process.env.BOT_BUFFET_AUTH_MODE;
    const path = await vaultPath();
    new CredentialVault(path, undefined);
    const info = await stat(`${path}.key`);
    expect(info.size).toBe(32);
    // Windows does not implement POSIX modes, so the bits are only meaningful
    // on platforms that do.
    if (platform() !== 'win32') {
      expect(info.mode & 0o077).toBe(0);
    }
  });

  it('refuses a local key file of the wrong length rather than padding it', async () => {
    delete process.env.BOT_BUFFET_AUTH_MODE;
    const path = await vaultPath();
    await writeFile(`${path}.key`, Buffer.alloc(8));
    await chmod(`${path}.key`, 0o600).catch(() => undefined);
    expect(() => new CredentialVault(path, undefined)).toThrow(/invalid_local_key/);
  });
});

describe('vault file permissions', () => {
  it('writes the vault owner-only', async () => {
    const path = await vaultPath();
    await new CredentialVault(path, STRONG_KEY).set('provider-1', 'sk-secret');
    const info = await stat(path);
    if (platform() !== 'win32') {
      expect(info.mode & 0o077).toBe(0);
    } else {
      expect(info.size).toBeGreaterThan(0);
    }
  });
});
