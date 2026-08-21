import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelProvider, now } from '../src/types.js';

const fetchPinned = vi.hoisted(() => vi.fn());
vi.mock('../src/egress.js', () => ({ fetchPinned }));

const { AzureOpenAIAdapter, BedrockAdapter, CohereAdapter, OpenAICompatibleAdapter } =
  await import('../src/providers.js');

const provider: ModelProvider = {
  id: 'provider-cohere',
  kind: 'model-provider',
  ownerId: 'u',
  scope: 'w',
  version: 1,
  createdAt: now(),
  updatedAt: now(),
  accessPolicy: { visibility: 'workspace', roles: {} },
  name: 'cohere',
  providerKind: 'cohere',
  endpoint: 'https://api.cohere.com',
  enabled: true,
  health: 'unknown',
  capabilities: {
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embeddings: true,
    reranking: true,
  },
};

describe('native Cohere adapter', () => {
  beforeEach(() => fetchPinned.mockReset());

  it('uses the v2 chat contract and normalizes tool calls and usage', async () => {
    fetchPinned.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'cohere-response',
          message: {
            content: [{ type: 'text', text: 'Hello' }],
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"city":"Toronto"}' },
              },
            ],
          },
          usage: { tokens: { input_tokens: 12, output_tokens: 7 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const adapter = new CohereAdapter(provider, 'cohere-secret');
    const response = await adapter.complete({
      model: 'command-a',
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'Hi' },
        { role: 'tool', content: 'result', toolCallId: 'call-1' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      responseFormat: 'json',
      maxTokens: 64,
      temperature: 0.2,
    });

    expect(fetchPinned).toHaveBeenCalledTimes(1);
    const [url, init] = fetchPinned.mock.calls[0] as [string, RequestInit, boolean?];
    expect(url).toBe('https://api.cohere.com/v2/chat');
    expect(init.headers).toMatchObject({ authorization: 'Bearer cohere-secret' });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.response_format).toBeUndefined();
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Hi' },
      { role: 'tool', content: 'result', tool_call_id: 'call-1' },
    ]);
    expect(response).toMatchObject({
      id: 'cohere-response',
      content: 'Hello',
      toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { city: 'Toronto' } }],
      usage: { inputTokens: 12, outputTokens: 7 },
    });
  });

  it('fails closed on malformed tool arguments', async () => {
    fetchPinned.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'bad-response',
          message: {
            tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{not-json' } }],
          },
        }),
        { status: 200 },
      ),
    );
    await expect(
      new CohereAdapter(provider, 'token').complete({ model: 'command-a', messages: [] }),
    ).rejects.toThrow('provider_tool_arguments_invalid');
  });

  it('normalizes the native model list and health probe', async () => {
    fetchPinned
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [{ name: 'command-a' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [{ name: 'command-a' }, { id: 'embed-v4' }] }), {
          status: 200,
        }),
      );
    const adapter = new CohereAdapter(provider, 'token');
    await expect(adapter.health()).resolves.toBe('healthy');
    await expect(adapter.listModels()).resolves.toEqual(['command-a', 'embed-v4']);
    expect(fetchPinned.mock.calls[0]?.[0]).toBe('https://api.cohere.com/v1/models');
    expect(fetchPinned.mock.calls[1]?.[0]).toBe('https://api.cohere.com/v1/models');
  });

  it('normalizes Cohere embeddings', async () => {
    fetchPinned.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: 'embed-v4',
          embeddings: [
            [0.1, 0.2],
            [0.3, 0.4],
          ],
          usage: { billed_units: { input_tokens: 8 } },
        }),
        { status: 200 },
      ),
    );
    const response = await new CohereAdapter(provider, 'token').embed!({
      model: 'embed-v4',
      input: ['one', 'two'],
    });
    expect(response).toMatchObject({
      model: 'embed-v4',
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      usage: { inputTokens: 8, outputTokens: 0 },
    });
    expect(fetchPinned.mock.calls[0]?.[0]).toBe('https://api.cohere.com/v2/embed');
  });
});

