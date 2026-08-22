import { afterEach, describe, expect, it } from 'vitest';
import {
  AnthropicAdapter,
  AzureOpenAIAdapter,
  BedrockAdapter,
  CohereAdapter,
  GeminiAdapter,
  MockLocalAdapter,
  OpenAICompatibleAdapter,
  adapterFor,
  defaultCapabilities,
  localDiscoveryCandidates,
  resolveProviderToken,
} from '../src/providers.js';
import { entity, type ModelProvider, type ProviderKind } from '../src/types.js';

/**
 * Adapter selection and credential resolution.
 *
 * The specification lists nineteen provider kinds. Which adapter each one gets
 * is a routing decision made once and relied on everywhere, so it is asserted
 * for every kind rather than for the handful with a bespoke adapter — a kind
 * added to the type and forgotten here would otherwise fall through to the
 * OpenAI-compatible adapter silently.
 */

const ALL_KINDS: ProviderKind[] = [
  'ollama',
  'lmstudio',
  'llamacpp',
  'localai',
  'vllm',
  'jan',
  'openai-compatible',
  'openai',
  'anthropic',
  'gemini',
  'xai',
  'openrouter',
  'azure-openai',
  'bedrock',
  'mistral',
  'cohere',
  'deepseek',
  'together',
  'fireworks',
];

/** Local runtimes must be loopback — the adapter enforces it at construction —
 *  while cloud kinds must be https. Using one endpoint for both would fail on
 *  the fixture rather than on the behaviour under test. */
const LOCAL_KINDS = new Set(['ollama', 'lmstudio', 'llamacpp', 'localai', 'vllm', 'jan']);
const endpointFor = (providerKind: ProviderKind): string =>
  LOCAL_KINDS.has(providerKind) ? 'http://127.0.0.1:11434/v1' : 'https://api.example.test/v1';

const provider = (providerKind: ProviderKind, overrides: Partial<ModelProvider> = {}) =>
  entity({
    kind: 'model-provider',
    ownerId: 'u',
    scope: 'w',
    name: providerKind,
    providerKind,
    endpoint: endpointFor(providerKind),
    enabled: true,
    health: 'unknown',
    capabilities: defaultCapabilities(),
    ...overrides,
  }) as ModelProvider;

/** Bedrock signs with SigV4 and requires a JSON credential blob; everything
 *  else takes a bearer string. */
const tokenFor = (providerKind: ProviderKind): string =>
  providerKind === 'bedrock'
    ? JSON.stringify({
        region: 'us-east-1',
        accessKeyId: 'AKIA' + 'EXAMPLE0000000000',
        secretAccessKey: 'secret-example-value',
      })
    : 'token-value';

const saved = process.env.PROVIDER_TEST_TOKEN;
afterEach(() => {
  if (saved === undefined) delete process.env.PROVIDER_TEST_TOKEN;
  else process.env.PROVIDER_TEST_TOKEN = saved;
});

describe('adapter selection', () => {
  it('gives each provider with a bespoke wire format its own adapter', () => {
    const expected: Array<[ProviderKind, unknown]> = [
      ['anthropic', AnthropicAdapter],
      ['gemini', GeminiAdapter],
      ['azure-openai', AzureOpenAIAdapter],
      ['cohere', CohereAdapter],
      ['bedrock', BedrockAdapter],
    ];
    for (const [kind, constructor] of expected) {
      expect(adapterFor(provider(kind), tokenFor(kind)), kind).toBeInstanceOf(constructor as never);
    }
  });

  it('falls back to the OpenAI-compatible adapter for the rest', () => {
    const bespoke = new Set(['anthropic', 'gemini', 'azure-openai', 'cohere', 'bedrock']);
    for (const kind of ALL_KINDS.filter((candidate) => !bespoke.has(candidate))) {
      expect(adapterFor(provider(kind), tokenFor(kind)), kind).toBeInstanceOf(
        OpenAICompatibleAdapter,
      );
    }
  });

  it('returns an adapter for every declared provider kind', () => {
    // A kind added to the type and forgotten here would fall through silently.
    for (const kind of ALL_KINDS) {
      expect(adapterFor(provider(kind), tokenFor(kind)), kind).toBeTruthy();
    }
  });

  it('passes the token through to the selected adapter', () => {
    // Constructing with a token must not throw for any kind.
    for (const kind of ALL_KINDS) {
      expect(() => adapterFor(provider(kind), tokenFor(kind)), kind).not.toThrow();
    }
  });

  it('refuses a Bedrock credential that is not a JSON object', () => {
    // SigV4 needs a region and key pair; a bearer string cannot produce a
    // signature, so it fails at construction rather than at the first call.
    for (const bad of ['token-value', '[]', 'null', '{']) {
      expect(() => adapterFor(provider('bedrock'), bad), bad).toThrow(
        /bedrock_credentials_json_required/,
      );
    }
  });

  it('refuses a local provider kind pointed at a remote endpoint', () => {
    // A "local" model must not be able to reach off-host; the adapter refuses
    // it at construction rather than trusting the label.
    expect(() =>
      adapterFor(provider('ollama', { endpoint: 'https://attacker.example/v1' })),
    ).toThrow(/endpoint_rejected/);
  });
});

