import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adapterFor,
  defaultCapabilities,
  isBootstrapMockProvider,
  MockLocalAdapter,
  resolveProviderToken,
} from '../src/providers.js';
import { ModelRouter } from '../src/router.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createStore } from '../src/store.js';
import { createBuiltinTools } from '../src/tools.js';
import { entity, type Model, type ModelProvider, type Run } from '../src/types.js';
import { fixtures } from './helpers/orchestrator-fixtures.js';

/**
 * A complete agent run driven by a real local model endpoint over HTTP.
 *
 * Every other orchestrator test uses the in-process `MockLocalAdapter`, so
 * until now nothing exercised the path the local-first premise depends on:
 * register a local runtime, route to it, and have the agent loop actually talk
 * to it. That gap hid a real defect — the runtime returned the mock adapter for
 * *every* model marked `local`, so registering a real Ollama or LM Studio
 * endpoint silently produced canned text and never contacted the runtime.
 *
 * The server here implements the OpenAI-compatible contract that Ollama,
 * LM Studio, llama.cpp, LocalAI, vLLM, and Jan all serve. It is a real HTTP
 * server on loopback, not a stub: the assertions below check what it actually
 * received.
 */

let server: Server;
let endpoint = '';
const received: Array<{ path: string; body: unknown }> = [];

function handler(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    received.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : undefined });

    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'local-llama' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const streaming =
        (received.at(-1)?.body as { stream?: boolean } | undefined)?.stream === true;

      // The orchestrator streams, so a local runtime that only answered the
      // buffered shape would be parsed as an empty response — the adapter would
      // find no `data:` lines and report zero tokens. Serve real SSE.
      if (streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // The fixture task's acceptance criterion is "repository", so a response
        // containing it lets verification pass on evidence rather than by the
        // check being vacuous.
        const event = (payload: string) => `data: ${payload}\n\n`;
        res.write(event('{"id":"local-1","choices":[{"delta":{"content":"I inspected the "}}]}'));
        res.write(event('{"id":"local-1","choices":[{"delta":{"content":"repository."}}]}'));
        res.write(event('{"id":"local-1","usage":{"prompt_tokens":42,"completion_tokens":9}}'));
        res.write(event('[DONE]'));
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'local-1',
          choices: [{ message: { content: 'I inspected the repository.' } }],
          usage: { prompt_tokens: 42, completion_tokens: 9 },
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

const localProvider = (overrides: Partial<ModelProvider> = {}) =>
  entity({
    kind: 'model-provider',
    ownerId: 'u',
    scope: 'w',
    name: 'Local runtime',
    providerKind: 'ollama',
    endpoint,
    enabled: true,
    health: 'unknown',
    capabilities: defaultCapabilities(),
    ...overrides,
  }) as ModelProvider;

describe('the mock adapter is the narrow case, not the default', () => {
  it('recognises only the port-zero bootstrap endpoint as a mock', () => {
    expect(isBootstrapMockProvider(localProvider({ endpoint: 'http://127.0.0.1:0/v1' }))).toBe(
      true,
    );
    expect(isBootstrapMockProvider(localProvider({ endpoint: 'http://localhost:0/v1' }))).toBe(
      true,
    );
  });

  it('does not treat a real local runtime as a mock', () => {
    // This is the defect: a real Ollama endpoint must not resolve to the mock.
    expect(isBootstrapMockProvider(localProvider())).toBe(false);
    expect(isBootstrapMockProvider(localProvider({ endpoint: 'http://127.0.0.1:11434/v1' }))).toBe(
      false,
    );
  });

  it('does not treat a malformed or absent endpoint as a mock', () => {
    expect(isBootstrapMockProvider(localProvider({ endpoint: 'not a url' }))).toBe(false);
    expect(isBootstrapMockProvider(localProvider({ endpoint: '' }))).toBe(false);
  });

  it('gives a real local provider the HTTP adapter rather than the mock', () => {
    const adapter = adapterFor(localProvider(), resolveProviderToken(localProvider(), undefined));
    expect(adapter).not.toBeInstanceOf(MockLocalAdapter);
  });
});

describe('a complete run against a real local endpoint', () => {
  it('drives the agent loop over HTTP and records the result', async () => {
    received.length = 0;
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-local-e2e-'));
    await writeFile(join(dir, 'repository'), 'contents');
    const store = createStore(dir);

    const { project, agent, task } = fixtures('execute');
    // The shared fixture pins allowedModels to its own model name, so the
    // profile has to permit this one or routing correctly refuses it with
    // `routing:no_eligible_models`.
    agent.profile.allowedModels = ['local-llama'];
    agent.profile.preferredModelId = undefined;
    const provider = localProvider({ scope: project.id });
    const model = entity({
      kind: 'model',
      ownerId: 'u',
      scope: project.id,
      providerId: provider.id,
      name: 'local-llama',
      modelName: 'local-llama',
      local: true,
      capabilities: provider.capabilities,
      inputCostPerMillionCents: 0,
      outputCostPerMillionCents: 0,
      available: true,
    }) as Model;
    for (const record of [project, agent, provider, model, task]) await store.insert(record);

    const orchestrator = new Orchestrator({
      store,
      router: new ModelRouter(async () => [model]),
      tools: createBuiltinTools(store),
      workspaceRoot: () => dir,
      // Mirrors the production wiring in src/index.ts exactly.
      adapters: (candidate) => {
        if (candidate.local && isBootstrapMockProvider(provider)) {
          return new MockLocalAdapter(candidate.modelName);
        }
        return adapterFor(provider, resolveProviderToken(provider, undefined));
      },
    });

    const run = await orchestrator.createRun({ ownerId: 'u', project, agent, task });
    await orchestrator.start(run.id);

    // The endpoint was genuinely contacted, with the model the router chose.
    const completions = received.filter((entry) => entry.path === '/v1/chat/completions');
    expect(completions.length).toBeGreaterThan(0);
    expect((completions[0]?.body as { model: string }).model).toBe('local-llama');

    // And the run consumed the response rather than a canned one.
    const finished = await store.get<Run>(run.id);
    expect(finished?.status).toBe('completed');
    expect(finished?.tokensIn).toBe(42);
    expect(finished?.tokensOut).toBe(9);

    await expect(store.verifyAuditChain()).resolves.toMatchObject({ valid: true });
  }, 60_000);

  it('sends the system instructions and task to the local model', async () => {
    const completion = received.find((entry) => entry.path === '/v1/chat/completions');
    const body = completion?.body as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((message) => message.role === 'system');
    const user = body.messages.find((message) => message.role === 'user');
    expect(system?.content).toBeTruthy();
    // The task and its acceptance criteria have to reach the model, or the run
    // is asking it to work with no idea what it is doing.
    expect(user?.content).toContain('repo');
  });
});
