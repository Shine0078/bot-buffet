/**
 * Types for the plain-ESM brand gate so the regression suite can import it
 * without an `any` escape hatch. Kept beside the script; NodeNext resolves
 * `./brand-scan.mjs` to this `.d.mts`.
 */

export interface BrandHit {
  path: string;
  line: number;
  content: string;
}

export interface BrandAllowance {
  path: string;
  needle: string;
  reason: string;
}

export declare const BRAND_TERMS: readonly string[];
export declare const BRAND_PATTERN: string;
export declare const ALLOWED: readonly BrandAllowance[];
/** Paths of the gate implementation and its regression suite, excluded by
 *  exact path because they must name the brand terms to do their job. */
export declare const GATE_PATHS: readonly string[];

export interface BrandFileExemption {
  path: string;
  reason: string;
}
/** Documents that legitimately name the upstream product in full. */
export declare const EXEMPT_FILES: readonly BrandFileExemption[];
export declare function isExemptFile(
  hit: Pick<BrandHit, 'path'>,
  exemptFiles?: readonly BrandFileExemption[],
): boolean;

/** Throws if the pattern stopped matching the brand or grew too broad. */
export declare function selfTest(pattern?: string): true;

/** Parses one `path:line:content` grep hit, or null when unparsable. */
export declare function parseHit(line: string): BrandHit | null;

export declare function isAllowed(
  hit: Pick<BrandHit, 'path' | 'content'>,
  allowed?: readonly BrandAllowance[],
): boolean;

/** Reduces raw `git grep` output to the hits that should fail the build. */
export declare function filterHits(
  output: string,
  allowed?: readonly BrandAllowance[],
  gatePaths?: readonly string[],
): BrandHit[];

export declare function main(): void;
