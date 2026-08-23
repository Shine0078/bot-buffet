import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLocalAdapter } from '../src/providers.js';
import { ModelRouter } from '../src/router.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createStore } from '../src/store.js';
import { createBuiltinTools } from '../src/tools.js';
import { fixtures } from './helpers/orchestrator-fixtures.js';
import type { Run } from '../src/types.js';

describe('markdown output format is enforced by the orchestrator', () => {
  it('asks for markdown over the text provider format and stores structured output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-md-'));
    const store = createStore(dir);
    const { project, agent, model, task } = fixtures('supervised');
    agent.profile.outputFormat = 'markdown';
    agent.profile.verificationPolicy = {
      deterministic: ['output-format'],
      inferential: [],
      requireEvidence: true,
    };
    for (const record of [project, agent, model, task]) await store.insert(record);
    let seenFormat: string | undefined;
    let seenPrompt = '';
    const orchestrator = new Orchestrator({
      store,
      router: new ModelRouter(async () => [model]),
      tools: createBuiltinTools(store),
      workspaceRoot: () => dir,
      adapters: () => {
        const inner = new MockLocalAdapter('m');
        return {
          complete: async (request) => {
            seenFormat = request.responseFormat;
            seenPrompt =
              request.messages.find((message) => message.role === 'system')?.content ?? '';
            return inner.complete(request);
          },
          stream: (request) => {
            seenFormat = request.responseFormat;
            seenPrompt =
              request.messages.find((message) => message.role === 'system')?.content ?? '';
            return inner.stream(request);
          },
          batch: (requests) => inner.batch(requests),
          health: () => inner.health(),
          listModels: () => inner.listModels(),
        };
      },
    });
    const run = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    await orchestrator.start(run.id);
    const finished = await store.get<Run>(run.id);
    expect(seenFormat).toBe('text');
    expect(seenPrompt).toContain('GitHub-flavored Markdown');
    expect(finished?.status).toBe('completed');
    const state = await store.getRunState(run.id);
    expect(String(state?.lastResponse ?? '')).toMatch(/^# /);
  });
});
