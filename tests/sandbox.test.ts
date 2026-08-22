import { afterEach, describe, expect, it } from 'vitest';
import {
  createSandboxRuntime,
  dockerClientEnvironment,
  dockerRunArgs,
  isDigestPinned,
  resolveSandboxImage,
  sandboxEnvironment,
  toContainerPath,
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

  it('normalizes Windows host separators for Linux container paths', () => {
    expect(toContainerPath('nested\\created.txt')).toBe('nested/created.txt');
    expect(toContainerPath('src\\lib\\index.ts')).toBe('src/lib/index.ts');
  });

  it('selects Docker by default, without requiring a daemon during construction', () => {
    delete process.env.BOT_BUFFET_AUTH_MODE;
    delete process.env.BOT_BUFFET_SANDBOX_MODE;
    expect(createSandboxRuntime('C:/workspace/project').mode).toBe('docker');
  });

  it('selects Docker in production', () => {
    process.env.BOT_BUFFET_AUTH_MODE = 'production';
    delete process.env.BOT_BUFFET_SANDBOX_MODE;
    expect(createSandboxRuntime('C:/workspace/project').mode).toBe('docker');
  });

  it('rejects the removed host-process fallback in every environment', () => {
    process.env.BOT_BUFFET_AUTH_MODE = 'development';
    process.env.BOT_BUFFET_SANDBOX_MODE = 'local';
    expect(() => createSandboxRuntime('C:/workspace/project')).toThrow('sandbox_runtime_required');
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

describe('network policy is refused until an egress proxy exists', () => {
  it('refuses a non-blocked policy when building container arguments', () => {
    for (const network of ['allowlist', 'open'] as const) {
      expect(() => dockerRunArgs('/w', 'node', [], network)).toThrow(
        'sandbox_network_policy_unavailable',
      );
    }
  });

  it('constructs the Docker runtime for the blocked policy', () => {
    delete process.env.BOT_BUFFET_SANDBOX_MODE;
    expect(createSandboxRuntime(process.cwd()).mode).toBe('docker');
  });
});

describe('sandbox environment is explicit, never inherited', () => {
  /**
   * A sandboxed command must never inherit the master key, OIDC configuration,
   * or provider credentials exported into the shell. `environmentKeys` on the
   * agent profile controls exactly what the container may receive.
   */
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/agent',
    BOT_BUFFET_MASTER_KEY: 'super-secret',
    OPENAI_API_KEY: 'sk-secret',
    BUILD_CHANNEL: 'nightly',
  };

  it('passes through only the variables needed to execute', () => {
    const env = sandboxEnvironment([], source);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/agent');
  });

  it('withholds every secret that was not explicitly allowed', () => {
    const env = sandboxEnvironment([], source);
    expect(env.BOT_BUFFET_MASTER_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.BUILD_CHANNEL).toBeUndefined();
  });

  it('includes a variable the profile explicitly allows, and nothing more', () => {
    const env = sandboxEnvironment(['BUILD_CHANNEL'], source);
    expect(env.BUILD_CHANNEL).toBe('nightly');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.BOT_BUFFET_MASTER_KEY).toBeUndefined();
  });

  it('cannot invent a variable that does not exist on the host', () => {
    const env = sandboxEnvironment(['NOT_SET_ANYWHERE'], source);
    expect('NOT_SET_ANYWHERE' in env).toBe(false);
  });

  it('never returns the ambient environment object itself', () => {
    const env = sandboxEnvironment([], source);
    expect(env).not.toBe(source);
    expect(Object.keys(env).length).toBeLessThan(Object.keys(source).length);
  });

  it('keeps runner connection settings on the Docker client, not in the container', () => {
    const env = dockerClientEnvironment([], {
      ...source,
      DOCKER_HOST: 'npipe:////./pipe/docker_engine',
      DOCKER_CERT_PATH: 'C:/operator/docker-certs',
    });
    expect(env.DOCKER_HOST).toBe('npipe:////./pipe/docker_engine');
    expect(env.DOCKER_CERT_PATH).toBe('C:/operator/docker-certs');
    expect(sandboxEnvironment([], env).DOCKER_HOST).toBeUndefined();
    expect(sandboxEnvironment([], env).DOCKER_CERT_PATH).toBeUndefined();
  });

  it('forwards allowed variables to the container by name, not by value', () => {
    // `--env NAME=value` would put the secret in the process argument list,
    // where any other process on the host can read it.
    const args = dockerRunArgs('/w', 'node', [], 'blocked', false, ['BUILD_CHANNEL']);
    expect(args).toContain('--env');
    expect(args).toContain('BUILD_CHANNEL');
    // The mount argument legitimately contains '=', so assert the precise
    // claim: no argument carries the variable's value.
    expect(args.some((arg) => arg.startsWith('BUILD_CHANNEL='))).toBe(false);
    expect(args.join(' ')).not.toContain('nightly');
  });

  it('adds no env flags when the profile allows nothing', () => {
    const args = dockerRunArgs('/w', 'node', [], 'blocked');
    expect(args).not.toContain('--env');
  });
});
