import { describe, expect, it } from 'vitest';
import { detectContradictions, researchBrief, validateCitations } from '../src/research.js';
import { Citation, Source, entity } from '../src/types.js';

const source = (overrides: Partial<Source> = {}): Source =>
  entity({
    kind: 'source',
    ownerId: 'u',
    scope: 'p1',
    projectId: 'p1',
    uri: 'https://example.test/paper',
    status: 'available',
    quality: 'high',
    retrievedAt: '2026-08-20T00:00:00.000Z',
    contentHash: 'a'.repeat(64),
    ...overrides,
  }) as Source;

const citation = (sourceId: string, claim: string, verified = false): Citation =>
  entity({
    kind: 'citation',
    ownerId: 'u',
    scope: 'p1',
    sourceId,
    claim,
    verified,
  }) as Citation;

describe('citation validation', () => {
  it('accepts a claim backed by a retrieved, hashed, available source', () => {
    const backing = source();
    const [result] = validateCitations(
      [citation(backing.id, 'the harness owns the loop')],
      [backing],
    );
    expect(result).toMatchObject({ valid: true, reasons: [], sourceStatus: 'available' });
  });

  it('rejects claims citing pending, inaccessible, or unretrieved sources', () => {
    const pending = source({ status: 'pending', retrievedAt: undefined, contentHash: undefined });
    const inaccessible = source({ status: 'inaccessible' });
    const results = validateCitations(
      [citation(pending.id, 'claim a'), citation(inaccessible.id, 'claim b')],
      [pending, inaccessible],
    );
    expect(results[0]!.valid).toBe(false);
    expect(results[0]!.reasons).toContain('citation_source_pending');
    expect(results[0]!.reasons).toContain('citation_source_not_retrieved');
    expect(results[1]!.reasons).toContain('citation_source_inaccessible');
  });

  it('rejects a missing source, an empty claim, and a false verified flag', () => {
    const orphan = validateCitations([citation('missing-source', 'claim')], [])[0]!;
    expect(orphan.reasons).toContain('citation_source_missing');

    const backing = source();
    const empty = validateCitations([citation(backing.id, '   ')], [backing])[0]!;
    expect(empty.reasons).toContain('citation_claim_empty');

    const lying = validateCitations([citation('missing-source', 'claim', true)], [])[0]!;
    expect(lying.reasons).toContain('citation_verified_without_evidence');
  });
});

describe('contradiction detection', () => {
  it('flags the same claim asserted with and without negation', () => {
    const contradictions = detectContradictions([
      citation('s1', 'The sandbox blocks network egress'),
      citation('s2', 'The sandbox does not block network egress'),
    ]);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]).toMatchObject({ kind: 'negation', sourceIds: ['s1', 's2'] });
  });

  it('flags the same claim carrying divergent numeric values', () => {
    const contradictions = detectContradictions([
      citation('s1', 'Latency was 120 ms'),
      citation('s2', 'Latency was 400 ms'),
    ]);
    expect(contradictions[0]).toMatchObject({ kind: 'divergent-value' });
  });

  it('does not flag agreement, single claims, or empty claims', () => {
    expect(
      detectContradictions([
        citation('s1', 'Latency was 120 ms'),
        citation('s2', 'Latency was 120 ms'),
      ]),
    ).toEqual([]);
    expect(detectContradictions([citation('s1', 'only one claim')])).toEqual([]);
    expect(detectContradictions([citation('s1', '  '), citation('s2', '  ')])).toEqual([]);
  });
});

describe('research brief', () => {
  it('surfaces pending and inaccessible sources instead of hiding them', () => {
    const good = source();
    const pending = source({ status: 'pending', retrievedAt: undefined });
    const broken = source({ status: 'inaccessible' });
    const otherProject = source({ projectId: 'p2' });
    const brief = researchBrief(
      'p1',
      [good, pending, broken, otherProject],
      [
        citation(good.id, 'supported claim'),
        citation(pending.id, 'unsupported claim'),
        citation('s1', 'Coverage is 90 percent'),
        citation('s2', 'Coverage is 40 percent'),
      ],
    );
    expect(brief.totalSources).toBe(3);
    expect(brief.usableSources).toBe(1);
    expect(brief.pendingSources).toEqual([pending.id]);
    expect(brief.inaccessibleSources).toEqual([broken.id]);
    expect(brief.verifiedClaims).toBe(1);
    expect(brief.unsupportedClaims).toHaveLength(3);
    expect(brief.contradictions[0]?.kind).toBe('divergent-value');
  });
});
