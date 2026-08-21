import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialVault } from '../src/secrets.js';

describe('credential vault', () => {
  it('encrypts secrets at rest and reloads them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-'));
    const path = join(dir, 'credentials.enc.json');
    const vault = new CredentialVault(path, 'test-master-key');
    await vault.set('provider-1', 'sk-live-secret-value');
    expect(await readFile(path, 'utf8')).not.toContain('sk-live-secret-value');
    const reloaded = new CredentialVault(path, 'test-master-key');
    await reloaded.load();
    expect(reloaded.getSync('provider-1')).toBe('sk-live-secret-value');
    await reloaded.revoke('provider-1');
    expect(reloaded.getSync('provider-1')).toBeUndefined();
  });
  it('generates and reuses a random development key instead of deriving one from the username', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-'));
    const path = join(dir, 'credentials.enc.json');
    const vault = new CredentialVault(path);
    await vault.set('provider-1', 'local-secret');
    const key = await readFile(`${path}.key`);
    expect(key).toHaveLength(32);
    const reloaded = new CredentialVault(path);
    await reloaded.load();
    expect(reloaded.getSync('provider-1')).toBe('local-secret');
  });
  it('rejects weak or placeholder production master keys', () => {
    const previous = process.env.BOT_BUFFET_AUTH_MODE;
    process.env.BOT_BUFFET_AUTH_MODE = 'production';
    try {
      expect(() => new CredentialVault('unused', 'replace-with-a-32-byte-secret')).toThrow(
        'strong_master_key_required',
      );
      expect(() => new CredentialVault('unused', 'short')).toThrow('strong_master_key_required');
    } finally {
      if (previous === undefined) delete process.env.BOT_BUFFET_AUTH_MODE;
      else process.env.BOT_BUFFET_AUTH_MODE = previous;
    }
  });
});
