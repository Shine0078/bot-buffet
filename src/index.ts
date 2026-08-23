import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.js';
import {
  adapterFor,
  isBootstrapMockProvider,
  MockLocalAdapter,
  resolveProviderToken,
} from './providers.js';
import { ModelRouter } from './router.js';
import { Orchestrator } from './orchestrator.js';
import { createStore } from './store.js';
import { createBuiltinTools } from './tools.js';
import { CredentialVault } from './secrets.js';
import { assertSandboxConfiguration } from './sandbox.js';
import { withStartupDiagnostics } from './startup.js';
import { DeviceSessionStore, PkceSessionStore } from './oauth.js';
import { resolveWorkspaceDir } from './paths.js';
import { tickSchedules } from './scheduler.js';
import {
  Membership,
  Model,
  ModelProvider,
  Organization,
  Project,
  User,
  Workspace,
  entity,
} from './types.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dataDir = process.env.BOT_BUFFET_DATA_DIR ?? join(root, '.data');
const workspaceDir = resolveWorkspaceDir(dataDir, process.env.BOT_BUFFET_WORKSPACE_DIR);
// Configuration failures exit with an actionable message rather than a raw
// stack trace: this is what a failed deployment shows the operator.
withStartupDiagnostics(() => assertSandboxConfiguration());
const store = createStore(dataDir);
await store.load();
const vault = withStartupDiagnostics(
  () => new CredentialVault(join(dataDir, 'credentials.enc.json')),
);
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
  // Keep the local development principal in the same durable identity model
  // used by production OIDC subjects.  The stable id is intentional: the
  // development authenticator returns `local-user`, and disabling this record
  // must therefore take effect at the API boundary.
  const user = {
    ...entity({
      kind: 'user',
      ownerId: 'local-user',
      scope: workspace.id,
      email: 'local@bot-buffet.local',
      displayName: 'Local User',
      disabled: false,
    }),
    id: 'local-user',
  } as User;
  const membership = entity({
    kind: 'membership',
    ownerId: 'local-user',
    scope: workspace.id,
    userId: 'local-user',
    workspaceId: workspace.id,
    role: 'owner',
  }) as Membership;
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
  for (const value of [
    org,
    user,
    workspace,
    membership,
    project,
    environment,
    provider,
    model,
    agent,
    task,
  ])
    await store.insert(value);
}

await bootstrap();
const tools = createBuiltinTools(store);
const oauth = new PkceSessionStore();
const device = new DeviceSessionStore();
const router = new ModelRouter(
  async () => store.list<Model>((x) => x.kind === 'model'),
  async (modelId) => {
    const model = await store.get<Model>(modelId);
    const provider = model ? await store.get<ModelProvider>(model.providerId) : undefined;
    return Boolean(provider && provider.health !== 'offline');
  },
  async (model) => (await store.get<ModelProvider>(model.providerId))?.enabled === true,
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
    // Only the bootstrap provider is a mock, and it is identifiable by its
    // port-zero loopback endpoint — nothing can actually listen there.
    //
    // This previously returned the mock for *every* local model, which made the
    // whole local-model feature inert: registering a real Ollama or LM Studio
    // endpoint through /api/v1/local-models/register and running an agent
    // against it silently returned canned text and never contacted the runtime.
    // Local-first is the product's premise, so the mock has to be the narrow
    // case rather than the default.
    if (model.local && isBootstrapMockProvider(provider)) {
      return new MockLocalAdapter(model.modelName);
    }
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
const host = process.env.BOT_BUFFET_HOST ?? '127.0.0.1';
server.listen(port, host, () =>
  console.log(`Samuel Abraham — Bot Buffet listening on http://${host}:${port}`),
);

const scheduleMs = Number(process.env.BOT_BUFFET_SCHEDULE_TICK_MS ?? 60_000);
if (Number.isFinite(scheduleMs) && scheduleMs > 0) {
  setInterval(
    () => {
      void tickSchedules(store, orchestrator).catch(() => undefined);
    },
    Math.max(15_000, scheduleMs),
  );
}
export { store, orchestrator, server };
