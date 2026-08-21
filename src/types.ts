import { randomUUID } from 'node:crypto';

export type ID = string;
export type ISODate = string;

export const now = (): ISODate => new Date().toISOString();
export const id = (prefix: string): ID => `${prefix}_${randomUUID()}`;

export type RoleName = 'owner' | 'admin' | 'operator' | 'reviewer' | 'developer' | 'viewer';
export type Risk = 'safe' | 'low' | 'medium' | 'high' | 'critical';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'retrying'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled'
  | 'rolled_back';
export type AgentStatus =
  | 'idle'
  | 'working'
  | 'paused'
  | 'waiting_approval'
  | 'blocked'
  | 'retrying'
  | 'failed'
  | 'completed'
  | 'stopped';
export type RunMode =
  | 'plan'
  | 'execute'
  | 'review'
  | 'chat'
  | 'supervised'
  | 'autonomous'
  | 'maintenance'
  | 'emergency-stop'
  | 'custom';
export type ProviderKind =
  | 'ollama'
  | 'lmstudio'
  | 'llamacpp'
  | 'localai'
  | 'vllm'
  | 'jan'
  | 'openai-compatible'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'xai'
  | 'openrouter'
  | 'azure-openai'
  | 'bedrock'
  | 'mistral'
  | 'cohere'
  | 'deepseek'
  | 'together'
  | 'fireworks';

export interface BaseEntity {
  id: ID;
  ownerId: ID;
  scope: string;
  version: number;
  createdAt: ISODate;
  updatedAt: ISODate;
  accessPolicy: AccessPolicy;
}

export interface AccessPolicy {
  visibility: 'private' | 'workspace' | 'project' | 'organization';
  roles: Partial<Record<RoleName, string[]>>;
}

export interface User extends BaseEntity {
  kind: 'user';
  email: string;
  displayName: string;
  disabled: boolean;
}
export interface Organization extends BaseEntity {
  kind: 'organization';
  name: string;
  slug: string;
}
export interface Workspace extends BaseEntity {
  kind: 'workspace';
  organizationId: ID;
  name: string;
  slug: string;
  offlineMode: boolean;
}
export interface Membership extends BaseEntity {
  kind: 'membership';
  userId: ID;
  workspaceId: ID;
  role: RoleName;
}
export interface Role extends BaseEntity {
  kind: 'role';
  name: RoleName | string;
  permissions: string[];
  system: boolean;
}
export interface Project extends BaseEntity {
  kind: 'project';
  workspaceId: ID;
  name: string;
  slug: string;
  archived: boolean;
  defaultEnvironmentId?: ID;
}
export interface Environment extends BaseEntity {
  kind: 'environment';
  projectId: ID;
  name: string;
  network: 'blocked' | 'allowlist' | 'open';
  persistent: boolean;
  protected: boolean;
}

export interface AgentProfile {
  name: string;
  description?: string;
  avatar?: string;
  mission: string;
  systemInstructions: string;
  projectRules: string[];
  skills: string[];
  allowedModels: ID[];
  preferredModelId?: ID;
  fallbackModelIds: ID[];
  allowedToolIds: ID[];
  allowedPluginIds: ID[];
  allowedPaths: string[];
  protectedPaths: string[];
  network: 'blocked' | 'allowlist' | 'open';
  environmentKeys: string[];
  maxSteps: number;
  timeLimitMs: number;
  tokenLimit: number;
  costLimitCents: number;
  concurrencyLimit: number;
  approvalPolicy: ApprovalPolicy;
  verificationPolicy: VerificationPolicy;
  memoryPolicy: MemoryPolicy;
  outputFormat: 'text' | 'json' | 'markdown';
  escalationPolicy: 'pause' | 'retry' | 'delegate' | 'stop';
  mode: RunMode;
  version: number;
  changelog: string[];
}
export interface Agent extends BaseEntity {
  kind: 'agent';
  projectId: ID;
  environmentId: ID;
  profile: AgentProfile;
  status: AgentStatus;
  currentTaskId?: ID;
  currentRunId?: ID;
}

