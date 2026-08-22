/**
 * End-to-end restore drill. Creates real control-plane state through the HTTP API, takes a
 * backup, destroys the live data directory, restores from the backup, restarts the server, and
 * proves the state and the tamper-evident audit chain survived. Exits non-zero on any failure.
 */
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);
const headers = { 'x-bot-buffet-user': 'local-user', 'content-type': 'application/json' };
const port = process.env.DRILL_PORT ?? '8796';
const base = `http://127.0.0.1:${port}`;
const backupKey = process.env.BOT_BUFFET_BACKUP_KEY ?? 'd'.repeat(32);
let failures = 0;

const step = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` -> ${detail}` : ''}`);
};

const startServer = async (dataDir) => {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, PORT: port, BOT_BUFFET_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${base}/readyz`)).ok) return child;
    } catch {
      /* still starting */
    }
    await delay(250);
  }
  child.kill();
  throw new Error('server_did_not_become_ready');
};

const root = await mkdtemp(join(tmpdir(), 'bot-buffet-drill-'));
const dataDir = join(root, 'data');
const backupDir = join(root, 'backup');
let child;
try {
  child = await startServer(dataDir);

  const project = await (
    await fetch(`${base}/api/v1/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Restore drill project' }),
    })
  ).json();
  await fetch(`${base}/api/v1/artifacts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      projectId: project.id,
      name: 'drill.md',
      content: 'evidence recorded before backup',
    }),
  });
  const beforeAudit = await (await fetch(`${base}/api/v1/audit/verify`, { headers })).json();
  step(beforeAudit.valid === true, 'audit chain valid before backup');

  child.kill();
  await delay(500);

  await execFileAsync(process.execPath, ['scripts/backup.mjs', backupDir], {
    env: { ...process.env, BOT_BUFFET_DATA_DIR: dataDir, BOT_BUFFET_BACKUP_KEY: backupKey },
  });
  const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
  step(manifest.files.length > 0, 'backup manifest written', `${manifest.files.length} file(s)`);

  // Destroy the live data directory to prove the restore is doing the work.
  await rm(dataDir, { recursive: true, force: true });
  step(true, 'live data directory destroyed');

  await execFileAsync(process.execPath, ['scripts/restore.mjs', backupDir], {
    env: { ...process.env, BOT_BUFFET_DATA_DIR: dataDir, BOT_BUFFET_BACKUP_KEY: backupKey },
  });
  step(true, 'restore completed');

  child = await startServer(dataDir);
  const projects = await (await fetch(`${base}/api/v1/projects`, { headers })).json();
  step(
    projects.some((item) => item.id === project.id),
    'project survived destroy and restore',
  );
  const artifacts = await (
    await fetch(`${base}/api/v1/artifacts?projectId=${project.id}`, { headers })
  ).json();
  step(artifacts.length === 1 && artifacts[0].name === 'drill.md', 'artifact survived restore');
  const afterAudit = await (await fetch(`${base}/api/v1/audit/verify`, { headers })).json();
  step(afterAudit.valid === true, 'audit chain still verifies after restore');
} catch (error) {
  failures += 1;
  console.log(`FAIL drill error -> ${error.message}`);
} finally {
  child?.kill();
  await rm(root, { recursive: true, force: true });
}
console.log(failures === 0 ? 'Restore drill passed.' : `Restore drill failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
