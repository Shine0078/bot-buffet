import { execFileSync, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

const MAX_OUTPUT_BYTES = 1_000_000;
export const MAX_FILE_READ_BYTES = 1_000_000;
const MAX_RUNTIME_MS = 30_000;

/**
 * Default sandbox image for development only.
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

/**
 * Variables a child process needs to run at all. Everything else is withheld.
 *
 * The sandbox runtime must never inherit the entire parent environment — that
 * would expose BOT_BUFFET_MASTER_KEY, OIDC configuration, or provider
 * credentials to generated code. `environmentKeys` on the agent profile
 * controls the small explicit set forwarded into the container.
 */
const BASE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec', 'LANG'];
const DOCKER_CLIENT_ENV_KEYS = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
];

/**
 * Build the environment a sandboxed command may see: the minimum needed to
 * execute, plus explicitly allowlisted keys. Never the ambient environment.
 */
export function sandboxEnvironment(
  allowedKeys: string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of allowedKeys) {
    // An agent profile cannot widen the base set by naming a variable that
    // does not exist, and cannot reach anything it did not explicitly list.
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Build the environment for the Docker CLI itself. Runner connection settings
 * are operator configuration for the client process, not agent variables, so
 * they are deliberately kept out of sandboxEnvironment and never passed with
 * `--env` into the untrusted container.
 */
export function dockerClientEnvironment(
  allowedKeys: string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = sandboxEnvironment(allowedKeys, source);
  for (const key of DOCKER_CLIENT_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Agent code always runs in a container; there is no host-process fallback. */
export type SandboxMode = 'docker';
export type SandboxNetwork = 'blocked' | 'allowlist' | 'open';

export type SandboxResult = { stdout: string; stderr: string; code: number };

/** Convert a host-relative path to the POSIX spelling used inside Linux Docker images. */
export function toContainerPath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/');
}

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
    /** Environment variable names this agent profile permits. Anything not
     *  listed is withheld, including from the local runtime. */
    environmentKeys?: string[],
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
  environmentKeys: string[] = [],
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
    // `--env NAME` without a value forwards it from the docker CLI's own
    // environment. Writing `NAME=value` here would put the secret in the
    // process argument list, where any other process on the host can read it.
    ...environmentKeys.flatMap((key) => ['--env', key]),
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
  environmentKeys: string[] = [],
): Promise<SandboxResult> {
  const child = spawn(
    'docker',
    dockerRunArgs(workspaceRoot, command, args, network, input !== undefined, environmentKeys),
    {
      windowsHide: true,
      // The docker CLI itself gets only the allowlisted values, so the
      // forwarded `--env NAME` flags have something to read and nothing else
      // leaks into the container.
      env: dockerClientEnvironment(environmentKeys),
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
        "const fs=require('node:fs');const p=process.argv[1];const max=Number(process.argv[2]);const s=fs.statSync(p);if(!s.isFile()||s.size>max){process.stderr.write('sandbox_read_too_large');process.exit(2)}const fd=fs.openSync(p,'r');const b=Buffer.alloc(s.size);let o=0;while(o<b.length){const n=fs.readSync(fd,b,o,b.length-o, o);if(!n)break;o+=n}fs.closeSync(fd);process.stdout.write(b.subarray(0,o))",
        `/workspace/${toContainerPath(relativePath)}`,
        String(MAX_FILE_READ_BYTES),
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
        `/workspace/${toContainerPath(relativePath)}`,
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
        `/workspace/${toContainerPath(relativePath)}`,
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
    environmentKeys: string[] = [],
  ): Promise<SandboxResult> {
    return runDocker(
      this.workspaceRoot,
      command,
      args,
      network,
      undefined,
      signal,
      environmentKeys,
    );
  }
}

export function createSandboxRuntime(workspaceRoot: string): SandboxRuntime {
  const configured = process.env.BOT_BUFFET_SANDBOX_MODE?.trim().toLowerCase();
  // A host-process fallback cannot provide a reliable boundary on Windows or
  // POSIX: ancestor junctions/symlinks can change between validation and use,
  // and descriptor-relative no-follow traversal is not portable in Node. Make
  // the safe runtime the only runtime instead of retaining a bypass for local
  // development. This also makes an accidental `local` setting fail closed.
  if (configured !== undefined && configured !== 'docker')
    throw new Error('sandbox_runtime_required');
  return new DockerSandbox(workspaceRoot);
}

export function assertSandboxConfiguration(): void {
  createSandboxRuntime(process.env.BOT_BUFFET_DATA_DIR ?? '.data');
  // Fail at startup rather than reporting a healthy control plane whose agent
  // tools can never run. The Docker CLI may target a host daemon, a named pipe,
  // or an explicitly configured runner through DOCKER_HOST; the application
  // does not silently fall back to a host process when none is reachable.
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 5_000,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    throw new Error('sandbox_runner_unavailable');
  }
  // In production, fail at startup rather than at the first agent command: an
  // unpinned image is a configuration error the operator must fix first.
  resolveSandboxImage();
}
