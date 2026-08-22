/**
 * Types for the installation preflight so its decision logic can be unit
 * tested without an `any` escape hatch.
 */

export type PreflightStatus = 'ok' | 'warning' | 'blocker';

export interface PreflightCheck {
  name: string;
  status: PreflightStatus;
  detail: string;
  remediation?: string;
}

export interface PreflightResult {
  ok: boolean;
  blockers: PreflightCheck[];
  warnings: PreflightCheck[];
  checks: PreflightCheck[];
}

/** Facts about the host. Every field is optional so a test can exercise one
 *  branch without having to describe an entire machine. */
export interface PreflightFacts {
  platform?: NodeJS.Platform | string;
  engineFloor?: number | null;
  nodeVersion?: string | null;
  npmVersion?: string | null;
  gitVersion?: string | null;
  dockerVersion?: string | null;
  dependenciesInstalled?: boolean;
  dataDir?: string;
  dataDirWritable?: boolean;
  playwrightBrowserInstalled?: boolean;
}

export declare function parseEngineFloor(range: unknown): number | null;
export declare function readEngineFloor(repoRoot?: string): number | null;
export declare function majorOf(version: unknown): number | null;
export declare function nodeRemediation(platform: string): string;
export declare function dockerRemediation(platform: string): string;
export declare function evaluateEnvironment(facts: PreflightFacts): PreflightResult;
export declare function formatReport(result: PreflightResult): string;
export declare function gatherFacts(repoRoot?: string, platform?: string): PreflightFacts;
export declare function main(): void;
