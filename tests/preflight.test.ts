import { describe, expect, it } from 'vitest';
import {
  evaluateEnvironment,
  formatReport,
  majorOf,
  nodeRemediation,
  parseEngineFloor,
  readEngineFloor,
} from '../scripts/preflight.mjs';
import type { PreflightFacts } from '../scripts/preflight.mjs';

/**
 * The classifier is pure so every branch — including the Windows ones — is
 * reachable from a test on any host. That is the whole reason the decision
 * logic is separated from fact gathering.
 */
const healthy: PreflightFacts = {
  platform: 'linux',
  engineFloor: 20,
  nodeVersion: 'v22.11.0',
  npmVersion: '10.9.0',
  gitVersion: 'git version 2.45.0',
  dockerVersion: 'Docker version 27.0.0',
  dockerDaemonReachable: true,
  dependenciesInstalled: true,
  dataDir: '/srv/bot-buffet/.data',
  dataDirWritable: true,
  playwrightBrowserInstalled: true,
};

describe('preflight version parsing', () => {
  it('reads the Node floor from an engines range', () => {
    expect(parseEngineFloor('>=20')).toBe(20);
    expect(parseEngineFloor('^22.0.0')).toBe(22);
    expect(parseEngineFloor(undefined)).toBeNull();
    expect(parseEngineFloor('lts/*')).toBeNull();
  });

  it('takes the floor from the real package.json, so the two cannot drift', () => {
    expect(readEngineFloor()).toBe(20);
  });

  it('extracts a major version from either version spelling', () => {
    expect(majorOf('v24.14.0')).toBe(24);
    expect(majorOf('20.11.1')).toBe(20);
    expect(majorOf('garbage')).toBeNull();
  });
});

describe('preflight classification', () => {
  it('passes a fully provisioned machine with no warnings', () => {
    const result = evaluateEnvironment(healthy);
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('blocks a Node below the supported floor', () => {
    const result = evaluateEnvironment({ ...healthy, nodeVersion: 'v18.20.0' });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((check) => check.name)).toContain('node');
    expect(result.blockers[0]?.detail).toMatch(/below the supported floor of 20/);
  });

  it('blocks an undeterminable Node version rather than assuming it is fine', () => {
    const result = evaluateEnvironment({ ...healthy, nodeVersion: null });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((check) => check.name)).toContain('node');
  });

  it('blocks missing npm, missing dependencies, and an unwritable data directory', () => {
    const result = evaluateEnvironment({
      ...healthy,
      npmVersion: null,
      dependenciesInstalled: false,
      dataDirWritable: false,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((check) => check.name).sort()).toEqual([
      'data-dir',
      'dependencies',
      'npm',
    ]);
  });

  it('distinguishes an absent Docker from an installed one whose daemon is down', () => {
    // `docker --version` answers from the client alone, so CLI presence is not
    // evidence the sandbox can run. The two states need different actions.
    const absent = evaluateEnvironment({ ...healthy, dockerVersion: null });
    expect(absent.warnings[0]?.detail).toMatch(/not installed/);
    expect(absent.warnings[0]?.remediation).toMatch(/Install Docker/);

    const stopped = evaluateEnvironment({
      ...healthy,
      dockerVersion: 'Docker version 29.5.3',
      dockerDaemonReachable: false,
    });
    expect(stopped.warnings[0]?.detail).toMatch(/daemon is not reachable/);
    expect(stopped.warnings[0]?.remediation).toMatch(/Start the Docker daemon/);
  });

  it('gives the Windows daemon warning its own remediation', () => {
    const result = evaluateEnvironment({
      ...healthy,
      platform: 'win32',
      dockerVersion: 'Docker version 29.5.3',
      dockerDaemonReachable: false,
    });
    expect(result.warnings[0]?.remediation).toMatch(/Start Docker Desktop/);
  });

  it('reports Docker healthy only when the daemon actually answers', () => {
    const result = evaluateEnvironment({ ...healthy, dockerDaemonReachable: true });
    expect(result.warnings).toEqual([]);
    expect(result.checks.find((check) => check.name === 'docker')?.detail).toMatch(
      /daemon reachable/,
    );
  });

  it('treats git, docker, and Chromium as degraded features, never as failures', () => {
    const result = evaluateEnvironment({
      ...healthy,
      gitVersion: null,
      dockerVersion: null,
      playwrightBrowserInstalled: false,
    });
    // The point of the split: an optional tool must not read as a broken install.
    expect(result.ok).toBe(true);
    expect(result.warnings.map((check) => check.name).sort()).toEqual([
      'docker',
      'git',
      'playwright-chromium',
    ]);
  });

  it('gives every blocker and warning an actionable remediation', () => {
    const result = evaluateEnvironment({
      platform: 'linux',
      engineFloor: 20,
      nodeVersion: 'v18.0.0',
      npmVersion: null,
      gitVersion: null,
      dockerVersion: null,
      dependenciesInstalled: false,
      dataDir: '/nope',
      dataDirWritable: false,
      playwrightBrowserInstalled: false,
    });
    for (const check of [...result.blockers, ...result.warnings]) {
      expect(check.remediation, `${check.name} has no remediation`).toBeTruthy();
    }
  });
});

describe('preflight platform-specific remediation', () => {
  it('gives Windows the MSI/winget path and a PATH-refresh reminder', () => {
    const remediation = nodeRemediation('win32');
    expect(remediation).toMatch(/nodejs\.org/);
    expect(remediation).toMatch(/winget/);
    expect(remediation).toMatch(/reopen the terminal/i);
  });

  it('gives macOS and Linux their own paths', () => {
    expect(nodeRemediation('darwin')).toMatch(/brew/);
    expect(nodeRemediation('linux')).toMatch(/distribution package manager/);
  });

  it('reaches the Windows branch of the classifier from any host', () => {
    const result = evaluateEnvironment({ ...healthy, platform: 'win32', gitVersion: null });
    expect(result.warnings[0]?.remediation).toMatch(/git-scm\.com/);
  });
});

describe('preflight report', () => {
  it('marks a passing run and counts its warnings', () => {
    const report = formatReport(evaluateEnvironment({ ...healthy, dockerVersion: null }));
    expect(report).toMatch(/Preflight passed with 1 warning/);
    expect(report).toMatch(/\[!\] docker/);
  });

  it('marks a failing run and prints the remediation beneath the blocker', () => {
    const report = formatReport(evaluateEnvironment({ ...healthy, nodeVersion: 'v16.0.0' }));
    expect(report).toMatch(/Preflight failed: 1 blocker/);
    expect(report).toMatch(/\[x\] node/);
    expect(report).toMatch(/-> Install the current Node\.js LTS/);
  });
});
