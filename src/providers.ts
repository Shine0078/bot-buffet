import { createHash, createHmac } from 'node:crypto';
import { ModelProvider, CapabilitySet, ProviderKind, now } from './types.js';
import { assertSafeEndpoint, redactSecrets } from './security.js';
import { fetchPinned, streamPinned } from './egress.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
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

export interface ModelStreamChunk {
  id: string;
  delta: string;
  toolCalls?: Array<{
    id?: string;
    name?: string;
    arguments?: string;
  }>;
  done: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  signal?: AbortSignal;
}

export interface EmbeddingResponse {
  model: string;
  embeddings: number[][];
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelStreamChunk>;
  embed?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  batch?(requests: readonly ModelRequest[]): Promise<readonly ModelResponse[]>;
  health(): Promise<'healthy' | 'degraded' | 'offline'>;
  listModels(): Promise<string[]>;
}

const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/** Resolve a configured provider credential without persisting environment secrets. */
export const resolveProviderToken = (
  provider: ModelProvider,
  vaultToken: string | undefined,
): string | undefined => {
  const source = provider.credentialSource;
  if (!source) return vaultToken;
  if (!ENVIRONMENT_VARIABLE.test(source.environmentVariable))
    throw new Error('provider_environment_variable_invalid');
  return process.env[source.environmentVariable];
};

const singleResponseStream = async function* (
  response: Promise<ModelResponse>,
): AsyncGenerator<ModelStreamChunk> {
  const result = await response;
  yield {
    id: result.id,
    delta: result.content,
    toolCalls: result.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    })),
    done: false,
  };
  yield { id: result.id, delta: '', done: true, usage: result.usage };
};

const embeddingUsage = (usage: { prompt_tokens?: number; total_tokens?: number } | undefined) => ({
  inputTokens: usage?.prompt_tokens ?? usage?.total_tokens ?? 0,
  outputTokens: 0,
});

