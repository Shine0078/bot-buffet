import { afterEach, describe, expect, it } from 'vitest';
import { createSandboxRuntime, dockerRunArgs } from '../src/sandbox.js';

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
