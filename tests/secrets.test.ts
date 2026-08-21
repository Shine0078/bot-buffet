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
});
