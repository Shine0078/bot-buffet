import { describe, expect, it } from 'vitest';
import { adapterFor } from '../src/providers.js';
import { ModelProvider, now } from '../src/types.js';

const provider = (providerKind: ModelProvider['providerKind']): ModelProvider => ({
  id: `provider-${providerKind}`,
  kind: 'model-provider',
  ownerId: 'u',
  scope: 'w',
  version: 1,
  createdAt: now(),
  updatedAt: now(),
  accessPolicy: { visibility: 'workspace', roles: {} },
  name: providerKind,
  providerKind,
  endpoint:
    providerKind === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta'
      : `https://api.${providerKind}.example`,
  enabled: true,
  health: 'unknown',
  capabilities: {
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embeddings: false,
    reranking: false,
  },
});

describe('provider adapter normalization', () => {
  it('uses provider-specific wire adapters when semantics differ', () => {
    expect(adapterFor(provider('anthropic'), 'token').constructor.name).toBe('AnthropicAdapter');
    expect(adapterFor(provider('gemini'), 'token').constructor.name).toBe('GeminiAdapter');
    expect(adapterFor(provider('openai'), 'token').constructor.name).toBe(
      'OpenAICompatibleAdapter',
    );
  });
});
