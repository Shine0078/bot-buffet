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
    latencyMs: local ? 80 : 240,
    routingWeight: local ? 1 : 5,
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

  it('enforces route cost ceilings before selecting a model', async () => {
    const router = new ModelRouter(async () => [model('cloud', false), model('local', true)]);
    const route = entity({
      kind: 'model-route' as const,
      ownerId: 'u',
      scope: 'p',
      name: 'budget',
      modelIds: ['cloud', 'local'],
      fallbackModelIds: [],
      strategy: 'health-first' as const,
      offlineOnly: false,
      maxCostCents: 0.01,
    });
    const decision = await router.choose(
      { contextTokens: 100, estimatedOutputTokens: 1000, privacy: 'public', offline: false },
      route,
    );
    expect(decision.modelId).toBe('local');
  });

  it('orders weighted and lowest-latency routes using model metadata', async () => {
    const router = new ModelRouter(async () => [model('cloud', false), model('local', true)]);
    const weighted = entity({
      kind: 'model-route' as const,
      ownerId: 'u',
      scope: 'p',
      name: 'weighted',
      modelIds: ['local', 'cloud'],
      fallbackModelIds: [],
      strategy: 'weighted' as const,
      offlineOnly: false,
    });
    const latency = { ...weighted, strategy: 'lowest-latency' as const };
    expect(
      (await router.choose({ contextTokens: 100, privacy: 'public', offline: false }, weighted))
        .modelId,
    ).toBe('cloud');
    expect(
      (await router.choose({ contextTokens: 100, privacy: 'public', offline: false }, latency))
        .modelId,
    ).toBe('local');
  });
});
