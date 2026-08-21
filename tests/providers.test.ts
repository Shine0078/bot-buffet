import { describe, expect, it } from 'vitest';
import { adapterFor, localDiscoveryCandidates, resolveProviderToken } from '../src/providers.js';
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
  it('resolves environment credentials at use time without falling back to vault data', () => {
    const previous = process.env.BOT_BUFFET_PROVIDER_TEST_TOKEN;
    process.env.BOT_BUFFET_PROVIDER_TEST_TOKEN = 'runtime-secret';
    try {
      expect(
        resolveProviderToken(
          {
            ...provider('openai'),
            credentialSource: {
              authType: 'env',
              environmentVariable: 'BOT_BUFFET_PROVIDER_TEST_TOKEN',
            },
          },
          'stale-vault-secret',
        ),
      ).toBe('runtime-secret');
      expect(() =>
        resolveProviderToken(
          {
            ...provider('openai'),
            credentialSource: { authType: 'env', environmentVariable: 'NOT-VALID' },
          },
          'vault-secret',
        ),
      ).toThrow('provider_environment_variable_invalid');
    } finally {
      if (previous === undefined) delete process.env.BOT_BUFFET_PROVIDER_TEST_TOKEN;
      else process.env.BOT_BUFFET_PROVIDER_TEST_TOKEN = previous;
    }
  });

  it('uses provider-specific wire adapters when semantics differ', () => {
    expect(adapterFor(provider('anthropic'), 'token').constructor.name).toBe('AnthropicAdapter');
    expect(adapterFor(provider('gemini'), 'token').constructor.name).toBe('GeminiAdapter');
    expect(adapterFor(provider('cohere'), 'token').constructor.name).toBe('CohereAdapter');
    expect(adapterFor(provider('openai'), 'token').constructor.name).toBe(
      'OpenAICompatibleAdapter',
    );
    expect(adapterFor(provider('azure-openai'), 'token').constructor.name).toBe(
      'AzureOpenAIAdapter',
    );
    expect(
      adapterFor(
        { ...provider('bedrock'), endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com' },
        JSON.stringify({
          accessKeyId: 'AKIAEXAMPLE',
          secretAccessKey: 'secret',
          region: 'us-east-1',
        }),
      ).constructor.name,
    ).toBe('BedrockAdapter');
  });

  it('discovers all supported local OpenAI-compatible runtimes', () => {
    expect(localDiscoveryCandidates()).toEqual(
      expect.arrayContaining([
        ['ollama', 'http://127.0.0.1:11434/v1'],
        ['lmstudio', 'http://127.0.0.1:1234/v1'],
        ['llamacpp', 'http://127.0.0.1:8080/v1'],
        ['localai', 'http://127.0.0.1:8080/v1'],
        ['vllm', 'http://127.0.0.1:8000/v1'],
        ['jan', 'http://127.0.0.1:1337/v1'],
      ]),
    );
  });
});
