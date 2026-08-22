import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import { CredentialVault } from '../src/secrets.js';
import { createApi } from '../src/api.js';
import { createStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

let browser: Browser;
let server: { close: () => void };
let base: string;

const startServer = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-browser-'));
  const store = createStore(dir);
  let runCount = 0;
  const orchestrator = Object.assign(new EventEmitter(), {
    createRun: async (input: {
      project: { id: string };
      agent: { id: string };
      task: { id: string };
    }) => {
      runCount += 1;
      const run = {
        id: 'run_office_' + runCount,
        kind: 'run',
        ownerId: 'local-user',
        scope: input.project.id,
        projectId: input.project.id,
        environmentId: input.project.id,
        agentId: input.agent.id,
        taskId: input.task.id,
        status: 'queued',
        mode: 'chat',
        stepCount: 0,
        maxSteps: 8,
        costCents: 0,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        cancelRequested: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      };
      await store.insert(run as never);
      return run;
    },
    start: async () => undefined,
    command: async (input: { runId: string; type: string }) => {
      const run = await store.get(input.runId);
      if (!run) return undefined;
      const status =
        input.type === 'pause' ? 'paused' : input.type === 'resume' ? 'queued' : 'cancelled';
      return store.put({ ...run, status, version: run.version } as never);
    },
  }) as unknown as Orchestrator;
  const api = createApi({
    store,
    orchestrator,
    uiRoot: resolve(process.cwd(), 'ui'),
    vault: new CredentialVault(join(dir, 'credentials.enc.json'), 'test'),
  });
  return await new Promise((resolve) => {
    const listener = api.listen(0, '127.0.0.1', () => {
      server = listener;
      const address = listener.address();
      resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
    });
  });
};

/**
 * Run axe-core in the page and return violations that block the accessibility gate. The source
 * is evaluated over CDP rather than injected as a <script> tag so the application's real
 * Content-Security-Policy stays enforced while the audit runs.
 */
const auditAccessibility = async (page: Page): Promise<Array<{ id: string; impact?: string }>> => {
  await page.evaluate(axeSource);
  return (await page.evaluate(async () => {
    const results = await (
      window as unknown as {
        axe: { run: (context: unknown, options: unknown) => Promise<{ violations: unknown[] }> };
      }
    ).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
    return results.violations.map((violation) => {
      const typed = violation as { id: string; impact?: string };
      return { id: typed.id, impact: typed.impact };
    });
  })) as Array<{ id: string; impact?: string }>;
};

