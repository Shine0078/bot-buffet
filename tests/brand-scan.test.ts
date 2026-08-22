import { describe, expect, it } from 'vitest';
import {
  BRAND_PATTERN,
  filterHits,
  isAllowed,
  isExemptFile,
  parseHit,
  selfTest,
} from '../scripts/brand-scan.mjs';

/**
 * The brand gate previously shipped two defects that made it useless: it passed
 * an unescaped alternation to `git grep` without `-E` (so `|` was a literal and
 * neither term was ever searched for), and it matched its own source, so the
 * gate was permanently red and therefore ignored. These tests pin both.
 */
describe('brand scan', () => {
  it('uses a real alternation rather than a literal pipe', () => {
    expect(BRAND_PATTERN).toBe('munder|difflin');
    const expression = new RegExp(BRAND_PATTERN, 'i');
    expect(expression.test('Munder Difflin')).toBe(true);
    expect(expression.test('difflin')).toBe(true);
    expect(expression.test('munder')).toBe(true);
  });

  it('self-test rejects a pattern that stopped matching the brand', () => {
    expect(selfTest()).toBe(true);
    // A literal pipe is exactly the regression that made the gate blind.
    expect(() => selfTest('munder\\|difflin')).toThrow(/pattern is broken/i);
  });

  it('self-test rejects a pattern broad enough to match unrelated text', () => {
    expect(() => selfTest('.')).toThrow(/too broad/i);
  });

  it('parses git grep hits into path, line, and content', () => {
    expect(parseHit('src/api.ts:42:const x = 1;')).toEqual({
      path: 'src/api.ts',
      line: 42,
      content: 'const x = 1;',
    });
    expect(parseHit('not-a-hit')).toBeNull();
  });

  it('fails on a genuine leftover anywhere in the tree', () => {
    const hits = filterHits('src/api.ts:10:// TODO: port the Munder Difflin loader');
    expect(hits).toHaveLength(1);
    expect(hits.at(0)?.path).toBe('src/api.ts');
  });

  it('excludes only the gate implementation, by path and never by pattern', () => {
    expect(filterHits("scripts/brand-scan.mjs:21:export const BRAND_TERMS = ['munder'];")).toEqual(
      [],
    );
    // The gate's own regression suite is excluded on the same grounds.
    expect(filterHits("tests/brand-scan.test.ts:20:expect(re.test('Munder Difflin'));")).toEqual(
      [],
    );
    // A leftover in another script is still a failure.
    expect(filterHits('scripts/smoke.mjs:3:// munder')).toHaveLength(1);
  });

  it('allows reviewed attestations by path plus content, not by line number', () => {
    const changelog = {
      path: 'docs/changelog.md',
      content: '- Brand pass: No Munder Difflin branding remains in the Bot Buffet UI.',
    };
    expect(isAllowed(changelog)).toBe(true);
    // Same file, different content: the exemption must not cover it.
    expect(isAllowed({ path: 'docs/changelog.md', content: 'Install Munder Difflin first.' })).toBe(
      false,
    );
    // Right content, wrong file: also not covered.
    expect(isAllowed({ path: 'README.md', content: 'No Munder Difflin branding remains' })).toBe(
      false,
    );
  });

  it('exempts a review document in full, because it must name what it reviews', () => {
    expect(
      filterHits('docs/munder-difflin-review.md:1:# Adversarial review: Munder Difflin'),
    ).toEqual([]);
    expect(isExemptFile({ path: 'docs/munder-difflin-review.md' })).toBe(true);
  });

  it('refuses to exempt anything that is not documentation', () => {
    // A whole-file exemption on source or UI would hide a real leftover, so the
    // entry is ignored and the hit still fails the gate.
    expect(isExemptFile({ path: 'src/api.ts' }, [{ path: 'src/api.ts', reason: 'nope' }])).toBe(
      false,
    );
    expect(isExemptFile({ path: 'ui/app.js' }, [{ path: 'ui/app.js', reason: 'nope' }])).toBe(
      false,
    );
    expect(isExemptFile({ path: 'notes.md' }, [{ path: 'notes.md', reason: 'ok' }])).toBe(true);
  });

  it('does not exempt an unlisted document', () => {
    expect(filterHits('docs/user-guide.md:5:Install Munder Difflin first.')).toHaveLength(1);
  });

  it('treats an unparsable grep line as a failure rather than dropping it', () => {
    const hits = filterHits('totally-unexpected-output');
    expect(hits).toHaveLength(1);
    expect(hits.at(0)?.path).toBe('<unparsed>');
  });
});