export interface CredentialMetadata {
  providerId: ID;
  label: string;
  authType: 'api-key' | 'oauth-pkce' | 'device' | 'sso' | 'managed-identity' | 'env' | 'custom';
  expiresAt?: ISODate;
  scopes: string[];
  lastTestedAt?: ISODate;
  disabled: boolean;
  fingerprint: string;
}
export interface Credential extends BaseEntity {
  kind: 'credential';
  metadata: CredentialMetadata;
  secretRef: string;
}
export interface ModelProvider extends BaseEntity {
  kind: 'model-provider';
  name: string;
  providerKind: ProviderKind;
  endpoint: string;
  credentialId?: ID;
  enabled: boolean;
  health: 'unknown' | 'healthy' | 'degraded' | 'offline';
  capabilities: CapabilitySet;
  oauth?: OAuthProviderConfig;
}
export interface OAuthProviderConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
  clientId: string;
  scopes: string[];
  redirectUri: string;
}
export interface CapabilitySet {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  vision: boolean;
  audio: boolean;
  embeddings: boolean;
  reranking: boolean;
  contextTokens?: number;
  outputTokens?: number;
}
export interface Model extends BaseEntity {
  kind: 'model';
  providerId: ID;
  name: string;
  modelName: string;
  local: boolean;
  capabilities: CapabilitySet;
  inputCostPerMillionCents: number;
  outputCostPerMillionCents: number;
  license?: string;
  quantization?: string;
  sizeBytes?: number;
  available: boolean;
}
export interface ModelRoute extends BaseEntity {
  kind: 'model-route';
  projectId?: ID;
  agentId?: ID;
  name: string;
  strategy:
    'manual' | 'weighted' | 'least-cost' | 'lowest-latency' | 'privacy-first' | 'health-first';
  modelIds: ID[];
  fallbackModelIds: ID[];
  offlineOnly: boolean;
  maxCostCents?: number;
}

export interface ToolDefinition extends BaseEntity {
  kind: 'tool';
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  requiredScope: string;
  resourceScope: string;
  risk: Risk;
  reversible: boolean;
  authRequired: boolean;
  timeoutMs: number;
  rateLimitPerMinute: number;
  outputLimitBytes: number;
  releaseVersion: string;
  owner: string;
  enabled: boolean;
}
export interface Plugin extends BaseEntity {
  kind: 'plugin';
  name: string;
  releaseVersion: string;
  source: string;
  enabled: boolean;
  pinned: boolean;
  dependencies: string[];
  workspaceEnabled: boolean;
  projectIds: ID[];
  agentIds: ID[];
  network: 'blocked' | 'allowlist' | 'open';
  retention: string;
  permissions: string[];
  integritySha256?: string;
  previousReleaseVersion?: string;
}
export interface MCPServer extends BaseEntity {
  kind: 'mcp-server';
  name: string;
  endpoint: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  credentialId?: ID;
  enabled: boolean;
  toolNames: string[];
  integritySha256?: string;
}
export interface Policy extends BaseEntity {
  kind: 'policy';
  name: string;
  rules: PolicyRule[];
  version: number;
  enabled: boolean;
}
export interface PolicyRule {
  action: string;
  effect: 'allow' | 'deny' | 'approval';
  risks?: Risk[];
  scopes?: string[];
  paths?: string[];
  environments?: ID[];
}
export interface Permission extends BaseEntity {
  kind: 'permission';
  subjectId: ID;
  resource: string;
  actions: string[];
  effect: 'allow' | 'deny';
  conditions?: Record<string, string>;
}

