/**
 * Types for the provenance verifier so its suite can import it without an
 * `any` escape hatch.
 */

export interface ProvenanceArtifact {
  path: string;
  bytes?: number;
  sha256: string;
}

export interface ProvenanceManifest {
  schema: string;
  generatedAt?: string;
  sourceRevision?: string;
  artifacts: ProvenanceArtifact[];
}

export interface VerificationResult {
  ok: boolean;
  checked: number;
  missing: string[];
  mismatched: Array<{ path: string; expected: string; actual: string }>;
  unlisted: string[];
}

export declare const MANIFEST_SCHEMA: string;
export declare function parseManifest(raw: string): ProvenanceManifest;
export declare function renderChecksums(manifest: ProvenanceManifest): string;
export declare function verifyManifest(
  manifest: ProvenanceManifest,
  options?: { root?: string; listDist?: () => Promise<string[]> },
): Promise<VerificationResult>;
export declare function main(): Promise<void>;
