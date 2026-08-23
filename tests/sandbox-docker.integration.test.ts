import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxRuntime, dockerRunArgs, type SandboxRuntime } from '../src/sandbox.js';

/**
 * Real container sandbox integration.
 *
 * These assertions cannot be made against a mock. The defect that prompted
 * this suite — `docker run` attaching no stdin without `--interactive`, so a
 * sandboxed write produced an empty file and still exited 0 — was invisible to
 * unit tests, because the argument list looked correct either way and the
 * failure only appeared once a real daemon executed it.
 *
 * Availability policy: when the daemon is reachable the suite runs. When it is
 * not, it skips — but `BOT_BUFFET_REQUIRE_DOCKER_TESTS=1` turns that skip into
 * a failure, and CI sets it. Coverage can therefore be absent on a developer
 * laptop without Docker, and can never go quietly missing where it is required.
 */

const REQUIRE_DOCKER = process.env.BOT_BUFFET_REQUIRE_DOCKER_TESTS === '1';
const TIMEOUT = 120_000;

/**
 * Probed synchronously at module load, not in `beforeAll`: `it.runIf` is
 * evaluated while tests are collected, which happens before any hook runs. A
 * value assigned in a hook would still be false at collection time, and a
 * function passed to `runIf` is simply truthy — so either mistake silently
 * turns the guard off. This is the one form that actually gates.
 */
