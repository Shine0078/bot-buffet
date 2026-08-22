import { execFileSync } from 'node:child_process';

let output = '';
try {
  output = execFileSync('git', ['grep', '-i', '-I', '-n', 'munder|difflin', '--', '.'], {
    encoding: 'utf8',
  }).trim();
} catch (error) {
  if (error.status !== 1) throw error;
}

const allowed = new Set([
  "docs/changelog.md:60:- Brand pass: the product is now Samuel Abraham's Bot Buffet in the Office chrome, README, package metadata, and bootstrap workspace name. No Munder Difflin branding remains in the Bot Buffet UI.",
  "tests/ui.test.ts:19:    expect(html).not.toContain('Munder Difflin');",
]);
const hits = output ? output.split(/\r?\n/).filter((line) => line && !allowed.has(line)) : [];

if (hits.length) {
  console.error('Brand scan failed: leftover Munder Difflin naming found');
  for (const hit of hits) console.error(hit);
  process.exit(1);
}

console.log('Brand scan passed: no leftover Munder Difflin naming.');
