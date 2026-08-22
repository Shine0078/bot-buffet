import { describe, expect, it } from 'vitest';
import {
  LOCAL_CONFIG_VERSION,
  containsSecretField,
  exportLocalConfig,
  parseLocalConfig,
} from '../src/localModelConfig.js';
import { entity, type Model, type ModelProvider } from '../src/types.js';

const SUPPORTED = new Set(['ollama', 'lmstudio', 'localai', 'llamacpp', 'vllm', 'jan']);
const isSupportedKind = (kind: string) => SUPPORTED.has(kind);
const isLocalEndpoint = (endpoint: string) => {
  try {
    const url = new URL(endpoint);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
    );
  } catch {
    return false;
  }
};

const provider = (overrides: Partial<ModelProvider> = {}): ModelProvider =>
  entity({
    kind: 'model-provider',
    ownerId: 'user',
    scope: 'workspace_local',
    name: 'ollama local',
    providerKind: 'ollama',
    endpoint: 'http://127.0.0.1:11434/v1',
    enabled: true,
    health: 'unknown',
    capabilities: {},
    ...overrides,
  }) as ModelProvider;

const model = (providerId: string, overrides: Partial<Model> = {}): Model =>
  entity({
    kind: 'model',
    ownerId: 'user',
    scope: 'workspace_local',
    providerId,
    name: 'llama-3-8b',
    modelName: 'llama-3-8b',
    local: true,
    capabilities: {},
    inputCostPerMillionCents: 0,
    outputCostPerMillionCents: 0,
    available: true,
    ...overrides,
  }) as Model;

describe('local model configuration export', () => {
  it('exports providers and their local models in a versioned document', () => {
    const p = provider();
    const doc = exportLocalConfig([p], [model(p.id)], () => '2026-08-22T00:00:00.000Z');
    expect(doc.version).toBe(LOCAL_CONFIG_VERSION);
    expect(doc.exportedAt).toBe('2026-08-22T00:00:00.000Z');
    expect(doc.providers).toEqual([
      { providerKind: 'ollama', name: 'ollama local', endpoint: 'http://127.0.0.1:11434/v1' },
    ]);
    expect(doc.models[0]).toMatchObject({
      providerKind: 'ollama',
      endpoint: 'http://127.0.0.1:11434/v1',
      modelName: 'llama-3-8b',
    });
  });

  it('carries no credential material, even for fields added to the entity later', () => {
    // The exporter builds each entry from an explicit field list rather than a
    // spread, so a future secret-bearing field cannot leak in by default.
    const p = provider({
      apiKeyRef: 'vault:provider:secret',
      authType: 'env',
      envVar: 'OLLAMA_TOKEN',
    } as Partial<ModelProvider>);
    const doc = exportLocalConfig([p], [model(p.id)]);
    expect(containsSecretField(doc)).toBeNull();
    expect(JSON.stringify(doc)).not.toContain('vault:');
    expect(JSON.stringify(doc)).not.toContain('OLLAMA_TOKEN');
  });

  it('omits cloud models and models whose provider is not exported', () => {
    const p = provider();
    const orphan = model('provider_that_is_not_exported');
    const cloud = model(p.id, { local: false });
    const doc = exportLocalConfig([p], [model(p.id), orphan, cloud]);
    expect(doc.models).toHaveLength(1);
  });

  it('detects a secret field wherever it is nested', () => {
    expect(containsSecretField({ a: { b: { apiKey: 'x' } } })).toBe('a.b.apiKey');
    expect(containsSecretField({ a: { b: 1 } })).toBeNull();
    expect(containsSecretField(null)).toBeNull();
  });
});