export interface Task extends BaseEntity {
  kind: 'task';
  projectId: ID;
  environmentId: ID;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: 'backlog' | 'ready' | 'running' | 'blocked' | 'done' | 'cancelled';
  priority: number;
  assigneeAgentId?: ID;
  parentTaskId?: ID;
  dependencyIds: ID[];
  labels: string[];
}
export interface TaskDependency extends BaseEntity {
  kind: 'task-dependency';
  taskId: ID;
  dependsOnTaskId: ID;
  type: 'blocks' | 'relates' | 'duplicates';
}
export interface Workflow extends BaseEntity {
  kind: 'workflow';
  projectId: ID;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  enabled: boolean;
}
export interface WorkflowNode {
  id: string;
  kind: 'task' | 'agent' | 'approval' | 'condition' | 'parallel';
  config: Record<string, unknown>;
}
export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface Run extends BaseEntity {
  kind: 'run';
  projectId: ID;
  environmentId: ID;
  agentId: ID;
  taskId?: ID;
  mode: RunMode;
  status: RunStatus;
  stepCount: number;
  maxSteps: number;
  startedAt?: ISODate;
  finishedAt?: ISODate;
  pausedAt?: ISODate;
  cancelRequested: boolean;
  checkpointId?: ID;
  parentRunId?: ID;
  costCents: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  error?: string;
}
export interface RunStep extends BaseEntity {
  kind: 'run-step';
  runId: ID;
  sequence: number;
  type: 'model' | 'tool' | 'verification' | 'approval' | 'state' | 'handoff';
  status: 'started' | 'succeeded' | 'failed' | 'skipped';
  name: string;
  input?: unknown;
  output?: unknown;
  startedAt: ISODate;
  finishedAt?: ISODate;
  durationMs?: number;
  redacted: boolean;
}
export interface ApprovalPolicy {
  requiredRisks: Risk[];
  autoApproveReversible: boolean;
  expiryMs: number;
  delegates: ID[];
}
export interface VerificationPolicy {
  deterministic: string[];
  inferential: string[];
  requireEvidence: boolean;
  reviewerAgentId?: ID;
}
export interface MemoryPolicy {
  readableScopes: string[];
  writableScopes: string[];
  requireApproval: boolean;
  retentionDays: number;
}
export interface ApprovalRequest extends BaseEntity {
  kind: 'approval-request';
  runId: ID;
  stepId: ID;
  risk: Risk;
  action: string;
  payload: unknown;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedAt: ISODate;
  expiresAt: ISODate;
  decidedBy?: ID;
  decidedAt?: ISODate;
  reason?: string;
}
export interface Checkpoint extends BaseEntity {
  kind: 'checkpoint';
  runId: ID;
  sequence: number;
  stateHash: string;
  state: Record<string, unknown>;
  files: FileManifest[];
  createdBy: 'system' | ID;
}
export interface FileManifest {
  path: string;
  sha256: string;
  size: number;
  mode?: number;
}
export interface Artifact extends BaseEntity {
  kind: 'artifact';
  projectId: ID;
  runId?: ID;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  sha256: string;
  scanStatus: 'pending' | 'clean' | 'blocked';
}
export interface ProjectFile extends BaseEntity {
  kind: 'file';
  projectId: ID;
  path: string;
  sha256: string;
  size: number;
  lockedBy?: ID;
  versionLabel: string;
}
export interface MemoryItem extends BaseEntity {
  kind: 'memory';
  namespace:
    | 'user'
    | 'organization'
    | 'workspace'
    | 'project'
    | 'environment'
    | 'agent'
    | 'session'
    | 'task'
    | 'artifact';
  namespaceId: ID;
  text: string;
  data?: Record<string, unknown>;
  sourceIds: ID[];
  approved: boolean;
  freshnessAt: ISODate;
  expiresAt?: ISODate;
  embedding?: number[];
}
export interface Source extends BaseEntity {
  kind: 'source';
  projectId: ID;
  uri: string;
  title?: string;
  retrievedAt?: ISODate;
  status: 'pending' | 'available' | 'inaccessible' | 'unverified';
  quality: 'unknown' | 'low' | 'medium' | 'high';
  contentHash?: string;
}
export interface Citation extends BaseEntity {
  kind: 'citation';
  sourceId: ID;
  memoryId?: ID;
  artifactId?: ID;
  claim: string;
  locator?: string;
  verified: boolean;
}
export interface EvaluationDataset extends BaseEntity {
  kind: 'evaluation-dataset';
  name: string;
  description: string;
  caseIds: ID[];
  versionLabel: string;
}
export interface EvaluationCase extends BaseEntity {
  kind: 'evaluation-case';
  datasetId: ID;
  name: string;
  input: unknown;
  expected: unknown;
  graders: string[];
  tags: string[];
}
export interface EvaluationRun extends BaseEntity {
  kind: 'evaluation-run';
  datasetId: ID;
  modelId?: ID;
  agentId?: ID;
  status: 'queued' | 'running' | 'completed' | 'failed';
  results: EvaluationResult[];
  startedAt?: ISODate;
  finishedAt?: ISODate;
}
export interface EvaluationResult {
  caseId: ID;
  passed: boolean;
  score: number;
  evidence: string[];
  error?: string;
}
export interface AuditEvent extends BaseEntity {
  kind: 'audit-event';
  actorId: ID;
  action: string;
  resourceType: string;
  resourceId: ID;
  risk: Risk;
  decision: 'allowed' | 'denied' | 'approval-required' | 'executed';
  metadata: Record<string, unknown>;
  previousHash: string;
  hash: string;
}
export interface UsageRecord extends BaseEntity {
  kind: 'usage';
  runId: ID;
  modelId: ID;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costCents: number;
  recordedAt: ISODate;
}
export interface CostRecord extends BaseEntity {
  kind: 'cost';
  runId: ID;
  projectId: ID;
  amountCents: number;
  currency: string;
  category: string;
}
export interface Alert extends BaseEntity {
  kind: 'alert';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  acknowledged: boolean;
  resourceId?: ID;
}
export interface Schedule extends BaseEntity {
  kind: 'schedule';
  projectId: ID;
  cron: string;
  taskId: ID;
  enabled: boolean;
  timezone: string;
}
export interface Webhook extends BaseEntity {
  kind: 'webhook';
  projectId: ID;
  url: string;
  events: string[];
  secretFingerprint: string;
  enabled: boolean;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
  enum?: string[];
}
export type Entity =
  | User
  | Organization
  | Workspace
  | Membership
  | Role
  | Project
  | Environment
  | Agent
  | Credential
  | ModelProvider
  | Model
  | ModelRoute
  | ToolDefinition
  | Plugin
  | MCPServer
  | Policy
  | Permission
  | Task
  | TaskDependency
  | Workflow
  | Run
  | RunStep
  | ApprovalRequest
  | Checkpoint
  | Artifact
  | ProjectFile
  | MemoryItem
  | Source
  | Citation
  | EvaluationDataset
  | EvaluationCase
  | EvaluationRun
  | AuditEvent
  | UsageRecord
  | CostRecord
  | Alert
  | Schedule
  | Webhook;

export interface RuntimeState {
  entities: Record<string, Entity>;
  runState: Record<ID, Record<string, unknown>>;
  locks: Record<string, { ownerId: ID; expiresAt: ISODate }>;
  idempotency: Record<string, { status: number; payload: unknown; createdAt: ISODate }>;
  auditTail: string;
  schemaVersion: number;
}

export const defaultAccessPolicy = (): AccessPolicy => ({
  visibility: 'project',
  roles: {
    owner: ['*'],
    admin: ['*'],
    operator: ['read', 'run', 'approve'],
    reviewer: ['read', 'approve'],
    developer: ['read', 'write'],
    viewer: ['read'],
  },
});
export const entity = <T extends { kind: string; ownerId: ID; scope: string }>(
  value: T,
): T & BaseEntity =>
  ({
    ...value,
    id: id(value.kind),
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    accessPolicy: defaultAccessPolicy(),
  }) as T & BaseEntity;
