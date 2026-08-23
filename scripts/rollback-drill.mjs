import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

/**
 * Deployment rollback drill.
 *
 * The specification requires rollback, and `restore:drill` only proves that
 * *data* survives destruction. It says nothing about what happens when a
 * release is bad: whether the failure is detected, whether service can be
 * restored, and whether state written before the bad deploy is still there
 * afterwards. Those are the three questions a rollback has to answer, and
 * nothing exercised them.
 *
 * The failure injected here is a misconfigured production deploy — auth mode
 * set to production with no identity provider configured — because that is a
 * realistic bad release and it exercises the harness's real fail-closed path
 * rather than an artificial crash.
 *
 * Run against Docker: `npm run rollback:drill`. Skips with a clear message if
 * no daemon is reachable, and fails rather than skipping when
 * BOT_BUFFET_REQUIRE_DOCKER_TESTS=1 is set.
 *
 * This is written in Node rather than shell on purpose: `child_process` passes
 * argv directly, so container paths like `/data` are not mangled by MSYS path
 * conversion on Windows.
 */

const run = promisify(execFile);
const REQUIRE_DOCKER = process.env.BOT_BUFFET_REQUIRE_DOCKER_TESTS === '1';
const IMAGE = process.env.ROLLBACK_DRILL_IMAGE ?? 'bot-buffet:rollback-drill';
const CONTAINER = 'bot-buffet-rollback-drill';
const VOLUME = 'bot-buffet-rollback-drill-data';
const PORT = process.env.ROLLBACK_DRILL_PORT ?? '18823';
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = { 'x-bot-buffet-user': 'local-user', 'content-type': 'application/json' };

let failures = 0;
const step = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
};

/**
 * `includeStderr` matters for `docker logs`. A container's stderr is written to
 * the client's stderr, and the startup diagnosis is printed with
 * `console.error` — so reading stdout alone silently misses the very message
 * this drill exists to check.
 */
const docker = async (args, { allowFailure = false, includeStderr = false } = {}) => {
  try {
    const { stdout, stderr } = await run('docker', args, { timeout: 180_000 });
    return (includeStderr ? `${stdout}${stderr}` : stdout).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
};

/** Poll readiness until the deadline. Returns whether it ever became ready. */
async function waitForReady(seconds) {
  for (let attempt = 0; attempt < seconds; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/readyz`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await delay(1000);
  }
  return false;
}

async function cleanup() {
  await docker(['rm', '--force', CONTAINER], { allowFailure: true });
}

async function startGood() {
  await cleanup();
  await docker([
    'run',
    '--detach',
    '--name',
    CONTAINER,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '128',
    '--memory',
    '512m',
    '--mount',
    `type=volume,source=${VOLUME},target=/data`,
    '--publish',
    `${PORT}:8787`,
    IMAGE,
  ]);
}

/**
 * The bad release: production auth with no issuer configured. The harness
 * refuses to start rather than serving unauthenticated, which is the behaviour
 * a rollback drill should be triggered by.
 */
async function startBad() {
  await cleanup();
  await docker([
    'run',
    '--detach',
    '--name',
    CONTAINER,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--env',
    'BOT_BUFFET_AUTH_MODE=production',
    '--mount',
    `type=volume,source=${VOLUME},target=/data`,
    '--publish',
    `${PORT}:8787`,
    IMAGE,
  ]);
}

async function main() {
  try {
    await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 30_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (REQUIRE_DOCKER) {
      console.error(`Docker is required but unreachable: ${message}`);
      process.exitCode = 1;
      return;
    }
    console.log('Docker daemon unreachable; rollback drill skipped.');
    console.log('Set BOT_BUFFET_REQUIRE_DOCKER_TESTS=1 to make this a failure.');
    return;
  }

  try {
    await docker(['volume', 'rm', '--force', VOLUME], { allowFailure: true });
    await docker(['build', '--tag', IMAGE, '.']);
    step(true, 'built the release under test');

    // ---- The good release is serving, and state is written against it.
    await startGood();
    step(await waitForReady(60), 'current release became ready');

    const created = await fetch(`${BASE}/api/v1/projects`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ name: 'Pre-rollback project' }),
    });
    step(created.status === 201, 'state written against the current release');

    const countProjects = async () => {
      const response = await fetch(`${BASE}/api/v1/projects`, { headers: HEADERS });
      const body = await response.json();
      return Array.isArray(body) ? body.length : 0;
    };
    const before = await countProjects();
    step(before > 0, `state present before the bad deploy (${before} project(s))`);

    // ---- Deploy the bad release. It must fail rather than serve.
    await startBad();
    const badBecameReady = await waitForReady(20);
    step(!badBecameReady, 'bad release refused to become ready, so the deploy is detectable');

    const exitCode = await docker(['inspect', CONTAINER, '--format', '{{.State.ExitCode}}']);
    step(exitCode !== '0', `bad release exited non-zero (${exitCode}), failing closed`);

    const logs = await docker(['logs', CONTAINER], { allowFailure: true, includeStderr: true });
    step(
      /Bot Buffet could not start|To fix:|Error code:/.test(logs),
      'failure gives the operator an actionable message, not a stack trace',
    );

    // ---- Roll back to the known-good release.
    await startGood();
    step(await waitForReady(60), 'service restored after rolling back');

    const after = await countProjects();
    step(after === before, `state intact across the failed deploy (${before} -> ${after})`);

    const audit = await (await fetch(`${BASE}/api/v1/audit/verify`, { headers: HEADERS })).json();
    step(audit && audit.valid === true, 'audit chain still verifies after rollback');
  } finally {
    await cleanup();
    await docker(['volume', 'rm', '--force', VOLUME], { allowFailure: true });
  }

  if (failures === 0) {
    console.log('Rollback drill passed.');
  } else {
    console.error(`Rollback drill failed: ${failures} check(s).`);
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