describe('normalized OpenAI-compatible capabilities', () => {
  beforeEach(() => fetchPinned.mockReset());

  it('parses streaming SSE chunks and emits a terminal usage chunk', async () => {
    fetchPinned.mockResolvedValueOnce(
      new Response(
        [
          'data: {"id":"stream-1","choices":[{"delta":{"content":"Hel"}}]}',
          'data: {"id":"stream-1","choices":[{"delta":{"content":"lo"}}]}',
          'data: {"id":"stream-1","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}',
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const adapter = new OpenAICompatibleAdapter(
      { ...provider, providerKind: 'openai', endpoint: 'https://api.openai.com/v1' },
      'token',
    );
    const chunks = [];
    for await (const chunk of adapter.stream({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'Hi' }],
    }))
      chunks.push(chunk);
    expect(chunks).toEqual([
      { id: 'stream-1', delta: 'Hel', done: false },
      { id: 'stream-1', delta: 'lo', done: false },
      {
        id: 'stream-1',
        delta: '',
        done: true,
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    ]);
    expect(
      JSON.parse(String((fetchPinned.mock.calls[0] as [string, RequestInit])[1].body)),
    ).toMatchObject({
      stream: true,
      model: 'gpt-test',
    });
  });

  it('normalizes embeddings and rejects malformed vectors', async () => {
    fetchPinned.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: 'embed-test',
          data: [{ embedding: [0.5, -0.25] }],
          usage: { prompt_tokens: 3 },
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatibleAdapter(
      { ...provider, providerKind: 'openai', endpoint: 'https://api.openai.com/v1' },
      'token',
    );
    await expect(adapter.embed!({ model: 'embed-test', input: 'hello' })).resolves.toMatchObject({
      model: 'embed-test',
      embeddings: [[0.5, -0.25]],
      usage: { inputTokens: 3, outputTokens: 0 },
    });
    fetchPinned.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: ['x'] }] }), { status: 200 }),
    );
    await expect(adapter.embed!({ model: 'embed-test', input: 'bad' })).rejects.toThrow(
      'provider_embedding_invalid',
    );
  });

  it('provides bounded normalized batching through the adapter contract', async () => {
    fetchPinned
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: 'one' } }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'r2', choices: [{ message: { content: 'two' } }] }), {
          status: 200,
        }),
      );
    const adapter = new OpenAICompatibleAdapter(
      { ...provider, providerKind: 'openai', endpoint: 'https://api.openai.com/v1' },
      'token',
    );
    await expect(
      adapter.batch!([
        { model: 'gpt-test', messages: [{ role: 'user', content: 'one' }] },
        { model: 'gpt-test', messages: [{ role: 'user', content: 'two' }] },
      ]),
    ).resolves.toMatchObject([{ content: 'one' }, { content: 'two' }]);
    await expect(
      adapter.batch!(Array.from({ length: 33 }, () => ({ model: 'gpt-test', messages: [] }))),
    ).rejects.toThrow('provider_batch_too_large');
  });
});

describe('provider-specific authenticated adapters', () => {
  beforeEach(() => fetchPinned.mockReset());

  it('uses Azure deployment paths and api-key authentication', async () => {
    fetchPinned.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'azure-response',
          choices: [{ message: { content: 'Hello' } }],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        }),
        { status: 200 },
      ),
    );
    const azure = new AzureOpenAIAdapter(
      {
        ...provider,
        providerKind: 'azure-openai',
        endpoint: 'https://resource.openai.azure.com?api-version=2024-10-21',
      },
      'azure-secret',
    );
    await expect(
      azure.complete({ model: 'deployment-1', messages: [{ role: 'user', content: 'Hi' }] }),
    ).resolves.toMatchObject({
      id: 'azure-response',
      content: 'Hello',
      usage: { inputTokens: 4, outputTokens: 3 },
    });
    const [url, init] = fetchPinned.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://resource.openai.azure.com/openai/deployments/deployment-1/chat/completions?api-version=2024-10-21',
    );
    expect(init.headers).toMatchObject({ 'api-key': 'azure-secret' });
  });

  it('signs Bedrock Converse requests and normalizes tool use', async () => {
    fetchPinned.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            message: {
              content: [
                { text: 'I will look that up.' },
                { toolUse: { toolUseId: 'tool-1', name: 'lookup', input: { city: 'Toronto' } } },
              ],
            },
          },
          usage: { inputTokens: 11, outputTokens: 9 },
        }),
        { status: 200 },
      ),
    );
    const bedrock = new BedrockAdapter(
      {
        ...provider,
        providerKind: 'bedrock',
        endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      },
      JSON.stringify({
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret',
        region: 'us-east-1',
      }),
    );
    const response = await bedrock.complete({
      model: 'anthropic.claude-3-sonnet-20240229-v1:0',
      messages: [{ role: 'user', content: 'Find Toronto weather' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      maxTokens: 100,
    });
    expect(response).toMatchObject({
      content: 'I will look that up.',
      toolCalls: [{ id: 'tool-1', name: 'lookup', arguments: { city: 'Toronto' } }],
      usage: { inputTokens: 11, outputTokens: 9 },
    });
    const [url, init] = fetchPinned.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-sonnet-20240229-v1%3A0/converse',
    );
    expect(init.headers).toMatchObject({ host: 'bedrock-runtime.us-east-1.amazonaws.com' });
    expect((init.headers as Record<string, string>).authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//,
    );
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.toolConfig).toBeDefined();
  });

  it('uses signed Bedrock control-plane probes for health and models', async () => {
    fetchPinned
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ modelSummaries: [{ modelId: 'model-a' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ modelSummaries: [{ modelId: 'model-a' }, { modelId: 'model-b' }] }),
          { status: 200 },
        ),
      );
    const bedrock = new BedrockAdapter(
      {
        ...provider,
        providerKind: 'bedrock',
        endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      },
      JSON.stringify({
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret',
        region: 'us-east-1',
      }),
    );
    await expect(bedrock.health()).resolves.toBe('healthy');
    await expect(bedrock.listModels()).resolves.toEqual(['model-a', 'model-b']);
    expect(fetchPinned.mock.calls[0]?.[0]).toBe(
      'https://bedrock.us-east-1.amazonaws.com/foundation-models?byOutputModality=TEXT',
    );
  });
});
