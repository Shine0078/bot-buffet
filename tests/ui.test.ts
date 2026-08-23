import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd());
const html = readFileSync(resolve(root, 'ui/index.html'), 'utf8');
const app = readFileSync(resolve(root, 'ui/app.js'), 'utf8');
const css = readFileSync(resolve(root, 'ui/styles.css'), 'utf8');

describe('Office UI accessibility contract', () => {
  it('has landmarks, skip navigation, and a table alternative', () => {
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('class="skip-link"');
    expect(html).toContain('<main id="main"');
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).toContain('<table>');
    expect(html).toContain('Samuel Abraham');
    expect(html).toContain('Bot Buffet');
    expect(html).not.toContain('Munder Difflin');
  });

  it('makes generated agent desks keyboard-operable and safely labelled', () => {
    expect(app).toContain('role="button"');
    expect(app).toContain("e.key !== 'Enter' && e.key !== ' '");
    expect(app).toContain('aria-label="Inspect');
    expect(app).toContain('const esc =');
  });

  it('supports reduced motion and visible keyboard focus', () => {
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain(':focus-visible');
  });

  it('exposes budget, usage, workflow, and alert views in the accessible tables', () => {
    for (const view of ['budgets', 'usage', 'workflows', 'alerts'])
      expect(html).toContain(`data-view="${view}"`);
    expect(app).toContain('budgets: [');
    expect(app).toContain('workflows: [');
    expect(app).toContain("alerts: ['Alerts'");
    expect(app).toContain('return usageTable()');
    expect(app).toContain("api('/api/v1/usage?groupBy=agent&period=monthly')");
  });
  it('wires the primary action buttons instead of leaving them inert', () => {
    expect(app).toContain("$('#newProject').onclick");
    expect(app).toContain("$('#viewAllRuns').onclick");
    expect(app).toContain("$('#tableAction').onclick");
    expect(app).toContain("api('/api/v1/projects'");
    expect(app).toContain("api('/api/v1/tasks'");
    expect(app).toContain("switchView('runs')");
  });
  it('wires inspector start, settings, and scoped chat to control-plane APIs', () => {
    expect(app).toContain('id="startRun"');
    expect(app).toContain("api('/api/v1/runs'");
    expect(app).toContain("api('/api/v1/memory'");
    expect(app).toContain('settings: [');
    expect(app).toContain('sendChat(text)');
  });
  it('creates scoped records from the table Add button', () => {
    expect(app).toContain("api('/api/v1/local-models/register'");
    expect(app).toContain("api('/api/v1/budgets'");
    expect(app).toContain("api('/api/v1/workflows'");
    expect(app).toContain("namespace: 'project'");
  });
  it('wires inspector pause, resume, and stop to run command routes', () => {
    expect(app).toContain('id="pauseRun"');
    expect(app).toContain('id="resumeRun"');
    expect(app).toContain('id="stopRun"');
    expect(app).toContain("/api/v1/runs/' + run.id + '/' + type");
  });
  it('blocks file:// opens instead of leaving buttons inert', () => {
    expect(app).toContain("location.protocol === 'file:'");
    expect(app).toContain('showControlPlaneFailure');
    expect(app).toContain('control_plane_unserved');
    expect(app).toContain('http://127.0.0.1:8787');
    expect(html).toContain('id="productVersion"');
    expect(html).not.toContain('v0.1.0');
    expect(css).toContain('control-plane-banner');
  });
  it('shows the latest profile changelog in the inspector', () => {
    expect(app).toContain('Profile change');
    expect(app).toContain('changelog');
  });
});
