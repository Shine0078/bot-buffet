import { describe, expect, it } from 'vitest';
import { ModelRouter } from '../src/router.js';
import { Model, entity } from '../src/types.js';

const model = (id: string, local: boolean): Model => ({
  ...entity({
    kind: 'model',
    ownerId: 'u',
    scope: 'w',
    providerId: 'p',
    name: id,
    modelName: id,
    local,
    capabilities: {
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      audio: false,
      embeddings: false,
      reranking: false,
      contextTokens: 8192,
      outputTokens: 1024,
    },
    inputCostPerMillionCents: local ? 0 : 10,
    outputCostPerMillionCents: local ? 0 : 20,
    available: true,
  }),
  id,
});
describe('model routing', () => {
  it('never selects cloud in offline mode', async () => {
    const router = new ModelRouter(async () => [model('cloud', false), model('local', true)]);
    expect(
      (await router.choose({ contextTokens: 100, privacy: 'private', offline: true })).modelId,
    ).toBe('local');
  });
  it('uses least-cost strategy', async () => {
    const router = new ModelRouter(async () => [model('cloud', false), model('local', true)]);
    const route = entity({
      kind: 'model-route' as const,
      ownerId: 'u',
      scope: 'p',
      name: 'cheap',
      modelIds: ['cloud', 'local'],
      fallbackModelIds: [],
      strategy: 'least-cost' as const,
      offlineOnly: false,
    });
    const decision = await router.choose(
      { contextTokens: 100, privacy: 'public', offline: false },
      route,
    );
    expect(decision.modelId).toBe('local');
  });
});
