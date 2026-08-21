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
});
