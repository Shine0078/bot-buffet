import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_RUNTIME_MS = 30_000;

/**
 * Default sandbox image for local development only.
 *
 * A tag is a mutable pointer: `node:22-alpine` resolves to different bytes
 * week to week, so the thing agent code executes inside can change without a
 * single line of this repository changing. That is acceptable while developing
 * against a throwaway workspace and is not acceptable in production, where the
 * sandbox is the boundary containing untrusted generated code. Production
 * therefore requires a digest.
 */
const DEFAULT_SANDBOX_IMAGE = 'node:22-alpine';

/**
 * `name@sha256:<64 hex>`. Registry, port, and path segments are permitted
 * before the digest; the digest itself is what makes the reference immutable.
 */
const DIGEST_PINNED = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;

export function isDigestPinned(image: string): boolean {
  return DIGEST_PINNED.test(image);
}

/**
 * Resolve the sandbox image, refusing an unpinned one in production.
 *
 * Fail closed: an unset or tag-only image in production throws rather than
 * silently falling back, because a sandbox whose contents can change is not a
 * boundary anyone can reason about.
 */
export function resolveSandboxImage(
  image: string | undefined = process.env.BOT_BUFFET_SANDBOX_IMAGE,
  production: boolean = process.env.BOT_BUFFET_AUTH_MODE === 'production',
): string {
  const candidate = image && image.trim().length > 0 ? image.trim() : undefined;
  if (!production) return candidate ?? DEFAULT_SANDBOX_IMAGE;
  if (!candidate) throw new Error('sandbox_image_required');
  if (!isDigestPinned(candidate)) throw new Error('sandbox_image_not_pinned');
  return candidate;
}

export type SandboxMode = 'local' | 'docker';
export type SandboxNetwork = 'blocked' | 'allowlist' | 'open';

export type SandboxResult = { stdout: string; stderr: string; code: number };

export interface SandboxRuntime {
  readonly mode: SandboxMode;
  readFile(relativePath: string, signal?: AbortSignal): Promise<string>;
  writeFile(relativePath: string, content: string, signal?: AbortSignal): Promise<void>;
  stat(relativePath: string, signal?: AbortSignal): Promise<{ size: number; isFile: boolean }>;
  run(
    command: string,
    args: string[],
    network: SandboxNetwork,
    signal?: AbortSignal,
  ): Promise<SandboxResult>;
}

export function dockerRunArgs(
  workspaceRoot: string,
  command: string,
  args: string[],
  network: SandboxNetwork,
  /**
   * Whether the container needs to read stdin.
   *
   * `docker run` attaches no stdin unless `--interactive` is passed. Without
   * it a container that reads stdin sees an immediate EOF, so a sandboxed
   * write produced an empty file and still exited 0 — silent data loss that no
   * unit test could see, because the argument list looked correct either way.
   */
  withStdin = false,
): string[] {
  if (network !== 'blocked') throw new Error('sandbox_network_policy_unavailable');
  return [
    'run',
    '--rm',
    '--init',
    ...(withStdin ? ['--interactive'] : []),
    '--read-only',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '64',
    '--cpus',
    '1',
    '--memory',
    '512m',
    '--user',
    '65532:65532',
    '--mount',
    `type=bind,source=${workspaceRoot},target=/workspace`,
    '--workdir',
    '/workspace',
    resolveSandboxImage(),
    command,
    ...args,
  ];
}

