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
  const api = createApi({
    store: createStore(dir),
    orchestrator: new EventEmitter() as unknown as Orchestrator,
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
});
