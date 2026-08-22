import { afterEach, describe, expect, it } from 'vitest';
import {
  createSandboxRuntime,
  dockerRunArgs,
  isDigestPinned,
  resolveSandboxImage,
} from '../src/sandbox.js';

const previousMode = process.env.BOT_BUFFET_SANDBOX_MODE;
const previousAuth = process.env.BOT_BUFFET_AUTH_MODE;
afterEach(() => {
  if (previousMode === undefined) delete process.env.BOT_BUFFET_SANDBOX_MODE;
  else process.env.BOT_BUFFET_SANDBOX_MODE = previousMode;
  if (previousAuth === undefined) delete process.env.BOT_BUFFET_AUTH_MODE;
  else process.env.BOT_BUFFET_AUTH_MODE = previousAuth;
});

describe('sandbox runtime policy', () => {
  it('builds a restricted Docker invocation without requiring a local daemon', () => {
    const args = dockerRunArgs('C:/workspace/project', 'node', ['--version'], 'blocked');
    expect(args).toEqual(
      expect.arrayContaining([
        '--rm',
        '--read-only',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--pids-limit',
        '64',
        '--memory',
        '512m',
        '--workdir',
        '/workspace',
        'node',
        '--version',
      ]),
    );
  });

  it('fails closed instead of using the local process in production', () => {
    process.env.BOT_BUFFET_AUTH_MODE = 'production';
    delete process.env.BOT_BUFFET_SANDBOX_MODE;
    expect(() => createSandboxRuntime('C:/workspace/project')).toThrow('sandbox_runtime_required');
  });

  it('keeps local mode available for development', () => {
    process.env.BOT_BUFFET_AUTH_MODE = 'development';
    process.env.BOT_BUFFET_SANDBOX_MODE = 'local';
    expect(createSandboxRuntime('C:/workspace/project').mode).toBe('local');
  });
});

describe('sandbox image pinning', () => {
  const PINNED = `node@sha256:${'a'.repeat(64)}`;

  it('recognises a digest-pinned reference, with or without a registry', () => {
    expect(isDigestPinned(PINNED)).toBe(true);
    expect(isDigestPinned(`ghcr.io/owner/image@sha256:${'b'.repeat(64)}`)).toBe(true);
    expect(isDigestPinned(`registry.example.com:5000/team/img@sha256:${'c'.repeat(64)}`)).toBe(
      true,
    );
  });

  it('rejects a mutable tag, a bare name, and a malformed digest', () => {
    for (const bad of [
      'node:22-alpine',
      'node',
      'node@sha256:tooshort',
      `node@sha512:${'a'.repeat(64)}`,
      `node@sha256:${'A'.repeat(64)}`,
      '',
    ]) {
      expect(isDigestPinned(bad), `${bad} must not count as pinned`).toBe(false);
    }
  });

  it('allows an unpinned image outside production, where the workspace is disposable', () => {
    expect(resolveSandboxImage(undefined, false)).toBe('node:22-alpine');
    expect(resolveSandboxImage('node:22-alpine', false)).toBe('node:22-alpine');
  });

  it('refuses an unpinned image in production instead of falling back', () => {
    // A sandbox whose contents can change between runs is not a boundary.
    expect(() => resolveSandboxImage('node:22-alpine', true)).toThrow('sandbox_image_not_pinned');
    expect(() => resolveSandboxImage(undefined, true)).toThrow('sandbox_image_required');
    expect(() => resolveSandboxImage('   ', true)).toThrow('sandbox_image_required');
  });

  it('accepts a pinned image in production', () => {
    expect(resolveSandboxImage(PINNED, true)).toBe(PINNED);
    // Surrounding whitespace from an env var must not defeat the check.
    expect(resolveSandboxImage(`  ${PINNED}  `, true)).toBe(PINNED);
  });

  it('puts the resolved image into the docker arguments', () => {
    const args = dockerRunArgs('/workspace', 'node', ['-e', '1'], 'blocked');
    expect(args).toContain('node:22-alpine');
    expect(args).toContain('--network');
    expect(args).toContain('none');
  });
});

describe('network policy is refused identically by both runtimes', () => {
  /**
   * `allowlist` and `open` have no host enforcement anywhere: there is no
   * egress proxy to enforce an allowlist against. The container runtime always
   * refused them; the local runtime ignored the policy, which made a
   * non-blocked policy strictly weaker than `blocked` with nothing
   * compensating. Both refuse now, so a policy cannot mean one thing in
   * development and another in production.
   */
  const previous = process.env.BOT_BUFFET_SANDBOX_MODE;
  afterEach(() => {
    if (previous === undefined) delete process.env.BOT_BUFFET_SANDBOX_MODE;
    else process.env.BOT_BUFFET_SANDBOX_MODE = previous;
  });

  it('refuses a non-blocked policy in the local runtime', async () => {
    process.env.BOT_BUFFET_SANDBOX_MODE = 'local';
    const runtime = createSandboxRuntime(process.cwd());
    expect(runtime.mode).toBe('local');
    for (const network of ['allowlist', 'open'] as const) {
      await expect(runtime.run('node', ['--version'], network)).rejects.toThrow(
        'sandbox_network_policy_unavailable',
      );
    }
  });

  it('refuses a non-blocked policy when building container arguments', () => {
    for (const network of ['allowlist', 'open'] as const) {
      expect(() => dockerRunArgs('/w', 'node', [], network)).toThrow(
        'sandbox_network_policy_unavailable',
      );
    }
  });

  it('still permits the blocked policy in the local runtime', async () => {
    process.env.BOT_BUFFET_SANDBOX_MODE = 'local';
    const runtime = createSandboxRuntime(process.cwd());
    const result = await runtime.run('node', ['--version'], 'blocked');
    expect(result.stdout).toMatch(/^v\d+\./);
  });
});
