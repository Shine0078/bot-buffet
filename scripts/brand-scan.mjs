import { execFileSync } from 'node:child_process';
import process from 'node:process';

/**
 * Brand scan: fails the build if the upstream "Munder Difflin" naming survives
 * anywhere in the tracked tree.
 *
 * Two defects made the earlier version worthless and are guarded against here:
 *
 *   1. It passed `munder|difflin` to `git grep` without `-E`. Under git's
 *      default basic regular expressions `|` is a LITERAL pipe, so the scan
 *      searched for the single string "munder|difflin" and never looked for
 *      either brand term. Use `-E` and prove the pattern works (see selfTest).
 *   2. A scanner must spell out the terms it hunts for, so it always matches
 *      its own source. That is excluded by PATH below — never by loosening the
 *      pattern, so a genuine leftover anywhere else still fails the gate.
 */

/** The gate's own implementation and its regression suite must name the brand
 *  terms in order to hunt for them and to prove the hunt works. Both are
 *  excluded by exact path only — never by loosening the pattern — so a genuine
 *  leftover in any other file still fails the build. */
export const GATE_PATHS = ['scripts/brand-scan.mjs', 'tests/brand-scan.test.ts'];

export const BRAND_TERMS = ['munder', 'difflin'];
export const BRAND_PATTERN = BRAND_TERMS.join('|');

/**
 * Reviewed references that attest the brand is gone rather than reintroducing
 * it. Matched by path plus required substring, not by line number, so ordinary
 * edits above them cannot silently disable the exemption.
 */
export const ALLOWED = [
  {
    path: 'docs/changelog.md',
    needle: 'No Munder Difflin branding remains',
    reason: 'The changelog records the brand migration itself.',
  },
  {
    path: 'tests/ui.test.ts',
    needle: "not.toContain('Munder Difflin')",
    reason: 'The UI regression test asserts the brand string is absent.',
  },
];

/**
 * Guard against a silently broken pattern. If the alternation ever regresses
 * to a literal again, this throws instead of reporting a clean tree.
 */
export function selfTest(pattern = BRAND_PATTERN) {
  const expression = new RegExp(pattern, 'i');
  for (const control of ['Munder Difflin', 'MUNDER', 'difflin', 'a munder b']) {
    if (!expression.test(control)) {
      throw new Error(`Brand scan pattern is broken: it does not match ${JSON.stringify(control)}`);
    }
  }
  for (const control of ['Bot Buffet', 'Samuel Abraham', 'mundane', '']) {
    if (expression.test(control)) {
      throw new Error(`Brand scan pattern is too broad: it matches ${JSON.stringify(control)}`);
    }
  }
  return true;
}

/** Split a `path:line:content` grep hit. Windows drive letters are not a
 *  concern because `git grep` always emits repository-relative paths. */
export function parseHit(line) {
  const match = /^([^:]+):(\d+):([\s\S]*)$/.exec(line);
  if (!match) return null;
  return { path: match[1], line: Number(match[2]), content: match[3] };
}

export function isAllowed(hit, allowed = ALLOWED) {
  return allowed.some((entry) => entry.path === hit.path && hit.content.includes(entry.needle));
}

/** Reduce raw `git grep` output to the hits that should fail the build. */
export function filterHits(output, allowed = ALLOWED, gatePaths = GATE_PATHS) {
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => parseHit(line) ?? { path: '<unparsed>', line: 0, content: line })
    .filter((hit) => !gatePaths.includes(hit.path))
    .filter((hit) => !isAllowed(hit, allowed));
}

function runGrep() {
  try {
    return execFileSync(
      'git',
      [
        'grep',
        '-E',
        '-i',
        '-I',
        '-n',
        BRAND_PATTERN,
        '--',
        '.',
        ...GATE_PATHS.map((path) => `:(exclude)${path}`),
      ],
      { encoding: 'utf8' },
    ).trim();
  } catch (error) {
    // git grep exits 1 when there are no matches, which is the success case.
    if (error.status === 1) return '';
    throw error;
  }
}

export function main() {
  selfTest();
  const hits = filterHits(runGrep());
  if (hits.length) {
    console.error('Brand scan failed: leftover Munder Difflin naming found');
    for (const hit of hits) console.error(`${hit.path}:${hit.line}:${hit.content}`);
    process.exit(1);
  }
  console.log(
    `Brand scan passed: no leftover Munder Difflin naming (pattern /${BRAND_PATTERN}/i verified).`,
  );
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('brand-scan.mjs');
if (invokedDirectly) main();
