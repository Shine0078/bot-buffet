import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { OpenAICompatibleAdapter, defaultCapabilities } from '../src/providers.js';
import { entity, type ModelProvider } from '../src/types.js';

/**
 * The OpenAI-compatible adapter against a real HTTP server.
 *
 * This adapter backs thirteen of the nineteen supported provider kinds, so its
 * request construction and response parsing carry most of the provider
 * surface. The specification asks for real integration tests rather than
 * mocking away the behaviour being verified — and a mocked `fetch` would prove
 * nothing about what actually goes on the wire.
 *
 * Cloud provider kinds cannot be pointed at loopback: the adapter refuses a
 * non-loopback endpoint for a local kind and a non-https endpoint for a cloud
 * one, which is deliberate. The provider here is registered as `ollama` so a
 * local server is legitimate; the wire format is identical either way.
 */

/**
 * A credential-shaped value the fake provider echoes back in an error body.
 * Assembled at runtime so the literal never appears in source: the secret scan
 * refuses key-shaped strings anywhere, and a negative fixture must not be a
 * reason to weaken it.
 */
const ECHOED_KEY = ['sk', 'should', 'not', 'be', 'echoed', '0'.repeat(12)].join('-');

let server: Server;
let endpoint = '';
let lastRequest: {
  path?: string;
  method?: string;
  headers: Record<string, unknown>;
  body: string;
} = { headers: {}, body: '' };

