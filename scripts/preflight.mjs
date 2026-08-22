import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * Installation preflight.
 *
 * The decision logic here is deliberately pure and free of any runtime import,
 * so "can this machine actually run Bot Buffet?" is answerable in a unit test
 * without booting the server, and the Windows branch is reachable from a test
 * on any platform. Facts are gathered by a thin impure layer at the bottom.
 *
 * Two rules, both learned from installers that fail badly:
 *
 *   - Classify before acting. Never print or run a command that cannot
 *     succeed on this machine; say precisely what is missing instead.
 *   - Separate blockers from warnings. A missing optional tool degrades a
 *     feature and must not read as a failed installation.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** Parse the major version from an `engines.node` range such as ">=20". */
export function parseEngineFloor(range) {
  const match = /(\d+)/.exec(String(range ?? ''));
  return match ? Number(match[1]) : null;
}

/** The single source of truth for the supported Node floor is package.json. */
export function readEngineFloor(repoRoot = REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  return parseEngineFloor(manifest.engines?.node);
}

/** Major version from a `v24.14.0` / `24.14.0` string. */
export function majorOf(version) {
  const match = /v?(\d+)\./.exec(String(version ?? '').trim());
  return match ? Number(match[1]) : null;
}

/** Platform-specific remediation for a Node that is missing or too old. */
export function nodeRemediation(platform) {
  if (platform === 'win32') {
    return 'Install the current Node.js LTS MSI from https://nodejs.org (or `winget install OpenJS.NodeJS.LTS`), then reopen the terminal so PATH refreshes.';
  }
  if (platform === 'darwin') {
    return 'Install the current Node.js LTS from https://nodejs.org, or `brew install node`.';
  }
  return 'Install the current Node.js LTS from https://nodejs.org or your distribution package manager (nodesource, nvm, asdf).';
}

/** Docker is absent entirely. */
export function dockerRemediation(platform) {
  if (platform === 'win32') {
    return 'Install Docker Desktop to enable BOT_BUFFET_SANDBOX_MODE=docker. Agent file and shell tools fail closed without the container runtime, including for local/offline projects.';
  }
  return 'Install Docker to enable BOT_BUFFET_SANDBOX_MODE=docker. Agent file and shell tools fail closed without the container runtime, including for local/offline projects.';
}

/** Docker is installed but nothing is listening. A different action entirely:
 *  the operator needs to start a service, not install software. */
export function dockerDaemonRemediation(platform) {
  if (platform === 'win32') {
    return 'Start Docker Desktop and wait for the engine to report running, then re-run preflight. The CLI answers `--version` without a daemon, so container operations fail later rather than here.';
  }
  return 'Start the Docker daemon (`sudo systemctl start docker`) and confirm your user is in the `docker` group, then re-run preflight.';
}

/**
 * The pure classifier. `facts` is a plain object so every branch — including
 * the Windows ones — is reachable from a test on any host.
 *
 * @returns {{ok: boolean, blockers: Array, warnings: Array, checks: Array}}
 */
export function evaluateEnvironment(facts) {
  const platform = facts.platform ?? process.platform;
  const floor = facts.engineFloor ?? 20;
  const checks = [];
  const blockers = [];
  const warnings = [];

  const add = (check) => {
    checks.push(check);
    if (check.status === 'blocker') blockers.push(check);
    if (check.status === 'warning') warnings.push(check);
    return check;
  };

  // ---- Node: a hard blocker. package.json `engines` is advisory to npm, so it
  // is enforced here instead of letting the app fail later with a syntax error.
  const nodeMajor = majorOf(facts.nodeVersion);
  if (nodeMajor === null) {
    add({
      name: 'node',
      status: 'blocker',
      detail: 'Could not determine the Node.js version.',
      remediation: nodeRemediation(platform),
    });
  } else if (nodeMajor < floor) {
    add({
      name: 'node',
      status: 'blocker',
      detail: `Node ${facts.nodeVersion} is below the supported floor of ${floor}.`,
      remediation: nodeRemediation(platform),
    });
  } else {
    add({ name: 'node', status: 'ok', detail: `Node ${facts.nodeVersion} (floor ${floor}).` });
  }

  // ---- npm: required to install and to run every gate.
  if (!facts.npmVersion) {
    add({
      name: 'npm',
      status: 'blocker',
      detail: 'npm was not found on PATH.',
      remediation: nodeRemediation(platform),
    });
  } else {
    add({ name: 'npm', status: 'ok', detail: `npm ${facts.npmVersion}.` });
  }

  // ---- Dependencies installed: `npm ci` has to have run at least once.
  if (facts.dependenciesInstalled === false) {
    add({
      name: 'dependencies',
      status: 'blocker',
      detail: 'node_modules is missing, so no gate can run.',
      remediation: 'Run `npm ci` from the repository root.',
    });
  } else if (facts.dependenciesInstalled === true) {
    add({ name: 'dependencies', status: 'ok', detail: 'node_modules is present.' });
  }

  // ---- Writable data directory: the store writes state atomically and refuses
  // to start without it, so surface it here rather than at first request.
  if (facts.dataDirWritable === false) {
    add({
      name: 'data-dir',
      status: 'blocker',
      detail: `Data directory is not writable: ${facts.dataDir ?? '(unset)'}.`,
      remediation:
        'Point BOT_BUFFET_DATA_DIR at a writable path, or grant write access to the default .data directory.',
    });
  } else if (facts.dataDirWritable === true) {
    add({ name: 'data-dir', status: 'ok', detail: `Writable: ${facts.dataDir}.` });
  }

  // ---- git: optional. The brand gate, provenance, and worktree checkpoints
  // need it, but the server itself runs fine without it.
  if (!facts.gitVersion) {
    add({
      name: 'git',
      status: 'warning',
      detail: 'git was not found; the brand gate, provenance, and Git checkpoints are unavailable.',
      remediation:
        platform === 'win32'
          ? 'Install Git for Windows from https://git-scm.com.'
          : 'Install git from your package manager.',
    });
  } else {
    add({ name: 'git', status: 'ok', detail: facts.gitVersion });
  }

  // ---- Docker: optional locally, required for the production sandbox mode.
  // The CLI being on PATH proves nothing: `docker --version` answers from the
  // client alone, so a machine with Docker Desktop installed but not running
  // reports a version and then fails every actual container operation. The
  // daemon is what the sandbox needs, so the daemon is what is checked, and the
  // two failure modes get different remediation because they need different
  // actions from the operator.
  if (!facts.dockerVersion) {
    add({
      name: 'docker',
      status: 'warning',
      detail: 'Docker is not installed; container sandbox mode cannot be exercised here.',
      remediation: dockerRemediation(platform),
    });
  } else if (facts.dockerDaemonReachable === false) {
    add({
      name: 'docker',
      status: 'warning',
      detail: `${facts.dockerVersion} is installed but the daemon is not reachable.`,
      remediation: dockerDaemonRemediation(platform),
    });
  } else {
    add({ name: 'docker', status: 'ok', detail: `${facts.dockerVersion} (daemon reachable).` });
  }

  // ---- Playwright browser: optional; only the browser/a11y suite needs it.
  if (facts.playwrightBrowserInstalled === false) {
    add({
      name: 'playwright-chromium',
      status: 'warning',
      detail: 'Chromium is not installed for Playwright; the browser and axe suites will skip.',
      remediation: 'Run `npx playwright install --with-deps chromium`.',
    });
  } else if (facts.playwrightBrowserInstalled === true) {
    add({ name: 'playwright-chromium', status: 'ok', detail: 'Chromium is installed.' });
  }

  return { ok: blockers.length === 0, blockers, warnings, checks };
}

