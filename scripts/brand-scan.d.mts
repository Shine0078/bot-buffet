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
  selfPath?: string,
): BrandHit[];

export declare function main(): void;