beforeAll(async () => {
  base = await startServer();
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe('Office UI in a real browser', () => {
  it('loads the office floor without console or page errors', async () => {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    await expect(page.locator('#officeView')).toBeTruthy();
    expect(await page.locator('h1').first().isVisible()).toBe(true);
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);

  it('switches to the accessible table alternative and renders new views', async () => {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    for (const view of ['budgets', 'workflows', 'alerts', 'usage']) {
      await page.click(`.nav-item[data-view="${view}"]`);
      await page.waitForSelector('#tableView:not(.hidden)');
      expect(await page.locator('#tableView').isVisible()).toBe(true);
      expect(await page.locator('#tableHead').innerText()).not.toBe('');
    }
    await page.click('.nav-item[data-view="office"]');
    await page.waitForSelector('#officeView:not(.hidden)');
    expect(await page.locator('#officeView').isVisible()).toBe(true);
    await page.close();
  }, 60_000);

  it('is keyboard navigable and exposes a visible focus indicator', async () => {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.tagName ?? '');
    expect(focused).not.toBe('BODY');
    const outline = await page.evaluate(() => {
      const element = document.querySelector('.nav-item') as HTMLElement | null;
      element?.focus();
      if (!element) return '';
      const style = getComputedStyle(element);
      return `${style.outlineStyle}|${style.outlineWidth}|${style.boxShadow}`;
    });
    expect(outline).not.toBe('none|0px|none');
    await page.close();
  }, 60_000);

  it('has no serious or critical axe violations on the office floor or table view', async () => {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    const officeViolations = (await auditAccessibility(page)).filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    );
    expect(officeViolations.map((violation) => violation.id)).toEqual([]);

    await page.click('.nav-item[data-view="runs"]');
    await page.waitForSelector('#tableView:not(.hidden)');
    const tableViolations = (await auditAccessibility(page)).filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    );
    expect(tableViolations.map((violation) => violation.id)).toEqual([]);
    await page.close();
  }, 120_000);

  it('renders a usable mobile layout without horizontal overflow', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(base, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await page.close();
  }, 60_000);
  it('creates a project and switches views from the primary action buttons', async () => {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    page.once('dialog', (dialog) => dialog.accept('Office Alpha'));
    await page.click('#newProject');
    await page.waitForFunction(() => {
      const select = document.querySelector('#projectSelect');
      return Boolean(select && /Office Alpha/.test(select.textContent ?? ''));
    });
    await page.click('#viewAllRuns');
    await page.waitForSelector('#tableView:not(.hidden)');
    expect(await page.locator('#viewTitle').innerText()).toBe('Runs');
    await page.click('.nav-item[data-view="tasks"]');
    await page.waitForSelector('#tableView:not(.hidden)');
    page.once('dialog', (dialog) => dialog.accept('Ship the office floor'));
    await page.click('#tableAction');
    await page.waitForFunction(() => /Ship the office floor/.test(document.body.innerText));
    await page.close();
  }, 60_000);
  it('starts a run from the inspector and records scoped chat', async () => {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    const project = (await (
      await fetch(base + '/api/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Chat project' }),
      })
    ).json()) as { id: string };
    const environments = (await (await fetch(base + '/api/v1/environments')).json()) as Array<{
      id: string;
      projectId: string;
    }>;
    const environment = environments.find((item) => item.projectId === project.id);
    const agent = (await (
      await fetch(base + '/api/v1/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          environmentId: environment?.id,
          name: 'Desk One',
        }),
      })
    ).json()) as { id: string };
    await fetch(base + '/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        environmentId: environment?.id,
        title: 'Inspect the office',
      }),
    });
    await page.click('#refresh');
    await page.waitForFunction(() => document.querySelectorAll('[data-agent]').length > 0);
    const desk = page.locator('[data-agent]').first();
    if ((await desk.count()) > 0) await desk.click();
    await page.waitForSelector('#startRun');
    await page.click('#startRun');
    await page.click('.nav-item[data-view="runs"]');
    await page.waitForSelector('#tableView:not(.hidden)');
    await page.waitForFunction(() =>
      /run_office_/.test(document.querySelector('#tableBody')?.textContent ?? ''),
    );
    await page.fill('#chatInput', 'Inspect the current work');
    await page.click('#chatForm button');
    await page.waitForFunction(() =>
      /Inspect the current work/.test(document.querySelector('#chatMessages')?.textContent ?? ''),
    );
    await page.click('.nav-item[data-view="settings"]');
    await page.waitForSelector('#tableView:not(.hidden)');
    expect(await page.locator('#viewTitle').innerText()).toBe('Settings');
    await page.close();
  }, 60_000);
  it('creates memory, model, budget, and workflow records from Add', async () => {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    await fetch(base + '/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Add records' }),
    });
    await page.click('#refresh');
    await page.click('.nav-item[data-view="memory"]');
    await page.waitForSelector('#tableView:not(.hidden)');
    page.once('dialog', (dialog) => dialog.accept('Keep the office calm'));
    await page.click('#tableAction');
    await page.waitForFunction(() =>
      /Keep the office calm/.test(document.querySelector('#tableBody')?.textContent ?? ''),
    );
    await page.click('.nav-item[data-view="models"]');
    await page.waitForSelector('#tableView:not(.hidden)');
    page.once('dialog', (dialog) => dialog.accept('qwen2.5-coder'));
    await page.click('#tableAction');
    await page.waitForFunction(() =>
      /qwen2.5-coder/.test(document.querySelector('#tableBody')?.textContent ?? ''),
    );
    await page.click('.nav-item[data-view="budgets"]');
    await page.waitForSelector('#tableView:not(.hidden)');
    page.once('dialog', (dialog) => dialog.accept('25'));
    await page.click('#tableAction');
    await page.waitForFunction(() =>
      /Monthly budget/.test(document.querySelector('#tableBody')?.textContent ?? ''),
    );
    await page.click('.nav-item[data-view="workflows"]');
    await page.waitForSelector('#tableView:not(.hidden)');
    page.once('dialog', (dialog) => dialog.accept('Review loop'));
    await page.click('#tableAction');
    await page.waitForFunction(() =>
      /Review loop/.test(document.querySelector('#tableBody')?.textContent ?? ''),
    );
    await page.close();
  }, 60_000);
  it('pauses and stops the selected agent run from the inspector', async () => {
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    const project = (await (
      await fetch(base + '/api/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Control project' }),
      })
    ).json()) as { id: string };
    const environments = (await (await fetch(base + '/api/v1/environments')).json()) as Array<{
      id: string;
      projectId: string;
    }>;
    const environment = environments.find((item) => item.projectId === project.id);
    await fetch(base + '/api/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        environmentId: environment?.id,
        name: 'Controller',
      }),
    });
    await fetch(base + '/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        environmentId: environment?.id,
        title: 'Operate the run',
      }),
    });
    await page.click('#refresh');
    await page.waitForFunction(() => document.querySelectorAll('[data-agent]').length > 0);
    await page.locator('[data-agent]').first().click();
    await page.click('#startRun');
    await page.click('#pauseRun');
    await page.click('.nav-item[data-view="runs"]');
    await page.waitForSelector('#tableView:not(.hidden)');
    await page.waitForFunction(() =>
      /paused/.test(document.querySelector('#tableBody')?.textContent ?? ''),
    );
    await page.click('.nav-item[data-view="office"]');
    await page.waitForSelector('#officeView:not(.hidden)');
    await page.locator('[data-agent]').first().click();
    await page.click('#stopRun');
    await page.click('.nav-item[data-view="runs"]');
    await page.waitForFunction(() =>
      /cancelled/.test(document.querySelector('#tableBody')?.textContent ?? ''),
    );
    await page.close();
  }, 60_000);
});
