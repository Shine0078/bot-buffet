import { Citation, Source } from './types.js';

/**
 * Research integrity rules. The harness must never let an agent claim a source was analyzed
 * when its content was never retrieved, so citation validation is a computational sensor
 * rather than a matter of trust.
 */
export interface CitationValidation {
  citationId: string;
  valid: boolean;
  reasons: string[];
  sourceStatus?: Source['status'];
}

/** Sources whose content was never successfully retrieved cannot support a verified claim. */
const UNUSABLE_STATUS: Source['status'][] = ['pending', 'inaccessible', 'unverified'];

export function validateCitations(citations: Citation[], sources: Source[]): CitationValidation[] {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return citations.map((citation) => {
    const reasons: string[] = [];
    const source = byId.get(citation.sourceId);
    if (!source) reasons.push('citation_source_missing');
    else {
      if (UNUSABLE_STATUS.includes(source.status)) reasons.push(`citation_source_${source.status}`);
      if (!source.retrievedAt) reasons.push('citation_source_not_retrieved');
      if (!source.contentHash) reasons.push('citation_source_unhashed');
    }
    if (!citation.claim || !citation.claim.trim()) reasons.push('citation_claim_empty');
    if (citation.verified && reasons.length) reasons.push('citation_verified_without_evidence');
    return {
      citationId: citation.id,
      valid: reasons.length === 0,
      reasons,
      ...(source ? { sourceStatus: source.status } : {}),
    };
  });
}

export interface ResearchBrief {
  projectId: string;
  totalSources: number;
  usableSources: number;
  pendingSources: string[];
  inaccessibleSources: string[];
  verifiedClaims: number;
  unsupportedClaims: string[];
  contradictions: Contradiction[];
}

export interface Contradiction {
  claim: string;
  sourceIds: string[];
  kind: 'negation' | 'divergent-value';
}

const NEGATION = /\b(not|no|never|cannot|isn't|doesn't|won't|false)\b/i;
/** Words that carry no claim content and would otherwise prevent related claims from grouping. */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'do',
  'does',
  'did',
  'of',
  'to',
  'in',
  'on',
  'at',
  'and',
  'or',
  'it',
  'that',
  'this',
  'with',
  'for',
]);

/**
 * Reduce a claim to its sorted content words, dropping negation, numbers, stopwords, and simple
 * plural suffixes. Two claims share a key when they talk about the same thing, so the negation
 * and numeric checks below can decide whether they actually agree.
 */
const normalizeClaim = (claim: string): string =>
  [
    ...new Set(
      claim
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((word) => !NEGATION.test(word))
        .filter((word) => !STOPWORDS.has(word))
        .filter((word) => !/^\d+(?:\.\d+)?$/.test(word))
        .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)),
    ),
  ]
    .sort()
    .join(' ');
const numbersIn = (claim: string): string[] => claim.match(/\d+(?:\.\d+)?/g) ?? [];

/**
 * Detect claims that contradict each other: the same normalized statement asserted with and
 * without negation, or the same statement carrying different numeric values.
 */
export function detectContradictions(citations: Citation[]): Contradiction[] {
  const groups = new Map<string, Citation[]>();
  for (const citation of citations) {
    if (!citation.claim?.trim()) continue;
    const key = normalizeClaim(citation.claim);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), citation]);
  }
  const contradictions: Contradiction[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const negated = group.filter((citation) => NEGATION.test(citation.claim));
    if (negated.length && negated.length !== group.length) {
      contradictions.push({
        claim: key,
        sourceIds: [...new Set(group.map((citation) => citation.sourceId))].sort(),
        kind: 'negation',
      });
      continue;
    }
    const signatures = new Set(group.map((citation) => numbersIn(citation.claim).join(',')));
    if (signatures.size > 1)
      contradictions.push({
        claim: key,
        sourceIds: [...new Set(group.map((citation) => citation.sourceId))].sort(),
        kind: 'divergent-value',
      });
  }
  return contradictions.sort((a, b) => a.claim.localeCompare(b.claim));
}

/** Build a brief that shows pending and inaccessible sources rather than hiding them. */
export function researchBrief(
  projectId: string,
  sources: Source[],
  citations: Citation[],
): ResearchBrief {
  const scopedSources = sources.filter((source) => source.projectId === projectId);
  const validations = validateCitations(citations, scopedSources);
  const validById = new Map(validations.map((item) => [item.citationId, item]));
  return {
    projectId,
    totalSources: scopedSources.length,
    usableSources: scopedSources.filter(
      (source) => !UNUSABLE_STATUS.includes(source.status) && Boolean(source.retrievedAt),
    ).length,
    pendingSources: scopedSources
      .filter((source) => source.status === 'pending')
      .map((source) => source.id)
      .sort(),
    inaccessibleSources: scopedSources
      .filter((source) => source.status === 'inaccessible')
      .map((source) => source.id)
      .sort(),
    verifiedClaims: validations.filter((item) => item.valid).length,
    unsupportedClaims: citations
      .filter((citation) => !validById.get(citation.id)?.valid)
      .map((citation) => citation.id)
      .sort(),
    contradictions: detectContradictions(citations),
  };
}
