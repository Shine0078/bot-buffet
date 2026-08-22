import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = process.env.SMOKE_PORT ?? '8791';
const headers = { 'x-bot-buffet-user': 'local-user', 'content-type': 'application/json' };
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/index.js'], {
  env: { ...process.env, PORT: port, BOT_BUFFET_DATA_DIR: '.data-smoke' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
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
  child.kill();
}
console.log(failures === 0 ? 'Smoke suite passed.' : `Smoke suite failed: ${failures} check(s).`);
process.exit(failures === 0 ? 0 : 1);