export function formatReport(result) {
  const symbol = { ok: '[ok]', warning: '[!]', blocker: '[x]' };
  const lines = ['Bot Buffet preflight', ''];
  for (const check of result.checks) {
    lines.push(`${symbol[check.status]} ${check.name}: ${check.detail}`);
    if (check.remediation) lines.push(`      -> ${check.remediation}`);
  }
  lines.push('');
  lines.push(
    result.ok
      ? `Preflight passed with ${result.warnings.length} warning(s). Optional features listed above are degraded, not broken.`
      : `Preflight failed: ${result.blockers.length} blocker(s) must be resolved before Bot Buffet can run.`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Impure fact gathering. Every probe is bounded so a hung tool cannot stall the
// check, and every failure degrades to "absent" rather than throwing.
// ---------------------------------------------------------------------------

/**
 * Run a fixed version probe and return its first output line, or null.
 *
 * `shell` matters on Windows. npm is installed as `npm.cmd`, a batch shim, and
 * since the CVE-2024-27980 fix Node refuses to hand a `.cmd`/`.bat` to
 * CreateProcess without a shell — so `execFileSync('npm.cmd', …)` fails with
 * EINVAL on a machine where npm is plainly installed and working. A shell is
 * therefore required for shim commands, and is safe *here specifically*
 * because both `command` and `args` are compile-time constants in this file:
 * nothing user-derived ever reaches the command line. Do not generalise this
 * helper to caller-supplied strings without escaping them first.
 */
function probe(command, args, { shim = false } = {}) {
  const needsShell = shim && process.platform === 'win32';
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: needsShell,
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

function dataDirWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probeFile = join(dir, `.preflight-${process.pid}`);
    writeFileSync(probeFile, 'ok');
    rmSync(probeFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

function exists(path) {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function gatherFacts(repoRoot = REPO_ROOT, platform = process.platform) {
  const dataDir = process.env.BOT_BUFFET_DATA_DIR
    ? resolve(process.env.BOT_BUFFET_DATA_DIR)
    : join(repoRoot, '.data');
  // npm is a shim on Windows (npm.cmd); resolve it the way the platform does.
  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm';
  return {
    platform,
    engineFloor: readEngineFloor(repoRoot),
    nodeVersion: process.version,
    npmVersion: probe(npmCommand, ['--version'], { shim: true }),
    gitVersion: probe('git', ['--version']),
    dockerVersion: probe('docker', ['--version']),
    // `docker info` is the cheapest call that the daemon, not the client alone,
    // has to answer — which is the distinction the sandbox actually depends on.
    dockerDaemonReachable: probe('docker', ['info', '--format', '{{.ServerVersion}}']) !== null,
    dependenciesInstalled: exists(join(repoRoot, 'node_modules')),
    dataDir,
    dataDirWritable: dataDirWritable(dataDir),
    playwrightBrowserInstalled: playwrightChromiumInstalled(repoRoot),
  };
}

function playwrightChromiumInstalled(repoRoot) {
  // Resolved against the repository rather than this file so the probe still
  // works if the script is invoked from elsewhere, and wrapped so a machine
  // with no dependencies installed gets a useful report instead of a crash.
  try {
    const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
    const { chromium } = requireFromRepo('playwright');
    const path = chromium.executablePath();
    return typeof path === 'string' && exists(path);
  } catch {
    return false;
  }
}

export function main() {
  const result = evaluateEnvironment(gatherFacts());
  const report = formatReport(result);
  if (result.ok) console.log(report);
  else console.error(report);
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('preflight.mjs');
if (invokedDirectly) main();