const boundedBatch = async (
  complete: (request: ModelRequest) => Promise<ModelResponse>,
  requests: readonly ModelRequest[],
): Promise<readonly ModelResponse[]> => {
  if (requests.length > 32) throw new Error('provider_batch_too_large');
  return Promise.all(requests.map((request) => complete(request)));
};

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
  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    const response = await fetchPinned(
      `${this.provider.endpoint.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: this.headers(),
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
      },
      this.localEndpoint(),
    );
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
  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamChunk> {
    const response = await streamPinned(
      `${this.provider.endpoint.replace(/\/$/u, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { ...this.headers(), accept: 'text/event-stream' },
        redirect: 'error',
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          tools: request.tools,
          response_format: request.responseFormat === 'json' ? { type: 'json_object' } : undefined,
          stream: true,
        }),
        signal: request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      },
      this.localEndpoint(),
    );
    if (response.status < 200 || response.status >= 300)
      throw new Error(`provider_error:${response.status}`);
    const decoder = new TextDecoder();
    let text = '';
    let yielded = false;
    let responseId = `response_${Date.now()}`;
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true });
      const lines = text.split(/\r?\n/u);
      text = lines.pop() ?? '';
      for (const line of lines) {
        const dataLine = line.startsWith('data:') ? line.slice(5).trim() : '';
        if (!dataLine || dataLine === '[DONE]') continue;
        let payload: {
          id?: string;
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          payload = JSON.parse(dataLine) as typeof payload;
        } catch {
          throw new Error('provider_stream_chunk_invalid');
        }
        responseId = payload.id ?? responseId;
        const choice = payload.choices?.[0];
        const delta = choice?.delta?.content ?? '';
        const toolCalls = choice?.delta?.tool_calls?.map((call) => ({
          id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments,
        }));
        if (delta || toolCalls?.length) {
          yielded = true;
          yield {
            id: responseId,
            delta,
            ...(toolCalls?.length ? { toolCalls } : {}),
            done: false,
          };
        }
        if (choice?.finish_reason || payload.usage) {
          yielded = true;
          yield {
            id: responseId,
            delta: '',
            done: true,
            usage: payload.usage
              ? {
                  inputTokens: payload.usage.prompt_tokens ?? 0,
                  outputTokens: payload.usage.completion_tokens ?? 0,
                }
              : undefined,
          };
        }
      }
    }
    text += decoder.decode();
    const trailing = text.trim();
    if (trailing.startsWith('data:')) {
      const dataLine = trailing.slice(5).trim();
      if (dataLine && dataLine !== '[DONE]') {
        let payload: {
          id?: string;
          choices?: Array<{
            delta?: { content?: string };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          payload = JSON.parse(dataLine) as typeof payload;
        } catch {
          throw new Error('provider_stream_chunk_invalid');
        }
        responseId = payload.id ?? responseId;
        const choice = payload.choices?.[0];
        if (choice?.delta?.content || choice?.finish_reason || payload.usage) {
          yielded = true;
          yield {
            id: responseId,
            delta: choice?.delta?.content ?? '',
            done: Boolean(choice?.finish_reason || payload.usage),
            usage: payload.usage
              ? {
                  inputTokens: payload.usage.prompt_tokens ?? 0,
                  outputTokens: payload.usage.completion_tokens ?? 0,
                }
              : undefined,
          };
        }
      }
    }
    if (!yielded) yield { id: responseId, delta: '', done: true };
  }
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const started = Date.now();
    const response = await fetchPinned(
      `${this.provider.endpoint.replace(/\/$/u, '')}/embeddings`,
      {
        method: 'POST',
        headers: this.headers(),
        redirect: 'error',
        body: JSON.stringify({ model: request.model, input: request.input }),
        signal: request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      },
      this.localEndpoint(),
    );
    if (!response.ok)
      throw new Error(
        `provider_error:${response.status}:${String(redactSecrets(await response.text()))}`,
      );
    const data = (await response.json()) as {
      model?: string;
      data?: Array<{ embedding?: unknown }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    const embeddings = (data.data ?? []).map((item) => {
      if (
        !Array.isArray(item.embedding) ||
        item.embedding.some((value) => typeof value !== 'number')
      )
        throw new Error('provider_embedding_invalid');
      return item.embedding as number[];
    });
    if (!embeddings.length) throw new Error('provider_embedding_missing');
    return {
      model: data.model ?? request.model,
      embeddings,
      usage: embeddingUsage(data.usage),
      latencyMs: Date.now() - started,
    };
  }
  batch(requests: readonly ModelRequest[]): Promise<readonly ModelResponse[]> {
    return boundedBatch((request) => this.complete(request), requests);
  }
  async health(): Promise<'healthy' | 'degraded' | 'offline'> {
    try {
      const result = await fetchPinned(
        `${this.provider.endpoint.replace(/\/$/, '')}/models`,
        {
          headers: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
        },
        this.localEndpoint(),
      );
      return result.ok ? 'healthy' : 'degraded';
    } catch {
      return 'offline';
    }
  }
  async listModels(): Promise<string[]> {
    try {
      const response = await fetchPinned(
        `${this.provider.endpoint.replace(/\/$/, '')}/models`,
        {
          headers: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        },
        this.localEndpoint(),
      );
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
    const response = await fetchPinned(`${this.provider.endpoint.replace(/\/$/, '')}/v1/messages`, {
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
  stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    return singleResponseStream(this.complete(request));
  }
  batch(requests: readonly ModelRequest[]): Promise<readonly ModelResponse[]> {
    return boundedBatch((request) => this.complete(request), requests);
  }
  async health(): Promise<'healthy' | 'degraded' | 'offline'> {
    try {
      const response = await fetchPinned(`${this.provider.endpoint.replace(/\/$/, '')}/v1/models`, {
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
      const response = await fetchPinned(`${this.provider.endpoint.replace(/\/$/, '')}/v1/models`, {
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
    const system = request.messages.find((message) => message.role === 'system')?.content;
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));
    const response = await fetchPinned(
      `${this.provider.endpoint.replace(/\/$/, '')}/models/${encodeURIComponent(request.model)}:generateContent`,
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
  stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    return singleResponseStream(this.complete(request));
  }
  batch(requests: readonly ModelRequest[]): Promise<readonly ModelResponse[]> {
    return boundedBatch((request) => this.complete(request), requests);
  }
  async health(): Promise<'healthy' | 'degraded' | 'offline'> {
    try {
      await fetchPinned(`${this.provider.endpoint.replace(/\/$/, '')}/models`, {
        signal: AbortSignal.timeout(3000),
      });
      return 'healthy';
    } catch {
      return 'offline';
    }
  }
  async listModels(): Promise<string[]> {
    return [];
  }
}

/** Azure OpenAI uses deployment-scoped paths and an `api-key` header rather than Bearer auth. */
export class AzureOpenAIAdapter implements ModelAdapter {
  constructor(
    private readonly provider: ModelProvider,
    private readonly token?: string,
  ) {
    assertSafeEndpoint(provider.endpoint);
  }
  private baseUrl(): string {
    const parsed = new URL(this.provider.endpoint);
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
  }
  private apiVersion(): string {
    const parsed = new URL(this.provider.endpoint);
    return parsed.searchParams.get('api-version') ?? '2024-10-21';
  }
  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.token ? { 'api-key': this.token } : {}),
    };
  }
  private deploymentsUrl(): string {
    return `${this.baseUrl()}/openai/deployments?api-version=${encodeURIComponent(this.apiVersion())}`;
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const response = await fetchPinned(
      `${this.baseUrl()}/openai/deployments/${encodeURIComponent(request.model)}/chat/completions?api-version=${encodeURIComponent(this.apiVersion())}`,
      {
        method: 'POST',
        headers: this.headers(),
        redirect: 'error',
        body: JSON.stringify({
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          tools: request.tools,
          response_format: request.responseFormat === 'json' ? { type: 'json_object' } : undefined,
        }),
        signal: providerSignal(request),
      },
    );
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
    return {
      id: data.id ?? `azure_openai_${Date.now()}`,
      content: message?.content ?? '',
      toolCalls: (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
      })),
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
      raw: redactSecrets(data),
    };
  }
  stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    return singleResponseStream(this.complete(request));
  }
  batch(requests: readonly ModelRequest[]): Promise<readonly ModelResponse[]> {
    return boundedBatch((request) => this.complete(request), requests);
  }
  async health(): Promise<'healthy' | 'degraded' | 'offline'> {
    try {
      const response = await fetchPinned(this.deploymentsUrl(), {
        headers: this.token ? { 'api-key': this.token } : undefined,
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
      const response = await fetchPinned(this.deploymentsUrl(), {
        headers: this.token ? { 'api-key': this.token } : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as {
        data?: Array<{ id?: string; model?: string }>;
      };
      return (
        data.data?.flatMap((deployment) => {
          const name = deployment.id ?? deployment.model;
          return name ? [name] : [];
        }) ?? []
      );
    } catch {
      return [];
    }
  }
}

interface CohereToolCallPayload {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

interface CohereResponsePayload {
  id?: string;
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
    tool_calls?: CohereToolCallPayload[];
  };
  usage?: {
    tokens?: { input_tokens?: number; output_tokens?: number };
    billed_units?: { input_tokens?: number; output_tokens?: number };
  };
}

const cohereContent = (
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part.type === 'text' || part.type === undefined)
    .map((part) => part.text ?? '')
    .join('');
};

const cohereArguments = (
  value: string | Record<string, unknown> | undefined,
): Record<string, unknown> => {
  if (value === undefined) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('provider_tool_arguments_invalid');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === 'provider_tool_arguments_invalid') throw error;
    throw new Error('provider_tool_arguments_invalid');
  }
};

/** Native Cohere v2 adapter. Cohere's chat and model-listing routes are not OpenAI wire-compatible. */
export class CohereAdapter implements ModelAdapter {
  constructor(
    private readonly provider: ModelProvider,
    private readonly token?: string,
  ) {
    assertSafeEndpoint(provider.endpoint);
  }
  private baseUrl(): string {
    return this.provider.endpoint.replace(/\/$/, '');
  }
  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const tools = request.tools?.length ? request.tools : undefined;
    const response = await fetchPinned(`${this.baseUrl()}/v2/chat`, {
      method: 'POST',
      headers: this.headers(),
      redirect: 'error',
      body: JSON.stringify({
        stream: false,
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.name ? { name: message.name } : {}),
          ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        })),
        tools,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        // Cohere rejects response_format together with tools; preserve the
        // normalized contract while avoiding a provider-side invalid request.
        response_format:
          request.responseFormat === 'json' && !tools ? { type: 'json_object' } : undefined,
      }),
      signal: providerSignal(request),
    });
    if (!response.ok)
      throw new Error(
        `provider_error:${response.status}:${String(redactSecrets(await response.text()))}`,
      );
    const data = (await response.json()) as CohereResponsePayload;
    const calls = (data.message?.tool_calls ?? []).map((call) => {
      if (!call.id || !call.function?.name) throw new Error('provider_tool_call_invalid');
      return {
        id: call.id,
        name: call.function.name,
        arguments: cohereArguments(call.function.arguments),
      };
    });
    const usage = data.usage?.tokens ?? data.usage?.billed_units;
    return {
      id: data.id ?? `cohere_${Date.now()}`,
      content: cohereContent(data.message?.content),
      toolCalls: calls,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
      raw: redactSecrets(data),
    };
  }
  stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    return singleResponseStream(this.complete(request));
  }
  batch(requests: readonly ModelRequest[]): Promise<readonly ModelResponse[]> {
    return boundedBatch((request) => this.complete(request), requests);
  }
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const started = Date.now();
    const response = await fetchPinned(`${this.baseUrl()}/v2/embed`, {
      method: 'POST',
      headers: this.headers(),
      redirect: 'error',
      body: JSON.stringify({
        model: request.model,
        input_type: 'search_document',
        texts: Array.isArray(request.input) ? request.input : [request.input],
      }),
      signal: providerSignal({ model: request.model, messages: [], signal: request.signal }),
    });
    if (!response.ok)
      throw new Error(
        `provider_error:${response.status}:${String(redactSecrets(await response.text()))}`,
      );
    const data = (await response.json()) as {
      model?: string;
      embeddings?: unknown;
      usage?: { billed_units?: { input_tokens?: number } };
    };
    if (!Array.isArray(data.embeddings)) throw new Error('provider_embedding_missing');
    const embeddings = data.embeddings.map((embedding) => {
      if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== 'number'))
        throw new Error('provider_embedding_invalid');
      return embedding as number[];
    });
    if (!embeddings.length) throw new Error('provider_embedding_missing');
    return {
      model: data.model ?? request.model,
      embeddings,
      usage: { inputTokens: data.usage?.billed_units?.input_tokens ?? 0, outputTokens: 0 },
      latencyMs: Date.now() - started,
    };
  }
  async health(): Promise<'healthy' | 'degraded' | 'offline'> {
    try {
      const response = await fetchPinned(`${this.baseUrl()}/v1/models`, {
        headers: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
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
      const response = await fetchPinned(`${this.baseUrl()}/v1/models`, {
        headers: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as {
        models?: Array<{ name?: string; id?: string }>;
      };
      return (
        data.models
          ?.map((model) => model.name ?? model.id)
          .filter((name): name is string => Boolean(name)) ?? []
      );
    } catch {
      return [];
    }
  }
}

interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

interface BedrockTool {
  toolSpec: {
    name: string;
    description?: string;
    inputSchema: { json: object };
  };
}

const awsEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const awsHash = (value: string): string => createHash('sha256').update(value).digest('hex');

const awsHmac = (key: string | Buffer, value: string): Buffer =>
  createHmac('sha256', key).update(value).digest();

const bedrockCredentials = (token: string | undefined, endpoint: URL): BedrockCredentials => {
  let parsed: Partial<BedrockCredentials> = {};
  if (token) {
    try {
      const value: unknown = JSON.parse(token);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('bedrock_credentials_json_required');
      parsed = value as Partial<BedrockCredentials>;
    } catch {
      throw new Error('bedrock_credentials_json_required');
    }
  }
  const configuredString = (value: unknown, name: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > 4096)
      throw new Error(`bedrock_${name}_invalid`);
    return value;
  };
  const region =
    configuredString(parsed.region, 'region') ??
    configuredString(process.env.AWS_REGION, 'region') ??
    endpoint.hostname.match(/^bedrock-runtime[.-]([a-z0-9-]+)\.amazonaws\.com$/i)?.[1];
  const accessKeyId =
    configuredString(parsed.accessKeyId, 'access_key_id') ??
    configuredString(process.env.AWS_ACCESS_KEY_ID, 'access_key_id');
  const secretAccessKey =
    configuredString(parsed.secretAccessKey, 'secret_access_key') ??
    configuredString(process.env.AWS_SECRET_ACCESS_KEY, 'secret_access_key');
  const sessionToken =
    configuredString(parsed.sessionToken, 'session_token') ??
    configuredString(process.env.AWS_SESSION_TOKEN, 'session_token');
  if (!region || !accessKeyId || !secretAccessKey) throw new Error('bedrock_credentials_required');
  return { accessKeyId, secretAccessKey, sessionToken, region };
};

/** Amazon Bedrock Converse adapter with AWS Signature Version 4 request signing. */
export class BedrockAdapter implements ModelAdapter {
  private readonly endpoint: URL;
  private readonly credentials: BedrockCredentials;
  constructor(provider: ModelProvider, token?: string) {
    this.endpoint = assertSafeEndpoint(provider.endpoint);
    this.credentials = bedrockCredentials(token, this.endpoint);
  }
  private runtimeUrl(pathname: string): string {
    return `${this.endpoint.origin}${pathname}`;
  }
  private controlPlaneUrl(pathname: string): string {
    const hostname = this.endpoint.hostname.replace(/^bedrock-runtime\./i, 'bedrock.');
    return `${this.endpoint.protocol}//${hostname}${pathname}`;
  }
  private sign(
    urlString: string,
    method: string,
    body: string,
    service: 'bedrock' = 'bedrock',
  ): Record<string, string> {
    const url = new URL(urlString);
    const nowDate = new Date();
    const amzDate = nowDate.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = awsHash(body);
    const host = url.host;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      host,
      'x-amz-date': amzDate,
      ...(this.credentials.sessionToken
        ? { 'x-amz-security-token': this.credentials.sessionToken }
        : {}),
    };
    const canonicalHeaders = Object.entries(headers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name.toLowerCase()}:${value.trim()}\n`)
      .join('');
    const signedHeaders = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort()
      .join(';');
    const canonicalUri =
      url.pathname
        .split('/')
        .map((segment) => awsEncode(segment))
        .join('/') || '/';
    const canonicalQuery = [...url.searchParams.entries()]
      .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');
    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${dateStamp}/${this.credentials.region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${awsHash(canonicalRequest)}`;
    const dateKey = awsHmac(`AWS4${this.credentials.secretAccessKey}`, dateStamp);
    const regionKey = awsHmac(dateKey, this.credentials.region);
    const serviceKey = awsHmac(regionKey, service);
    const signingKey = awsHmac(serviceKey, 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    return {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }
  private requestBody(request: ModelRequest): Record<string, unknown> {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => ({ text: message.content }));
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: [{ text: message.content }],
      }));
    const tools = request.tools
      ?.map((tool): BedrockTool | undefined => {
        const record = tool && typeof tool === 'object' ? (tool as Record<string, unknown>) : {};
        const fn =
          record.function && typeof record.function === 'object'
            ? (record.function as Record<string, unknown>)
            : record;
        if (typeof fn.name !== 'string') return undefined;
        return {
          toolSpec: {
            name: fn.name,
            ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
            inputSchema: {
              json:
                fn.parameters && typeof fn.parameters === 'object'
                  ? fn.parameters
                  : { type: 'object' },
            },
          },
        };
      })
      .filter((tool): tool is BedrockTool => Boolean(tool));
    return {
      messages,
      system: system.length ? system : undefined,
      inferenceConfig: {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      },
      toolConfig: tools?.length ? { tools } : undefined,
    };
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const body = JSON.stringify(this.requestBody(request));
    const path = `/model/${awsEncode(request.model)}/converse`;
    const response = await fetchPinned(this.runtimeUrl(path), {
      method: 'POST',
      headers: this.sign(this.runtimeUrl(path), 'POST', body),
      redirect: 'error',
      body,
      signal: providerSignal(request),
    });
    if (!response.ok)
      throw new Error(
        `provider_error:${response.status}:${String(redactSecrets(await response.text()))}`,
      );
    const data = (await response.json()) as {
      output?: {
        message?: {
          content?: Array<{
            text?: string;
            toolUse?: { toolUseId?: string; name?: string; input?: Record<string, unknown> };
          }>;
        };
      };
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    const blocks = data.output?.message?.content ?? [];
    return {
      id: `bedrock_${Date.now()}`,
      content: blocks.map((block) => block.text ?? '').join(''),
      toolCalls: blocks.flatMap((block) =>
        block.toolUse?.toolUseId && block.toolUse.name
          ? [
              {
                id: block.toolUse.toolUseId,
                name: block.toolUse.name,
                arguments: block.toolUse.input ?? {},
              },
            ]
          : [],
      ),
      usage: {
        inputTokens: data.usage?.inputTokens ?? 0,
        outputTokens: data.usage?.outputTokens ?? 0,
      },
      latencyMs: Date.now() - started,
      raw: redactSecrets(data),
    };
  }
  stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    return singleResponseStream(this.complete(request));
  }
  batch(requests: readonly ModelRequest[]): Promise<readonly ModelResponse[]> {
    return boundedBatch((request) => this.complete(request), requests);
  }
  async health(): Promise<'healthy' | 'degraded' | 'offline'> {
    try {
      const url = this.controlPlaneUrl('/foundation-models?byOutputModality=TEXT');
      const response = await fetchPinned(url, {
        headers: this.sign(url, 'GET', ''),
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
      const url = this.controlPlaneUrl('/foundation-models?byOutputModality=TEXT');
      const response = await fetchPinned(url, {
        headers: this.sign(url, 'GET', ''),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as {
        modelSummaries?: Array<{ modelId?: string }>;
      };
      return data.modelSummaries?.flatMap((model) => (model.modelId ? [model.modelId] : [])) ?? [];
    } catch {
      return [];
    }
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
  stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    return singleResponseStream(this.complete(request));
  }
  batch(requests: readonly ModelRequest[]): Promise<readonly ModelResponse[]> {
    return boundedBatch((request) => this.complete(request), requests);
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
  if (provider.providerKind === 'azure-openai') return new AzureOpenAIAdapter(provider, token);
  if (provider.providerKind === 'cohere') return new CohereAdapter(provider, token);
  if (provider.providerKind === 'bedrock') return new BedrockAdapter(provider, token);
  return new OpenAICompatibleAdapter(provider, token);
};

export interface LocalDiscoveryResult {
  providerKind: ProviderKind;
  endpoint: string;
  reachable: boolean;
  models: string[];
}

export const localDiscoveryCandidates = (): ReadonlyArray<readonly [ProviderKind, string]> => [
  ['ollama', 'http://127.0.0.1:11434/v1'],
  ['lmstudio', 'http://127.0.0.1:1234/v1'],
  ['localai', 'http://127.0.0.1:8080/v1'],
  ['llamacpp', 'http://127.0.0.1:8080/v1'],
  ['vllm', 'http://127.0.0.1:8000/v1'],
  ['jan', 'http://127.0.0.1:1337/v1'],
];

export async function discoverLocalEndpoints(): Promise<LocalDiscoveryResult[]> {
  return Promise.all(
    localDiscoveryCandidates().map(async ([providerKind, endpoint]) => {
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

/**
 * The bootstrap provider is an in-process mock, identifiable by its port-zero
 * loopback endpoint: nothing can listen on port 0, so the address cannot
 * collide with a real local runtime.
 *
 * This exists so the mock is a narrow, checkable case. Treating every `local`
 * model as a mock made registering a real Ollama or LM Studio endpoint inert —
 * the run returned canned text and never contacted the runtime.
 */
export const isBootstrapMockProvider = (provider: ModelProvider): boolean => {
  if (!provider.endpoint) return false;
  try {
    const url = new URL(provider.endpoint);
    return (
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') &&
      url.port === '0'
    );
  } catch {
    return false;
  }
};
