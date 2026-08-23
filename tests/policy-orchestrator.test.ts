import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRouter } from '../src/router.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createStore } from '../src/store.js';
import { createBuiltinTools } from '../src/tools.js';
import { fixtures } from './helpers/orchestrator-fixtures.js';
import { entity, type Policy, type Run } from '../src/types.js';
import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
} from '../src/providers.js';

class WriteCallingAdapter implements ModelAdapter {
  async complete(): Promise<ModelResponse> {
    return {
      id: 'mock',
      content: 'repository',
      toolCalls: [
        { id: 'call-1', name: 'filesystem.write', arguments: { path: 'note.txt', content: 'x' } },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1,
    };
  }
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const response = await this.complete();
    yield {
      id: response.id,
      delta: response.content,
      toolCalls: response.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })),
      done: true,
      usage: response.usage,
    };
    void request;
  }
  batch(requests: readonly ModelRequest[]): Promise<readonly ModelResponse[]> {
    return Promise.all(requests.map(() => this.complete()));
  }
  async health(): Promise<'healthy' | 'degraded' | 'offline'> {
    return 'healthy';
  }
  async listModels(): Promise<string[]> {
    return ['m'];
  }
}

describe('stored policies are consulted by the orchestrator', () => {
  it('denies a tool when an enabled project policy says deny', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-policy-'));
    await writeFile(join(dir, 'repository'), 'contents');
    const store = createStore(dir);
    const { project, agent, model, task } = fixtures('execute');
    agent.profile.allowedToolIds = ['filesystem.write'];
    const policy = entity({
      kind: 'policy',
      ownerId: 'u',
      scope: project.id,
      name: 'No writes',
      enabled: true,
      rules: [{ action: 'filesystem.write', effect: 'deny' }],
    }) as Policy;
    for (const record of [project, agent, model, task, policy]) await store.insert(record);
    const orchestrator = new Orchestrator({
      store,
      router: new ModelRouter(async () => [model]),
      tools: createBuiltinTools(store),
      workspaceRoot: () => dir,
      adapters: () => new WriteCallingAdapter(),
    });
    const run = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    await orchestrator.start(run.id);
    const finished = await store.get<Run>(run.id);
    expect(finished?.error).toMatch(/policy_denied|filesystem.write/);
    expect(finished?.status).not.toBe('completed');
  });
});
