import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.js';
import { assertDeploymentAuthConfiguration } from './auth.js';
import {
  adapterFor,
  isLocalProvider,
  MockLocalAdapter,
  resolveProviderToken,
} from './providers.js';
import { ModelRouter } from './router.js';
import { Orchestrator } from './orchestrator.js';
import { createStore } from './store.js';
import { createBuiltinTools } from './tools.js';
import { CredentialVault } from './secrets.js';
import { assertSandboxConfiguration } from './sandbox.js';
import { DeviceSessionStore, PkceSessionStore } from './oauth.js';
import { resolveWorkspaceDir } from './paths.js';
import { Model, ModelProvider, Organization, Project, Workspace, entity } from './types.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dataDir = process.env.BOT_BUFFET_DATA_DIR ?? join(root, '.data');
const workspaceDir = resolveWorkspaceDir(dataDir, process.env.BOT_BUFFET_WORKSPACE_DIR);
const host = process.env.BOT_BUFFET_HOST ?? '127.0.0.1';
const authMode = process.env.BOT_BUFFET_AUTH_MODE ?? 'development';
assertDeploymentAuthConfiguration(host, authMode);
assertSandboxConfiguration();
const store = createStore(dataDir);
await store.load();
const vault = new CredentialVault(join(dataDir, 'credentials.enc.json'));
await vault.load();
await mkdir(workspaceDir, { recursive: true });

async function bootstrap(): Promise<void> {
  const existing = await store.list();
  if (existing.length) return;
  const org = entity({
    kind: 'organization',
    ownerId: 'local-user',
    scope: 'organization_local',
    name: 'Local Organization',
    slug: 'local',
  }) as Organization;
  const workspace = entity({
    kind: 'workspace',
    ownerId: 'local-user',
    scope: org.id,
    organizationId: org.id,
    name: "Samuel Abraham's Bot Buffet",
    slug: 'bot-buffet',
    offlineMode: process.env.BOT_BUFFET_OFFLINE === 'true',
  }) as Workspace;
  const project = entity({
    kind: 'project',
    ownerId: 'local-user',
    scope: workspace.id,
    workspaceId: workspace.id,
    name: 'Welcome Project',
    slug: 'welcome-project',
    archived: false,
  }) as Project;
  const environment = entity({
    kind: 'environment',
    ownerId: 'local-user',
    scope: project.id,
    projectId: project.id,
    name: 'Local Development',
    network: 'blocked',
    persistent: true,
    protected: false,
  });
  const provider = entity({
    kind: 'model-provider',
    ownerId: 'local-user',
    scope: workspace.id,
    name: 'Local Mock',
    providerKind: 'openai-compatible',
    endpoint: 'http://127.0.0.1:0/v1',
    enabled: true,
    health: 'healthy',
    capabilities: {
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      audio: false,
      embeddings: false,
      reranking: false,
      contextTokens: 8192,
      outputTokens: 2048,
    },
  }) as ModelProvider;
  const model = entity({
    kind: 'model',
    ownerId: 'local-user',
    scope: workspace.id,
    providerId: provider.id,
    name: 'Local Mock Model',
    modelName: 'bot-buffet-local',
    local: true,
    capabilities: provider.capabilities,
    inputCostPerMillionCents: 0,
    outputCostPerMillionCents: 0,
    available: true,
  }) as Model;
  const agent = entity({
    kind: 'agent',
    ownerId: 'local-user',
    scope: project.id,
    projectId: project.id,
    environmentId: environment.id,
    status: 'idle',
    profile: {
      name: 'Desk One',
      description: 'Safe local operator',
      avatar: '🧭',
      mission: 'Complete tasks with evidence.',
      systemInstructions:
        'You are a careful local agent. Explain actions and never expose secrets.',
      projectRules: ['Stay inside the project workspace.', 'Verify acceptance criteria.'],
      skills: [],
      allowedModels: [model.id],
      preferredModelId: model.id,
      fallbackModelIds: [],
      allowedToolIds: [
        'tool_filesystem.read',
        'tool_filesystem.write',
        'tool_filesystem.stat',
        'tool_shell.exec',
      ],
      allowedPluginIds: [],
      allowedPaths: ['.'],
      protectedPaths: ['.env', '.git'],
      network: 'blocked',
      environmentKeys: [],
      maxSteps: 8,
      timeLimitMs: 300000,
      tokenLimit: 16000,
      costLimitCents: 0,
      concurrencyLimit: 1,
      approvalPolicy: {
        requiredRisks: ['high', 'critical'],
        autoApproveReversible: false,
        expiryMs: 900000,
        delegates: [],
      },
      verificationPolicy: { deterministic: ['acceptance'], inferential: [], requireEvidence: true },
      memoryPolicy: {
        readableScopes: ['project', 'agent', 'task'],
        writableScopes: ['task'],
        requireApproval: true,
        retentionDays: 30,
      },
      outputFormat: 'text',
      escalationPolicy: 'pause',
      mode: 'supervised',
      version: 1,
      changelog: ['Initial profile'],
    },
  });
  const task = entity({
    kind: 'task',
    ownerId: 'local-user',
    scope: project.id,
    projectId: project.id,
    environmentId: environment.id,
    title: 'Explore Bot Buffet',
    description: 'Read the repository and report the current state.',
    acceptanceCriteria: ['repository'],
    status: 'ready',
    priority: 1,
    dependencyIds: [],
    labels: ['onboarding'],
  });
  for (const value of [org, workspace, project, environment, provider, model, agent, task])
    await store.insert(value);
}

await bootstrap();
const tools = createBuiltinTools(store);
const oauth = new PkceSessionStore();
const device = new DeviceSessionStore();
const router = new ModelRouter(
  async () => store.list<Model>((x) => x.kind === 'model'),
  async () => true,
  async (model) => {
    const provider = await store.get<ModelProvider>(model.providerId);
    return provider ? isLocalProvider(provider) : false;
  },
);
const providers = new Map(
  (await store.list<ModelProvider>((x) => x.kind === 'model-provider')).map((provider) => [
    provider.id,
    provider,
  ]),
);
const orchestrator = new Orchestrator({
  store,
  router,
  tools,
  workspaceRoot: (project) => join(workspaceDir, project.id),
  adapters: (model) => {
    const provider = providers.get(model.providerId);
    if (!provider) throw new Error('provider_not_found');
    // The bootstrap provider uses a port-zero loopback endpoint as an in-process
    // mock. Other local models still use their validated provider adapter.
    if (model.local && provider.endpoint.endsWith(':0/v1'))
      return new MockLocalAdapter(model.modelName);
    return adapterFor(provider, resolveProviderToken(provider, vault.getSync(provider.id)));
  },
});
const server = createApi({
  store,
  orchestrator,
  uiRoot: join(root, 'ui'),
  vault,
  tools,
  oauth,
  device,
  registerProvider: (provider) => providers.set(provider.id, provider),
});
const port = Number(process.env.PORT ?? 8787);
/**
 * Bind address.
 *
 * The default stays loopback so running Bot Buffet on a laptop never puts a
 * control plane on the network by accident — it holds credentials and can
 * execute code, so exposure must be a deliberate act.
 *
 * A container needs the opposite: binding loopback *inside* the container
 * makes the service unreachable through its published port, because the
 * mapping arrives on the container's external interface. The image therefore
 * sets `BOT_BUFFET_HOST=0.0.0.0` explicitly, which is safe precisely because
 * the operator chose which host port to publish it on.
 */
server.listen(port, host, () =>
  console.log(`Samuel Abraham — Bot Buffet listening on http://${host}:${port}`),
);

export { store, orchestrator, server };