async function runDocker(
  workspaceRoot: string,
  command: string,
  args: string[],
  network: SandboxNetwork,
  input: string | undefined,
  signal?: AbortSignal,
): Promise<SandboxResult> {
  const child = spawn(
    'docker',
    dockerRunArgs(workspaceRoot, command, args, network, input !== undefined),
    {
      windowsHide: true,
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let aborted = false;
  const append = (target: Buffer[], chunk: Buffer, current: number): number => {
    if (current < MAX_OUTPUT_BYTES) {
      const remaining = MAX_OUTPUT_BYTES - current;
      target.push(chunk.subarray(0, remaining));
    }
    return current + chunk.length;
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes = append(stdout, Buffer.from(chunk), stdoutBytes);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes = append(stderr, Buffer.from(chunk), stderrBytes);
  });
  const kill = (): void => {
    if (!child.killed) child.kill('SIGKILL');
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, MAX_RUNTIME_MS);
  const abort = (): void => {
    aborted = true;
    kill();
  };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();
  return await new Promise<SandboxResult>((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      reject(new Error(`sandbox_runtime_unavailable:${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      if (timedOut) return reject(new Error('sandbox_timeout'));
      if (aborted) return reject(new Error('sandbox_aborted'));
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? 1,
      });
    });
  });
}

class DockerSandbox implements SandboxRuntime {
  readonly mode = 'docker' as const;
  constructor(private readonly workspaceRoot: string) {}

  async readFile(relativePath: string, signal?: AbortSignal): Promise<string> {
    const result = await runDocker(
      this.workspaceRoot,
      'node',
      [
        '-e',
        "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
        `/workspace/${relativePath}`,
      ],
      'blocked',
      undefined,
      signal,
    );
    if (result.code !== 0) throw new Error(`sandbox_read_failed:${result.stderr.slice(0, 512)}`);
    return result.stdout;
  }

  async writeFile(relativePath: string, content: string, signal?: AbortSignal): Promise<void> {
    const result = await runDocker(
      this.workspaceRoot,
      'node',
      [
        '-e',
        "require('node:fs').mkdirSync(require('node:path').dirname(process.argv[1]), {recursive:true}); process.stdin.pipe(require('node:fs').createWriteStream(process.argv[1]))",
        `/workspace/${relativePath}`,
      ],
      'blocked',
      content,
      signal,
    );
    if (result.code !== 0) throw new Error(`sandbox_write_failed:${result.stderr.slice(0, 512)}`);
  }

  async stat(
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<{ size: number; isFile: boolean }> {
    const result = await runDocker(
      this.workspaceRoot,
      'node',
      [
        '-e',
        "const s=require('node:fs').statSync(process.argv[1]); process.stdout.write(JSON.stringify({size:s.size,isFile:s.isFile()}))",
        `/workspace/${relativePath}`,
      ],
      'blocked',
      undefined,
      signal,
    );
    if (result.code !== 0) throw new Error(`sandbox_stat_failed:${result.stderr.slice(0, 512)}`);
    try {
      return JSON.parse(result.stdout) as { size: number; isFile: boolean };
    } catch {
      throw new Error('sandbox_stat_invalid');
    }
  }

  async run(
    command: string,
    args: string[],
    network: SandboxNetwork,
    signal?: AbortSignal,
  ): Promise<SandboxResult> {
    return runDocker(this.workspaceRoot, command, args, network, undefined, signal);
  }
}

class LocalSandbox implements SandboxRuntime {
  readonly mode = 'local' as const;
  constructor(private readonly workspaceRoot: string) {}

  async readFile(relativePath: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    return readFile(`${this.workspaceRoot}/${relativePath}`, 'utf8');
  }
  async writeFile(relativePath: string, content: string): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const path = `${this.workspaceRoot}/${relativePath}`;
    await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  async stat(relativePath: string): Promise<{ size: number; isFile: boolean }> {
    const { stat } = await import('node:fs/promises');
    const info = await stat(`${this.workspaceRoot}/${relativePath}`);
    return { size: info.size, isFile: info.isFile() };
  }
  async run(command: string, args: string[], network: SandboxNetwork): Promise<SandboxResult> {
    // The container runtime already refuses any policy but `blocked`, because
    // there is no egress proxy to enforce an allowlist against. The local
    // runtime ignored the policy entirely, so `allowlist` and `open` were
    // strictly weaker than `blocked` with nothing compensating: they relaxed
    // the network-shaped command check in the shell tool without introducing
    // any host restriction at all. Both runtimes now refuse identically, so a
    // policy cannot mean one thing in development and another in production,
    // and adding real allowlist support has to be a deliberate change here.
    if (network !== 'blocked') throw new Error('sandbox_network_policy_unavailable');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const result = await promisify(execFile)(command, args, {
      cwd: this.workspaceRoot,
      timeout: MAX_RUNTIME_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  }
}

export function createSandboxRuntime(workspaceRoot: string): SandboxRuntime {
  const mode = (process.env.BOT_BUFFET_SANDBOX_MODE ?? 'local') as SandboxMode;
  if (mode !== 'local' && mode !== 'docker') throw new Error('sandbox_mode_invalid');
  if (process.env.BOT_BUFFET_AUTH_MODE === 'production' && mode !== 'docker')
    throw new Error('sandbox_runtime_required');
  return mode === 'docker' ? new DockerSandbox(workspaceRoot) : new LocalSandbox(workspaceRoot);
}

export function assertSandboxConfiguration(): void {
  if (process.env.BOT_BUFFET_AUTH_MODE !== 'production') return;
  createSandboxRuntime(process.env.BOT_BUFFET_DATA_DIR ?? '.data');
  // Fail at startup rather than at the first agent command: an unpinned image
  // is a configuration error the operator must fix before anything executes.
  resolveSandboxImage();
}