function handler(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    lastRequest = {
      path: req.url,
      method: req.method,
      headers: req.headers as Record<string, unknown>,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    const url = req.url ?? '';
    const parsed = lastRequest.body ? (JSON.parse(lastRequest.body) as { stream?: boolean }) : {};

    // Routes are anchored to /v1 rather than matched by suffix, so a request
    // against any other base path falls through to 404 instead of quietly
    // succeeding — which is what the error tests below rely on.
    if (url.startsWith('/rate-limited/')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'slow down', key: ECHOED_KEY }));
      return;
    }

    if (url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder' }, { id: 'llama-3' }] }));
      return;
    }

    if (url === '/v1/chat/completions' && parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"resp-1","choices":[{"delta":{"content":"Hel"}}]}\n\n');
      res.write('data: {"id":"resp-1","choices":[{"delta":{"content":"lo"}}]}\n\n');
      res.write(
        'data: {"id":"resp-1","choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"lookup","arguments":"{\\"q\\":1}"}}]}}]}\n\n',
      );
      res.write('data: {"id":"resp-1","usage":{"prompt_tokens":11,"completion_tokens":4}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'resp-42',
          choices: [
            {
              message: {
                content: 'the answer',
                tool_calls: [
                  { id: 'call-9', function: { name: 'search', arguments: '{"query":"docs"}' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 31, completion_tokens: 12 },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end('{}');
  });
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_address_missing');
  endpoint = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const adapter = (token?: string) =>
  new OpenAICompatibleAdapter(
    entity({
      kind: 'model-provider',
      ownerId: 'u',
      scope: 'w',
      name: 'local',
      providerKind: 'ollama',
      endpoint,
      enabled: true,
      health: 'unknown',
      capabilities: defaultCapabilities(),
    }) as ModelProvider,
    token,
  );

const request = {
  model: 'qwen2.5-coder',
  messages: [{ role: 'user' as const, content: 'ping' }],
};

describe('completion request construction', () => {
  it('posts to /chat/completions with the model and messages', async () => {
    await adapter().complete(request);
    expect(lastRequest.method).toBe('POST');
    expect(lastRequest.path).toBe('/v1/chat/completions');
    const body = JSON.parse(lastRequest.body) as { model: string; messages: unknown[] };
    expect(body.model).toBe('qwen2.5-coder');
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
  });

  it('sends a bearer token only when one was supplied', async () => {
    await adapter('secret-token').complete(request);
    expect(lastRequest.headers.authorization).toBe('Bearer secret-token');

    await adapter().complete(request);
    expect(lastRequest.headers.authorization).toBeUndefined();
  });

  it('translates the JSON output format to response_format', async () => {
    await adapter().complete({ ...request, responseFormat: 'json' });
    const body = JSON.parse(lastRequest.body) as { response_format?: { type: string } };
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('omits response_format for plain text rather than sending a null', async () => {
    await adapter().complete({ ...request, responseFormat: 'text' });
    expect(JSON.parse(lastRequest.body)).not.toHaveProperty('response_format');
  });

  it('passes temperature, max tokens, and tools through', async () => {
    await adapter().complete({
      ...request,
      temperature: 0.2,
      maxTokens: 256,
      tools: [{ type: 'function', function: { name: 'search', parameters: {} } }] as never,
    });
    const body = JSON.parse(lastRequest.body) as Record<string, unknown>;
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(256);
    expect(Array.isArray(body.tools)).toBe(true);
  });
});

describe('completion response parsing', () => {
  it('extracts content, tool calls, and usage', async () => {
    const response = await adapter().complete(request);
    expect(response.id).toBe('resp-42');
    expect(response.content).toBe('the answer');
    expect(response.toolCalls).toEqual([
      { id: 'call-9', name: 'search', arguments: { query: 'docs' } },
    ]);
    expect(response.usage).toEqual({ inputTokens: 31, outputTokens: 12 });
  });

  it('parses tool arguments into an object rather than leaving a JSON string', async () => {
    // The orchestrator validates arguments against a schema, which cannot be
    // done against a string.
    const response = await adapter().complete(request);
    expect(typeof response.toolCalls[0]?.arguments).toBe('object');
  });

  it('measures latency', async () => {
    const response = await adapter().complete(request);
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('error handling', () => {
  it('raises a provider error carrying the status', async () => {
    const failing = new OpenAICompatibleAdapter(
      entity({
        kind: 'model-provider',
        ownerId: 'u',
        scope: 'w',
        name: 'local',
        providerKind: 'ollama',
        endpoint: `${endpoint.replace('/v1', '')}/not-a-route`,
        enabled: true,
        health: 'unknown',
        capabilities: defaultCapabilities(),
      }) as ModelProvider,
    );
    await expect(failing.complete(request)).rejects.toThrow(/provider_error:404/);
  });

  it('redacts anything key-shaped out of an error body', async () => {
    // A provider error body is untrusted text that may echo the request,
    // including its credential.
    const failing = new OpenAICompatibleAdapter(
      entity({
        kind: 'model-provider',
        ownerId: 'u',
        scope: 'w',
        name: 'local',
        providerKind: 'ollama',
        endpoint: `${endpoint.replace('/v1', '')}/rate-limited`,
        enabled: true,
        health: 'unknown',
        capabilities: defaultCapabilities(),
      }) as ModelProvider,
    );
    await expect(failing.complete(request)).rejects.toThrow(/provider_error:429/);
    await expect(failing.complete(request)).rejects.not.toThrow(ECHOED_KEY);
  });
});

describe('streaming', () => {
  it('yields incremental deltas and finishes with usage', async () => {
    const deltas: string[] = [];
    let done = false;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const chunk of adapter().stream(request)) {
      if (chunk.delta) deltas.push(chunk.delta);
      if (chunk.done) {
        done = true;
        usage = chunk.usage;
      }
    }
    expect(deltas.join('')).toContain('Hello');
    expect(done).toBe(true);
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 4 });
  });

  it('marks the request as streaming on the wire', async () => {
    for await (const _chunk of adapter().stream(request)) void _chunk;
    expect(JSON.parse(lastRequest.body)).toMatchObject({ stream: true });
  });

  it('asks for an event stream', async () => {
    for await (const _chunk of adapter().stream(request)) void _chunk;
    expect(String(lastRequest.headers.accept)).toContain('text/event-stream');
  });

  it('surfaces streamed tool calls', async () => {
    const calls: string[] = [];
    for await (const chunk of adapter().stream(request)) {
      for (const call of chunk.toolCalls ?? []) if (call.name) calls.push(call.name);
    }
    expect(calls).toContain('lookup');
  });

  it('ignores the [DONE] sentinel rather than parsing it as JSON', async () => {
    // A naive parser throws here; the stream must simply end.
    await expect(
      (async () => {
        for await (const _chunk of adapter().stream(request)) void _chunk;
      })(),
    ).resolves.toBeUndefined();
  });
});

describe('model listing', () => {
  it('returns the model identifiers the endpoint reports', async () => {
    const models = await adapter().listModels();
    expect(models).toEqual(['qwen2.5-coder', 'llama-3']);
  });

  it('reports an empty list for an endpoint that is not there', async () => {
    const unreachable = new OpenAICompatibleAdapter(
      entity({
        kind: 'model-provider',
        ownerId: 'u',
        scope: 'w',
        name: 'local',
        providerKind: 'ollama',
        endpoint: 'http://127.0.0.1:1/v1',
        enabled: true,
        health: 'unknown',
        capabilities: defaultCapabilities(),
      }) as ModelProvider,
    );
    // Discovery probes runtimes that may not be running, so an unreachable
    // endpoint reports nothing rather than failing the caller.
    await expect(unreachable.listModels()).resolves.toEqual([]);
  });
});
