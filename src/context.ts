import { MemoryItem } from './types.js';
import { redactSecrets } from './security.js';

export interface ContextItem {
  id: string;
  text: string;
  scope: string;
  relevance: number;
  freshnessAt?: string;
  sourceIds?: string[];
}
export interface AssembledContext {
  text: string;
  selectedIds: string[];
  omittedIds: string[];
  estimatedTokens: number;
  compacted: boolean;
  citations: string[];
}
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export function assembleContext(items: ContextItem[], budgetTokens: number): AssembledContext {
  if (budgetTokens < 16) throw new Error('context_budget_too_small');
  const ordered = [...items].sort(
    (a, b) =>
      b.relevance + freshnessScore(b.freshnessAt) - (a.relevance + freshnessScore(a.freshnessAt)),
  );
  const selected: ContextItem[] = [];
  const omitted: ContextItem[] = [];
  let used = 0;
  for (const item of ordered) {
    const line = `[${item.scope}] ${item.text}`;
    const tokens = estimateTokens(line);
    if (used + tokens <= budgetTokens) {
      selected.push(item);
      used += tokens;
    } else omitted.push(item);
  }
  const remainingTokens = Math.max(0, budgetTokens - used);
  const summaryText = omitted.map((x) => x.text.slice(0, 120)).join(' | ');
  const summary =
    omitted.length && remainingTokens > 0
      ? `\n[compacted ${omitted.length} items] ${summaryText.slice(0, Math.max(0, remainingTokens * 4 - 22))}`
      : '';
  const text = [...selected.map((x) => `[${x.scope}] ${String(redactSecrets(x.text))}`), summary]
    .filter(Boolean)
    .join('\n');
  return {
    text,
    selectedIds: selected.map((x) => x.id),
    omittedIds: omitted.map((x) => x.id),
    estimatedTokens: estimateTokens(text),
    compacted: omitted.length > 0,
    citations: selected.flatMap((x) => x.sourceIds ?? []),
  };
}

const freshnessScore = (date?: string): number =>
  date ? Math.max(0, 1 - (Date.now() - Date.parse(date)) / (1000 * 60 * 60 * 24 * 30)) : 0;
export const memoryToContext = (memory: MemoryItem, relevance = 0.5): ContextItem => ({
  id: memory.id,
  text: memory.text,
  scope: `${memory.namespace}:${memory.namespaceId}`,
  relevance,
  freshnessAt: memory.freshnessAt,
  sourceIds: memory.sourceIds,
});