describe('local model configuration import', () => {
  const valid = {
    version: LOCAL_CONFIG_VERSION,
    exportedAt: '2026-08-22T00:00:00.000Z',
    providers: [
      { providerKind: 'ollama', name: 'ollama local', endpoint: 'http://127.0.0.1:11434/v1' },
    ],
    models: [
      {
        providerKind: 'ollama',
        endpoint: 'http://127.0.0.1:11434/v1',
        modelName: 'llama-3-8b',
        name: 'Llama 3 8B',
      },
    ],
  };

  const parse = (input: unknown) => parseLocalConfig(input, isSupportedKind, isLocalEndpoint);

  it('accepts a well-formed document', () => {
    const result = parse(valid);
    expect(result.ok).toBe(true);
    expect(result.providers).toHaveLength(1);
    expect(result.models).toHaveLength(1);
  });

  it('refuses an unknown version rather than importing it optimistically', () => {
    for (const version of [2, 0, '1', undefined, null]) {
      const result = parse({ ...valid, version });
      expect(result.ok).toBe(false);
      expect(result.rejections[0]?.reason).toBe('config_version_unsupported');
    }
  });

  it('refuses input that is not a configuration document at all', () => {
    for (const bad of [null, undefined, 'a string', 42, [], { version: 1 }]) {
      expect(parse(bad).ok).toBe(false);
    }
  });

  it('refuses a remote endpoint, which would make a local import reach outbound', () => {
    const result = parse({
      ...valid,
      providers: [
        { providerKind: 'ollama', name: 'evil', endpoint: 'https://attacker.example/v1' },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.rejections.map((r) => r.reason)).toContain('endpoint_not_local');
    expect(result.providers).toHaveLength(0);
  });

  it('refuses an unsupported provider kind', () => {
    const result = parse({
      ...valid,
      providers: [{ providerKind: 'openai', name: 'x', endpoint: 'http://127.0.0.1:11434/v1' }],
    });
    expect(result.rejections.map((r) => r.reason)).toContain('provider_kind_unsupported');
  });

  it('never invents a provider for an orphaned model', () => {
    const result = parse({
      ...valid,
      models: [
        {
          providerKind: 'ollama',
          endpoint: 'http://127.0.0.1:9999/v1',
          modelName: 'ghost',
          name: 'ghost',
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.rejections.map((r) => r.reason)).toContain('provider_missing_for_model');
    expect(result.models).toHaveLength(0);
  });

  it('drops a model with no usable name', () => {
    const result = parse({ ...valid, models: [{ ...valid.models[0], modelName: '   ' }] });
    expect(result.rejections.map((r) => r.reason)).toContain('model_name_missing');
  });

  it('treats a digest in a configuration file as a claim, not as verification', () => {
    const result = parse({
      ...valid,
      models: [{ ...valid.models[0], artifactSha256: 'A'.repeat(64) }],
    });
    // Carried for reference, normalised, and never marks the artifact verified.
    expect(result.models[0]?.artifactSha256).toBe('a'.repeat(64));
    expect(result.models[0]).not.toHaveProperty('artifactVerifiedAt');
  });

  it('ignores a malformed digest instead of storing it', () => {
    const result = parse({
      ...valid,
      models: [{ ...valid.models[0], artifactSha256: 'not-a-digest' }],
    });
    expect(result.models[0]?.artifactSha256).toBeUndefined();
  });

  it('bounds free-text metadata carried in from an untrusted file', () => {
    const result = parse({
      ...valid,
      models: [
        {
          ...valid.models[0],
          name: 'n'.repeat(500),
          quantization: 'q'.repeat(500),
          license: 'l'.repeat(500),
        },
      ],
    });
    expect(result.models[0]?.name).toHaveLength(200);
    expect(result.models[0]?.quantization).toHaveLength(64);
    expect(result.models[0]?.license).toHaveLength(64);
  });

  it('rejects a fractional or non-numeric size rather than storing it', () => {
    for (const sizeBytes of [1.5, '100', null]) {
      const result = parse({ ...valid, models: [{ ...valid.models[0], sizeBytes }] });
      expect(result.models[0]?.sizeBytes).toBeUndefined();
    }
  });

  it('round-trips an export through the importer', () => {
    const p = provider();
    const doc = exportLocalConfig([p], [model(p.id)]);
    const result = parse(JSON.parse(JSON.stringify(doc)));
    expect(result.ok).toBe(true);
    expect(result.models[0]?.modelName).toBe('llama-3-8b');
  });
});