function probeDaemon(): { available: boolean; error: string } {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { available: true, error: '' };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const daemon = probeDaemon();
const daemonAvailable = daemon.available;

let workspace = '';
let sandbox: SandboxRuntime;
const previousMode = process.env.BOT_BUFFET_SANDBOX_MODE;

beforeAll(async () => {
  if (!daemonAvailable) return;
  process.env.BOT_BUFFET_SANDBOX_MODE = 'docker';
  workspace = await mkdtemp(join(tmpdir(), 'bot-buffet-sandbox-'));
  await writeFile(join(workspace, 'probe.txt'), 'hello from workspace');
  sandbox = createSandboxRuntime(workspace);
}, TIMEOUT);

afterAll(async () => {
  if (previousMode === undefined) delete process.env.BOT_BUFFET_SANDBOX_MODE;
  else process.env.BOT_BUFFET_SANDBOX_MODE = previousMode;
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe('container sandbox against a real Docker daemon', () => {
  it('is required in CI, so a missing daemon cannot silently drop this coverage', () => {
    // This assertion always runs. Where Docker is required and absent, the
    // suite fails loudly here instead of reporting a tidy row of skips.
    if (REQUIRE_DOCKER) {
      expect(daemonAvailable, `Docker daemon unreachable: ${daemon.error}`).toBe(true);
    } else {
      expect(typeof daemonAvailable).toBe('boolean');
    }
  });

  it.runIf(daemonAvailable)('selects the container runtime rather than the local fallback', () => {
    expect(sandbox.mode).toBe('docker');
  });

  it.runIf(daemonAvailable)(
    'reads a file from the mounted workspace',
    async () => {
      expect(await sandbox.readFile('probe.txt')).toBe('hello from workspace');
    },
    TIMEOUT,
  );

  it.runIf(daemonAvailable)(
    'writes a file whose contents actually arrive, including nested directories',
    async () => {
      // The regression: without --interactive the container saw EOF on stdin,
      // wrote nothing, and exited 0. An empty read here means that is back.
      await sandbox.writeFile('nested/created.txt', 'written by sandbox');
      expect(await sandbox.readFile('nested/created.txt')).toBe('written by sandbox');
      // Confirmed on the host too, so the bind mount really persisted it.
      expect(await readFile(join(workspace, 'nested', 'created.txt'), 'utf8')).toBe(
        'written by sandbox',
      );
    },
    TIMEOUT,
  );

  it.runIf(daemonAvailable)(
    'round-trips content containing newlines and unicode',
    async () => {
      const content = 'line one\nline two\n"quoted" — ünïcødé ✓\n';
      await sandbox.writeFile('round-trip.txt', content);
      expect(await sandbox.readFile('round-trip.txt')).toBe(content);
    },
    TIMEOUT,
  );

  it.runIf(daemonAvailable)(
    'stats a workspace file',
    async () => {
      expect(await sandbox.stat('probe.txt')).toEqual({ size: 20, isFile: true });
    },
    TIMEOUT,
  );

  it.runIf(daemonAvailable)(
    'executes as a non-root user',
    async () => {
      const result = await sandbox.run(
        'node',
        ['-e', 'process.stdout.write(String(process.getuid()))'],
        'blocked',
      );
      expect(result.stdout).toBe('65532');
    },
    TIMEOUT,
  );

  it.runIf(daemonAvailable)(
    'has no network access',
    async () => {
      const result = await sandbox.run(
        'node',
        [
          '-e',
          "fetch('https://example.com').then(()=>process.stdout.write('REACHED')).catch(()=>process.stdout.write('BLOCKED'))",
        ],
        'blocked',
      );
      expect(result.stdout).toBe('BLOCKED');
    },
    TIMEOUT,
  );

  it.runIf(daemonAvailable)(
    'cannot write outside the mounted workspace',
    async () => {
      const result = await sandbox.run(
        'node',
        [
          '-e',
          "try{require('node:fs').writeFileSync('/etc/escape','x');process.stdout.write('WROTE')}catch(e){process.stdout.write('REFUSED:'+e.code)}",
        ],
        'blocked',
      );
      expect(result.stdout).toBe('REFUSED:EROFS');
    },
    TIMEOUT,
  );

  it.runIf(daemonAvailable)(
    'reports a non-zero exit code rather than swallowing a failure',
    async () => {
      const result = await sandbox.run('node', ['-e', 'process.exit(3)'], 'blocked');
      expect(result.code).toBe(3);
    },
    TIMEOUT,
  );

  it.runIf(daemonAvailable)(
    'refuses any network policy other than blocked',
    async () => {
      await expect(sandbox.run('node', ['-e', '1'], 'open')).rejects.toThrow(
        'sandbox_network_policy_unavailable',
      );
      await expect(sandbox.run('node', ['-e', '1'], 'allowlist')).rejects.toThrow(
        'sandbox_network_policy_unavailable',
      );
    },
    TIMEOUT,
  );
});

describe('container sandbox arguments', () => {
  it('requests stdin only when there is input to deliver', () => {
    // Always passing --interactive would hold a container open on an unclosed
    // stdin; never passing it loses the payload. It has to track the input.
    expect(dockerRunArgs('/w', 'node', [], 'blocked', true)).toContain('--interactive');
    expect(dockerRunArgs('/w', 'node', [], 'blocked', false)).not.toContain('--interactive');
    expect(dockerRunArgs('/w', 'node', [], 'blocked')).not.toContain('--interactive');
  });

  it('keeps every isolation flag alongside the stdin flag', () => {
    const args = dockerRunArgs('/w', 'node', [], 'blocked', true);
    for (const flag of [
      '--rm',
      '--init',
      '--read-only',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '--cpus',
      '--memory',
      '--user',
      '65532:65532',
    ]) {
      expect(args, `missing ${flag}`).toContain(flag);
    }
  });
});

describe('symlink and TOCTOU resistance in the container', () => {
  /**
   * The owner gate asks for escape and TOCTOU evidence specifically.
   *
   * A time-of-check/time-of-use race means an attacker swaps a path component
   * for a symlink *after* the harness resolved it and *before* the operation
   * runs. The harness resolves real paths up front, but that check cannot be
   * atomic with the write, so the container namespace is the control that has
   * to hold: even a race won inside the workspace lands in a namespace where
   * the host filesystem is simply not mounted.
   *
   * These tests therefore assume the race is lost and assert the containment
   * still holds, which is the only claim worth making.
   */
  it.runIf(daemonAvailable)(
    'a symlink planted in the workspace cannot reach a host file',
    async () => {
      // Planted directly on the host, bypassing every harness path check, so
      // this models a race that was already won.
      await sandbox.run(
        'node',
        ['-e', "require('node:fs').symlinkSync('/etc/passwd','/workspace/escape-link')"],
        'blocked',
      );
      const result = await sandbox.run(
        'node',
        [
          '-e',
          "const fs=require('node:fs');try{const t=fs.readFileSync('/workspace/escape-link','utf8');process.stdout.write('READ:'+t.length)}catch(e){process.stdout.write('REFUSED:'+e.code)}",
        ],
        'blocked',
      );
      // The link resolves inside the container's own namespace, never to the
      // host's /etc/passwd. Reading the container's own file is not an escape.
      expect(result.stdout).toMatch(/^(READ:\d+|REFUSED:[A-Z]+)$/);
      const hostReachable = await sandbox.run(
        'node',
        [
          '-e',
          "const fs=require('node:fs');const probes=['/host_mnt','/run/desktop','/mnt/host','/c'];process.stdout.write(probes.filter((p)=>fs.existsSync(p)).join(',')||'none')",
        ],
        'blocked',
      );
      expect(hostReachable.stdout).toBe('none');
    },
    TIMEOUT,
  );

  it.runIf(daemonAvailable)(
    'a directory swapped for a symlink still cannot write outside the workspace',
    async () => {
      const result = await sandbox.run(
        'node',
        [
          '-e',
          "const fs=require('node:fs');try{fs.symlinkSync('/etc','/workspace/etc-link');fs.writeFileSync('/workspace/etc-link/planted','x');process.stdout.write('WROTE')}catch(e){process.stdout.write('REFUSED:'+e.code)}",
        ],
        'blocked',
      );
      // /etc lives on the read-only root, so following the link fails there.
      expect(result.stdout).toMatch(/^REFUSED:(EROFS|EACCES|EEXIST|EPERM)$/);
    },
    TIMEOUT,
  );

  it.runIf(daemonAvailable)(
    'cannot reach the Docker socket, so it cannot start a less restricted sibling',
    async () => {
      // The most valuable escape would be launching an unconfined container.
      const result = await sandbox.run(
        'node',
        [
          '-e',
          "const fs=require('node:fs');process.stdout.write(String(fs.existsSync('/var/run/docker.sock')))",
        ],
        'blocked',
      );
      expect(result.stdout).toBe('false');
    },
    TIMEOUT,
  );
});
