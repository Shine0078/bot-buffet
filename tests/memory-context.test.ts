import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLocalAdapter, type ModelRequest } from '../src/providers.js';
import { ModelRouter } from '../src/router.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createStore } from '../src/store.js';
import { createBuiltinTools } from '../src/tools.js';
import { entity, type MemoryItem } from '../src/types.js';
import { fixtures } from './helpers/orchestrator-fixtures.js';

/**
 * Wiring evidence for scoped memory. The unit suite proves the filter; this
 * proves the orchestrator actually assembles the filtered result into what the
 * model is shown — and, more importantly, that another project's memory never
 * reaches it.
 *
 * The assertion is made against the real prompt the adapter received, not
 * against an intermediate structure, because the question is what the model
 * could see.
 */
async function runWithMemory(items: Array<Partial<MemoryItem>>) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-mem-'));
  await writeFile(join(dir, 'repository'), 'contents');
  const store = createStore(dir);
  const { project, agent, model, task } = fixtures('execute');
  for (const record of [project, agent, model, task]) await store.insert(record);

  for (const item of items) {
    await store.insert(
      entity({
        kind: 'memory',
        ownerId: 'u',
        scope: project.id,
        namespace: 'project',
        namespaceId: project.id,
        text: 'unset',
        sourceIds: [],
        approved: true,
        freshnessAt: new Date().toISOString(),
        ...item,
      }) as MemoryItem,
    );
  }

  const prompts: string[] = [];
  const orchestrator = new Orchestrator({
    store,
    router: new ModelRouter(async () => [model]),
    tools: createBuiltinTools(store),
    workspaceRoot: () => dir,
    adapters: () => {
      const adapter = new MockLocalAdapter('m');
      const complete = adapter.complete.bind(adapter);
      adapter.complete = async (request: ModelRequest) => {
        prompts.push(request.messages.map((message) => message.content).join('\n'));
        return complete(request);
      };
      return adapter;
    },
  });

  const run = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
  await orchestrator.start(run.id);
  return { prompt: prompts.join('\n'), projectId: project.id };
}

describe('scoped memory reaches agent context', () => {
  it("includes memory from this run's own project", async () => {
    const { prompt } = await runWithMemory([{ text: 'the deploy key rotates on Fridays' }]);
    expect(prompt).toContain('the deploy key rotates on Fridays');
  });

  it("never includes another project's memory", async () => {
    const { prompt } = await runWithMemory([
      { text: 'MINE-this-project-note' },
      { text: 'THEIRS-another-project-note', namespaceId: 'project-somewhere-else' },
    ]);
    expect(prompt).toContain('MINE-this-project-note');
    expect(prompt).not.toContain('THEIRS-another-project-note');
  });

  it('never includes a namespace the profile cannot read', async () => {
    // The fixture profile reads project, agent, and task only.
    const { prompt } = await runWithMemory([
      { text: 'WORKSPACE-SCOPED-NOTE', namespace: 'workspace', namespaceId: 'w' },
    ]);
    expect(prompt).not.toContain('WORKSPACE-SCOPED-NOTE');
  });

  it('never includes memory that has expired', async () => {
    const { prompt } = await runWithMemory([
      { text: 'EXPIRED-NOTE', expiresAt: new Date(Date.now() - 1000).toISOString() },
      { text: 'CURRENT-NOTE' },
    ]);
    expect(prompt).toContain('CURRENT-NOTE');
    expect(prompt).not.toContain('EXPIRED-NOTE');
  });

  it('runs normally when there is no memory at all', async () => {
    const { prompt } = await runWithMemory([]);
    expect(prompt).toContain('Task: repo');
  });
});
