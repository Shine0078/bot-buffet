import { ModelProvider, CapabilitySet, ProviderKind, now } from './types.js';
import { assertSafeEndpoint, assertSafeEndpointResolved, redactSecrets } from './security.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
  responseFormat?: 'text' | 'json';
  signal?: AbortSignal;
}
export interface ModelResponse {
  id: string;
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  raw?: unknown;
}

export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>;
  health(): Promise<'healthy' | 'degraded' | 'offline'>;
  listModels(): Promise<string[]>;
}

const capabilityDefaults: CapabilitySet = {
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  vision: false,
  audio: false,
  embeddings: false,
  reranking: false,
  contextTokens: 8192,
  outputTokens: 2048,
};

export class OpenAICompatibleAdapter implements ModelAdapter {
  constructor(
    private readonly provider: ModelProvider,
    private readonly token?: string,
  ) {
    assertSafeEndpoint(
      provider.endpoint,
      ['ollama', 'lmstudio', 'llamacpp', 'localai', 'vllm', 'jan'].includes(provider.providerKind),
    );
  }
  private localEndpoint(): boolean {
    return ['ollama', 'lmstudio', 'llamacpp', 'localai', 'vllm', 'jan'].includes(
      this.provider.providerKind,
    );
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    const endpoint = await assertSafeEndpointResolved(this.provider.endpoint, this.localEndpoint());
    const response = await fetch(`${endpoint.toString().replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      redirect: 'error',
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        tools: request.tools,
        response_format: request.responseFormat === 'json' ? { type: 'json_object' } : undefined,
      }),
      signal,
    });
    if (!response.ok)
      throw new Error(
        `provider_error:${response.status}:${String(redactSecrets(await response.text()))}`,
      );
    const data = (await response.json()) as {
      id?: string;
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = data.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
    }));
    return {
      id: data.id ?? `response_${Date.now()}`,
      content: message?.content ?? '',
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
      raw: redactSecrets(data),
    };
  }
  async health(): Promise<'healthy' | 'degraded' | 'offline'> {
    try {
      const endpoint = await assertSafeEndpointResolved(
        this.provider.endpoint,
        this.localEndpoint(),
      );
      const result = await fetch(`${endpoint.toString().replace(/\/$/, '')}/models`, {
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
      return result.ok ? 'healthy' : 'degraded';
    } catch {
      return 'offline';
    }
  }
  async listModels(): Promise<string[]> {
    try {
      const endpoint = await assertSafeEndpointResolved(
        this.provider.endpoint,
        this.localEndpoint(),
      );
      const response = await fetch(`${endpoint.toString().replace(/\/$/, '')}/models`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: Array<{ id: string }> };
      return data.data?.map((x) => x.id) ?? [];
    } catch {
      return [];
    }
  }
}

const providerSignal = (request: ModelRequest): AbortSignal =>
  request.signal
    ? AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);

export class AnthropicAdapter implements ModelAdapter {
  constructor(
    private readonly provider: ModelProvider,
    private readonly token?: string,
  ) {
    assertSafeEndpoint(provider.endpoint);
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const endpoint = await assertSafeEndpointResolved(this.provider.endpoint);
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      }));
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const response = await fetch(`${endpoint.toString().replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(this.token ? { 'x-api-key': this.token } : {}),
      },
      redirect: 'error',
      body: JSON.stringify({
        model: request.model,
        system: system || undefined,
        messages,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature,
      }),
      signal: providerSignal(request),
    });
    if (!response.ok)
      throw new Error(
        `provider_error:${response.status}:${String(redactSecrets(await response.text()))}`,
      );
    const data = (await response.json()) as {
      id?: string;
      content?: Array<{
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      id: data.id ?? `anthropic_${Date.now()}`,
      content:
        data.content
          ?.filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('') ?? '',
      toolCalls: (data.content ?? [])
        .filter((part) => part.type === 'tool_use' && part.id && part.name)
        .map((part) => ({ id: part.id!, name: part.name!, arguments: part.input ?? {} })),
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
      raw: redactSecrets(data),
    };
  }
  async health(): Promise<'healthy' | 'degraded' | 'offline'> {
    try {
      const endpoint = await assertSafeEndpointResolved(this.provider.endpoint);
      const response = await fetch(`${endpoint.toString().replace(/\/$/, '')}/v1/models`, {
        headers: this.token ? { 'x-api-key': this.token } : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
      return response.ok ? 'healthy' : 'degraded';
    } catch {
      return 'offline';
    }
  }
  async listModels(): Promise<string[]> {
    try {
      const endpoint = await assertSafeEndpointResolved(this.provider.endpoint);
      const response = await fetch(`${endpoint.toString().replace(/\/$/, '')}/v1/models`, {
        headers: this.token ? { 'x-api-key': this.token } : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      return data.data?.flatMap((model) => (model.id ? [model.id] : [])) ?? [];
    } catch {
      return [];
    }
  }
}

export class GeminiAdapter implements ModelAdapter {
  constructor(
    private readonly provider: ModelProvider,
    private readonly token?: string,
  ) {
    assertSafeEndpoint(provider.endpoint);
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const endpoint = await assertSafeEndpointResolved(this.provider.endpoint);
    const system = request.messages.find((message) => message.role === 'system')?.content;
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));
    const response = await fetch(
      `${endpoint.toString().replace(/\/$/, '')}/models/${encodeURIComponent(request.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { 'x-goog-api-key': this.token } : {}),
        },
        redirect: 'error',
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents,
          generationConfig: {
            maxOutputTokens: request.maxTokens,
            temperature: request.temperature,
            responseMimeType: request.responseFormat === 'json' ? 'application/json' : undefined,
          },
        }),
        signal: providerSignal(request),
      },
    );
    if (!response.ok)
      throw new Error(
        `provider_error:${response.status}:${String(redactSecrets(await response.text()))}`,
      );
    const data = (await response.json()) as {
      responseId?: string;
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name: string; args?: Record<string, unknown> };
          }>;
        };
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    return {
      id: data.responseId ?? `gemini_${Date.now()}`,
      content: parts.map((part) => part.text ?? '').join(''),
      toolCalls: parts.flatMap((part, index) =>
        part.functionCall
          ? [
              {
                id: `gemini_tool_${index}`,
                name: part.functionCall.name,
                arguments: part.functionCall.args ?? {},
              },
            ]
          : [],
      ),
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      latencyMs: Date.now() - started,
      raw: redactSecrets(data),
    };
  }
  async health(): Promise<'healthy' | 'degraded' | 'offline'> {
    try {
      await assertSafeEndpointResolved(this.provider.endpoint);
      return 'healthy';
    } catch {
      return 'offline';
    }
  }
  async listModels(): Promise<string[]> {
    return [];
  }
}

export class MockLocalAdapter implements ModelAdapter {
  constructor(private readonly name: string) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const last = request.messages.at(-1)?.content ?? '';
    const content =
      request.responseFormat === 'json'
        ? JSON.stringify({
            type: 'message',
            text: `Local model ${this.name}: ${last.slice(0, 300)}`,
          })
        : `Local model ${this.name}: ${last.slice(0, 300)}`;
    return {
      id: `local_${Date.now()}`,
      content,
      toolCalls: [],
      usage: {
        inputTokens: Math.ceil(last.length / 4),
        outputTokens: Math.ceil(content.length / 4),
      },
      latencyMs: 1,
    };
  }
  async health(): Promise<'healthy' | 'degraded' | 'offline'> {
    return 'healthy';
  }
  async listModels(): Promise<string[]> {
    return [this.name];
  }
}

export const adapterFor = (provider: ModelProvider, token?: string): ModelAdapter => {
  if (provider.providerKind === 'anthropic') return new AnthropicAdapter(provider, token);
  if (provider.providerKind === 'gemini') return new GeminiAdapter(provider, token);
  return new OpenAICompatibleAdapter(provider, token);
};

export interface LocalDiscoveryResult {
  providerKind: ProviderKind;
  endpoint: string;
  reachable: boolean;
  models: string[];
}
export async function discoverLocalEndpoints(): Promise<LocalDiscoveryResult[]> {
  const candidates: Array<[ProviderKind, string]> = [
    ['ollama', 'http://127.0.0.1:11434/v1'],
    ['lmstudio', 'http://127.0.0.1:1234/v1'],
    ['localai', 'http://127.0.0.1:8080/v1'],
    ['llamacpp', 'http://127.0.0.1:8080/v1'],
  ];
  return Promise.all(
    candidates.map(async ([providerKind, endpoint]) => {
      const provider: ModelProvider = {
        id: 'discovery',
        kind: 'model-provider',
        ownerId: 'system',
        scope: 'system',
        version: 1,
        createdAt: now(),
        updatedAt: now(),
        accessPolicy: { visibility: 'organization', roles: {} },
        name: providerKind,
        providerKind,
        endpoint,
        enabled: true,
        health: 'unknown',
        capabilities: capabilityDefaults,
      };
      const adapter = new OpenAICompatibleAdapter(provider);
      const models = await adapter.listModels();
      return { providerKind, endpoint, reachable: models.length > 0, models };
    }),
  );
}

export const defaultCapabilities = (): CapabilitySet => ({ ...capabilityDefaults });