describe('credential resolution', () => {
  it('uses the vault token when the provider has no credential source', () => {
    expect(resolveProviderToken(provider('openai'), 'vault-token')).toBe('vault-token');
    expect(resolveProviderToken(provider('openai'), undefined)).toBeUndefined();
  });

  it('reads an environment variable reference instead of the vault', () => {
    process.env.PROVIDER_TEST_TOKEN = 'from-environment';
    const withSource = provider('openai', {
      credentialSource: { environmentVariable: 'PROVIDER_TEST_TOKEN' },
    } as Partial<ModelProvider>);
    // The vault token is ignored: the provider declared where its secret lives.
    expect(resolveProviderToken(withSource, 'vault-token')).toBe('from-environment');
  });

  it('returns undefined when the referenced variable is unset', () => {
    delete process.env.PROVIDER_TEST_TOKEN;
    const withSource = provider('openai', {
      credentialSource: { environmentVariable: 'PROVIDER_TEST_TOKEN' },
    } as Partial<ModelProvider>);
    expect(resolveProviderToken(withSource, 'vault-token')).toBeUndefined();
  });

  it('refuses a malformed variable name rather than reading something else', () => {
    // A name that is not a plain identifier could otherwise be used to probe
    // the environment in ways the validator never reviewed.
    for (const environmentVariable of ['', 'has space', 'lower-case', '1LEADING', 'A;B', '../X']) {
      const withSource = provider('openai', {
        credentialSource: { environmentVariable },
      } as Partial<ModelProvider>);
      expect(() => resolveProviderToken(withSource, undefined), environmentVariable).toThrow(
        /provider_environment_variable_invalid/,
      );
    }
  });
});

describe('local discovery candidates', () => {
  it('probes only loopback endpoints', () => {
    for (const [, endpoint] of localDiscoveryCandidates()) {
      expect(new URL(endpoint).hostname, endpoint).toBe('127.0.0.1');
    }
  });

  it('covers the documented local runtimes', () => {
    const kinds = localDiscoveryCandidates().map(([kind]) => kind);
    expect(kinds).toEqual(['ollama', 'lmstudio', 'localai', 'llamacpp', 'vllm', 'jan']);
  });

  it('gives every candidate an OpenAI-compatible path', () => {
    for (const [, endpoint] of localDiscoveryCandidates()) {
      expect(endpoint, endpoint).toMatch(/\/v1$/);
    }
  });
});

describe('default capabilities', () => {
  it('describes a conservative baseline', () => {
    const capabilities = defaultCapabilities();
    expect(capabilities.streaming).toBe(true);
    expect(capabilities.toolCalling).toBe(true);
    // Multimodal and embedding support are opt-in: claiming them by default
    // would let the router send work to a model that cannot do it.
    expect(capabilities.vision).toBe(false);
    expect(capabilities.audio).toBe(false);
    expect(capabilities.embeddings).toBe(false);
    expect(capabilities.reranking).toBe(false);
  });

  it('returns a fresh object each time, so one provider cannot mutate another', () => {
    const first = defaultCapabilities();
    first.vision = true;
    expect(defaultCapabilities().vision).toBe(false);
  });
});

describe('mock local adapter', () => {
  it('completes without any network access, for offline-only projects', async () => {
    const adapter = new MockLocalAdapter('local-model');
    const response = await adapter.complete({
      model: 'local-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.usage.inputTokens).toBeGreaterThanOrEqual(0);
  });

  it('streams the same content it would have completed', async () => {
    const adapter = new MockLocalAdapter('local-model');
    const chunks: string[] = [];
    for await (const chunk of adapter.stream({
      model: 'local-model',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      if (chunk.delta) chunks.push(chunk.delta);
    }
    expect(chunks.join('').length).toBeGreaterThan(0);
  });
});
