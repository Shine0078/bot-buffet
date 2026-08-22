import { stopServer } from './lib/stop-server.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const port = '8795';
const child = spawn(process.execPath, ['dist/index.js'], {
  env: { ...process.env, PORT: port, BOT_BUFFET_DATA_DIR: '.data-a11y' },
  stdio: 'ignore',
});
await delay(2500);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
await page.evaluate(axeSource);
const violations = await page.evaluate(async () => {
  const results = await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
  });
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.slice(0, 8).map((node) => ({
      target: node.target.join(' '),
      summary: node.failureSummary?.split('\n').slice(0, 3).join(' | '),
    })),
  }));
});
console.log(JSON.stringify(violations, null, 2));
await browser.close();
await stopServer(child);
