import { Agent, Artifact, ID, Run, now } from './types.js';

export interface HandoffPacket {
  id: string;
  fromAgentId: ID;
  toAgentId: ID;
  runId: ID;
  taskId?: ID;
  summary: string;
  completed: string[];
  remaining: string[];
  artifacts: ID[];
  openQuestions: string[];
  createdAt: string;
}
export const createHandoff = (
  run: Run,
  from: Agent,
  to: Agent,
  summary: string,
  completed: string[],
  remaining: string[],
  artifacts: Artifact[] = [],
  openQuestions: string[] = [],
): HandoffPacket => ({
  id: `handoff_${run.id}_${to.id}`,
  fromAgentId: from.id,
  toAgentId: to.id,
  runId: run.id,
  taskId: run.taskId,
  summary,
  completed,
  remaining,
  artifacts: artifacts.map((artifact) => artifact.id),
  openQuestions,
  createdAt: now(),
});

export interface OutputComparison {
  winner?: ID;
  consensus: boolean;
  scores: Record<ID, number>;
  disagreements: string[];
}
export function compareOutputs(
  outputs: Array<{ agentId: ID; text: string; evidence: string[] }>,
): OutputComparison {
  if (!outputs.length) return { consensus: false, scores: {}, disagreements: ['no_outputs'] };
  const normalized = outputs.map((output) => ({
    ...output,
    words: new Set(output.text.toLowerCase().split(/\W+/).filter(Boolean)),
  }));
  const scores: Record<ID, number> = Object.fromEntries(
    normalized.map((output) => [output.agentId, output.evidence.length + output.words.size / 100]),
  );
  const winner = [...normalized].sort(
    (a, b) => (scores[b.agentId] ?? 0) - (scores[a.agentId] ?? 0),
  )[0]?.agentId;
  const disagreements = normalized
    .flatMap((output) => output.evidence)
    .filter(
      (item, index, all) =>
        all.indexOf(item) === index && normalized.some((other) => !other.evidence.includes(item)),
    );
  return {
    winner,
    consensus: disagreements.length === 0 && normalized.length > 1,
    scores,
    disagreements,
  };
}

export async function runBounded<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  if (limit < 1) throw new Error('concurrency_limit_invalid');
  const results: T[] = new Array(jobs.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= jobs.length) return;
      results[index] = await jobs[index]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, () => worker()));
  return results;
}
