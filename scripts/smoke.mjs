import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { stopServer } from './lib/stop-server.mjs';

const port = process.env.SMOKE_PORT ?? '8791';
const headers = { 'x-bot-buffet-user': 'local-user', 'content-type': 'application/json' };
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/index.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    BOT_BUFFET_AUTH_MODE: 'development',
    BOT_BUFFET_HOST: '127.0.0.1',
    PORT: port,
    BOT_BUFFET_DATA_DIR: '.data-smoke',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// The child's output must be consumed. A piped stream with no reader fills its
// buffer and blocks the writer, so a server that logs enough would hang here
// rather than fail. Keep the tail so a failure can be explained.
const serverLog = [];
const record = (chunk) => {
  serverLog.push(String(chunk));
  if (serverLog.length > 200) serverLog.shift();
};
child.stdout.on('data', record);
child.stderr.on('data', record);

let failures = 0;
const check = async (label, path, options = {}) => {
  const response = await fetch(base + path, { headers, ...options });
  const body = await response.text();
  const ok = response.status === (options.expect ?? 200);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} -> ${response.status} ${body.slice(0, 160)}`);
  return body;
};
try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const probe = await fetch(base + '/readyz');
      if (probe.ok) break;
    } catch {
      /* server still starting */
    }
    await delay(300);
  }
  await check('readyz', '/readyz');
  await check('healthz', '/healthz');
  await check('bootstrap', '/api/v1/bootstrap');
  await check('usage', '/api/v1/usage?groupBy=agent&period=monthly');
  await check('alerts', '/api/v1/alerts');
  await check('workflows', '/api/v1/workflows');
  await check('budgets', '/api/v1/budgets');
  await check('usage rejects bad grouping', '/api/v1/usage?groupBy=nope', { expect: 400 });
  const project = JSON.parse(
    await check('create project', '/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Smoke project' }),
      expect: 201,
    }),
  );
  const workflow = JSON.parse(
    await check('create workflow', '/api/v1/workflows', {
      method: 'POST',
      expect: 201,
      body: JSON.stringify({
        projectId: project.id,
        name: 'Smoke flow',
        nodes: [
          { id: 'a', kind: 'task', config: {} },
          { id: 'b', kind: 'task', config: {} },
        ],
        edges: [{ from: 'a', to: 'b' }],
      }),
    }),
  );
  await check('workflow plan', `/api/v1/workflows/${workflow.id}/plan`);
  await check('metrics', '/metrics');
  await check('trace rejects unknown run', '/api/v1/runs/missing-run/trace', { expect: 400 });
  await check('create budget', '/api/v1/budgets', {
    method: 'POST',
    expect: 201,
    body: JSON.stringify({
      projectId: project.id,
      name: 'Smoke cap',
      period: 'daily',
      limitCents: 1000,
    }),
  });
  await check('reject cyclic workflow', '/api/v1/workflows', {
    method: 'POST',
    expect: 400,
    body: JSON.stringify({
      projectId: project.id,
      name: 'Cycle',
      nodes: [
        { id: 'a', kind: 'task', config: {} },
        { id: 'b', kind: 'task', config: {} },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    }),
  });
} finally {
  await stopServer(child);
}
if (failures === 0) {
  console.log('Smoke suite passed.');
} else {
  console.error(`Smoke suite failed: ${failures} check(s).`);
  console.error('--- server output ---');
  console.error(serverLog.join(''));
}
// Set the code rather than calling process.exit, so Node closes its handles
// normally instead of tearing down mid-teardown.
process.exitCode = failures === 0 ? 0 : 1;
