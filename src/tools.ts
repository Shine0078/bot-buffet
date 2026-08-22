import { createHash } from 'node:crypto';
import { basename, relative, sep } from 'node:path';
import { JsonStateStore } from './store.js';
import {
  entity,
  MemoryItem,
  MemoryPolicy,
  ProjectFile,
  ToolDefinition,
  ID,
  JsonSchema,
} from './types.js';
import { canWriteMemory } from './memoryScope.js';
import { createSandboxRuntime, SandboxRuntime } from './sandbox.js';
import {
  assertWorkspacePath,
  assertWorkspaceRealPath,
  redactSecrets,
  validateCommand,
  validateJsonSchema,
} from './security.js';

export interface ToolContext {
  actorId: ID;
  runId: ID;
  projectId: ID;
  /** Identities a memory namespace is resolved against, so an agent can only
   *  record memory against the run it is actually executing. */
  agentId?: ID;
  taskId?: ID;
  workspaceRoot: string;
  allowedPaths: string[];
  protectedPaths: string[];
  network: 'blocked' | 'allowlist' | 'open';
  /** The agent's memory policy, which decides what it may record. */
  memoryPolicy?: MemoryPolicy;
  /** Environment variable names this agent may see. Anything not listed is
   *  withheld from the sandbox, in both runtimes. */
  environmentKeys?: string[];
  signal?: AbortSignal;
}
export interface RegisteredTool {
  definition: ToolDefinition;
  execute: (input: unknown, context: ToolContext) => Promise<unknown>;
}
export interface ToolInvocationAudit {
  (record: {
    context: ToolContext;
    definition: ToolDefinition;
    decision: 'denied' | 'executed';
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

const sha256Text = (value: string): string => createHash('sha256').update(value).digest('hex');
const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value);
const canonicalProjectPath = (relativePath: string): string => {
  const portable = relativePath.replaceAll(sep, '/');
  return process.platform === 'win32' ? portable.toLowerCase() : portable;
};
const projectFileId = (projectId: ID, relativePath: string): ID =>
  `file_${createHash('sha256')
    .update(`${projectId}\0${canonicalProjectPath(relativePath)}`)
    .digest('hex')
    .slice(0, 32)}`;

/**
 * Sliding-window rate limiter for tool invocations.
 *
 * `rateLimitPerMinute` was declared on every tool definition and enforced
 * nowhere, so a looping agent could call a tool without limit. The window is
 * keyed per tool *and* per project, so one project exhausting a tool's budget
 * cannot starve another.
 *
 * The clock is injectable so the behaviour is testable without waiting a
 * minute for a window to roll.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** Records an invocation and reports whether it is within the limit. */
  check(key: string, limitPerMinute: number): boolean {
    // A limit of zero or less means unlimited rather than "nothing allowed";
    // a tool with no declared limit must not become unusable.
    if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) return true;
    const now = this.clock();
    const cutoff = now - 60_000;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= limitPerMinute) {
      // Keep the pruned window so a refused call does not extend the block.
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly limiter: RateLimiter;
  constructor(
    clock: () => number = () => Date.now(),
    private readonly audit?: ToolInvocationAudit,
  ) {
    this.limiter = new RateLimiter(clock);
  }
  register(tool: RegisteredTool): void {
    this.tools.set(tool.definition.name, tool);
  }
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }
  list(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }
  async invoke(name: string, input: unknown, context: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`tool_not_found:${name}`);
    const record = async (
      decision: 'denied' | 'executed',
      metadata: Record<string, unknown>,
    ): Promise<void> => {
      if (this.audit)
        await this.audit({ context, definition: tool.definition, decision, metadata });
    };
    if (!tool.definition.enabled) {
      await record('denied', { error: 'tool_disabled' });
      throw new Error(`tool_disabled:${name}`);
    }
    const errors = validateJsonSchema(tool.definition.inputSchema, input);
    if (errors.length) {
      await record('denied', { error: 'tool_input_invalid', violations: errors });
      throw new Error(`tool_input_invalid:${errors.join(',')}`);
    }
    // Checked after schema validation so a malformed call is reported as
    // malformed rather than consuming budget and being reported as throttled.
    if (!this.limiter.check(`${name}:${context.projectId}`, tool.definition.rateLimitPerMinute)) {
      await record('denied', { error: 'tool_rate_limited' });
      throw new Error(`tool_rate_limited:${name}`);
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('tool_timeout')), tool.definition.timeoutMs);
      });
      const result = await Promise.race([tool.execute(input, context), deadline]);
      const output = redactSecrets(result);
      const outputErrors = validateJsonSchema(tool.definition.outputSchema, output);
      if (outputErrors.length) throw new Error(`tool_output_invalid:${outputErrors.join(',')}`);
      const serialized = JSON.stringify(output);
      if (serialized.length > tool.definition.outputLimitBytes)
        throw new Error('tool_output_too_large');
      await record('executed', { outputBytes: Buffer.byteLength(serialized) });
      return output;
    } catch (error) {
      await record('denied', {
        error: redactSecrets((error as Error).message) as string,
      });
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

const toolBase = (
  name: string,
  description: string,
  risk: ToolDefinition['risk'],
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
): ToolDefinition => ({
  id: `tool_${name}`,
  kind: 'tool',
  ownerId: 'system',
  scope: 'system',
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  accessPolicy: {
    visibility: 'organization',
    roles: { owner: ['*'], admin: ['*'], operator: ['run'] },
  },
  name,
  description,
  inputSchema,
  outputSchema,
  requiredScope: 'project',
  resourceScope: 'project',
  risk,
  reversible: risk === 'safe' || risk === 'low',
  authRequired: false,
  timeoutMs: 30_000,
  rateLimitPerMinute: 60,
  outputLimitBytes: 1_000_000,
  releaseVersion: '1.0.0',
  owner: 'bot-buffet',
  enabled: true,
});

export function createBuiltinTools(
  store: JsonStateStore,
  clock: () => number = () => Date.now(),
): ToolRegistry {
  const registry = new ToolRegistry(clock, async ({ context, definition, decision, metadata }) => {
    await store.audit({
      kind: 'audit-event',
      ownerId: context.actorId,
      scope: context.projectId,
      actorId: context.actorId,
      action: decision === 'executed' ? 'tool.executed' : 'tool.denied',
      resourceType: 'run',
      resourceId: context.runId,
      risk: definition.risk,
      decision,
      metadata: { tool: definition.name, ...metadata },
    });
  });
  const runtimes = new Map<string, SandboxRuntime>();
  const sandbox = (workspaceRoot: string): SandboxRuntime => {
    let runtime = runtimes.get(workspaceRoot);
    if (!runtime) {
      runtime = createSandboxRuntime(workspaceRoot);
      runtimes.set(workspaceRoot, runtime);
    }
    return runtime;
  };
  const pathAllowed = (root: string, resolved: string, paths: string[]): boolean =>
    paths.some((allowed) => {
      const base = assertWorkspacePath(root, allowed);
      return resolved === base || resolved.startsWith(`${base}${sep}`);
    });
  const pathProtected = (root: string, resolved: string, paths: string[]): boolean =>
    paths.some((protectedPath) => {
      const base = assertWorkspacePath(root, protectedPath);
      return resolved === base || resolved.startsWith(`${base}${sep}`);
    }) ||
    (() => {
      const relativePath = relative(root, resolved);
      return (
        relativePath === '.git' ||
        relativePath.startsWith(`.git${sep}`) ||
        basename(relativePath).startsWith('.env')
      );
    })();
  registry.register({
    definition: toolBase(
      'memory.write',
      'Record a durable note in a memory namespace this agent may write to.',
      'low',
      {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            enum: ['project', 'agent', 'task', 'session'],
          },
          text: { type: 'string' },
        },
        required: ['namespace', 'text'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          id: { type: 'string' },
          namespace: { type: 'string' },
          namespaceId: { type: 'string' },
          approved: { type: 'boolean' },
        },
        required: ['id', 'namespace', 'namespaceId', 'approved'],
        additionalProperties: false,
      },
    ),
    execute: async (input, context) => {
      const data = input as { namespace: MemoryItem['namespace']; text: string };
      const policy = context.memoryPolicy;
      // No policy means no authority. An agent invoked without one cannot
      // write memory rather than defaulting to permitted.
      if (!policy) throw new Error('memory_write_denied:no_policy');
      if (!canWriteMemory(policy, data.namespace))
        throw new Error(`memory_write_denied:namespace_not_writable:${data.namespace}`);

      // The namespace identity comes from the run, never from the caller, so
      // an agent cannot record a note against another project or agent.
      const namespaceId = {
        project: context.projectId,
        agent: context.agentId,
        task: context.taskId,
        session: context.runId,
      }[data.namespace as 'project' | 'agent' | 'task' | 'session'];
      if (!namespaceId)
        throw new Error(`memory_write_denied:namespace_unresolved:${data.namespace}`);

      const text = String(data.text ?? '').slice(0, 4000);
      if (!text.trim()) throw new Error('memory_write_denied:empty');

      const memory = entity({
        kind: 'memory',
        ownerId: context.actorId,
        scope: namespaceId,
        namespace: data.namespace,
        namespaceId,
        text,
        sourceIds: [],
        // Approval before persistence: when the policy requires it the item is
        // stored unapproved, which keeps it out of agent context until a human
        // approves it. It is recorded either way so nothing is lost.
        approved: !policy.requireApproval,
        freshnessAt: new Date().toISOString(),
      }) as MemoryItem;
      await store.insert(memory);
      await store.audit({
        kind: 'audit-event',
        ownerId: context.actorId,
        scope: context.projectId,
        actorId: context.actorId,
        action: 'memory.written',
        resourceType: 'memory',
        resourceId: memory.id,
        risk: 'low',
        decision: 'allowed',
        metadata: {
          namespace: memory.namespace,
          approved: memory.approved,
          runId: context.runId,
        },
      });
      return {
        id: memory.id,
        namespace: memory.namespace,
        namespaceId: memory.namespaceId,
        approved: memory.approved,
      };
    },
  });
  registry.register({
    definition: toolBase(
      'filesystem.read',
      'Read a file within the project workspace.',
      'safe',
      {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          sha256: { type: 'string' },
          versionLabel: { type: 'string' },
        },
        required: ['path', 'content', 'sha256', 'versionLabel'],
        additionalProperties: false,
      },
    ),
    execute: async (input, context) => {
      const path = String((input as { path: string }).path);
      const resolved = await assertWorkspaceRealPath(context.workspaceRoot, path);
      if (!pathAllowed(context.workspaceRoot, resolved, context.allowedPaths))
        throw new Error('filesystem_read_denied:path_not_allowed');
      if (pathProtected(context.workspaceRoot, resolved, context.protectedPaths))
        throw new Error('filesystem_read_denied:protected_path');
      const content = await sandbox(context.workspaceRoot).readFile(
        relative(context.workspaceRoot, resolved),
        context.signal,
      );
      const relativePath = relative(context.workspaceRoot, resolved);
      const digest = sha256Text(content);
      const existing = await store.get<ProjectFile>(
        projectFileId(context.projectId, canonicalProjectPath(relativePath)),
      );
      const file = existing
        ? existing.sha256 === digest && existing.size === Buffer.byteLength(content)
          ? existing
          : await store.put({
              ...existing,
              sha256: digest,
              size: Buffer.byteLength(content),
              versionLabel: `v${existing.version + 1}`,
            })
        : await store.upsert({
            ...entity({
              kind: 'file',
              ownerId: context.actorId,
              scope: context.projectId,
              projectId: context.projectId,
              path: relativePath,
              sha256: digest,
              size: Buffer.byteLength(content),
              versionLabel: 'v1',
            }),
            id: projectFileId(context.projectId, canonicalProjectPath(relativePath)),
          } as ProjectFile);
      return {
        path: relativePath,
        content,
        sha256: digest,
        versionLabel: file.versionLabel,
      };
    },
  });
  registry.register({
    definition: toolBase(
      'filesystem.write',
      'Write a file within the project workspace.',
      'medium',
      {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          expectedSha256: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'number' },
          sha256: { type: 'string' },
          versionLabel: { type: 'string' },
        },
        required: ['path', 'bytes', 'sha256', 'versionLabel'],
        additionalProperties: false,
      },
    ),
    execute: async (input, context) => {
      const data = input as { path: string; content: string; expectedSha256?: string };
      if (data.expectedSha256 !== undefined && !isSha256(data.expectedSha256))
        throw new Error('filesystem_write_denied:expected_sha256_invalid');
      const resolved = await assertWorkspaceRealPath(context.workspaceRoot, data.path, true);
      if (!pathAllowed(context.workspaceRoot, resolved, context.allowedPaths))
        throw new Error('filesystem_write_denied:path_not_allowed');
      if (pathProtected(context.workspaceRoot, resolved, context.protectedPaths))
        throw new Error('filesystem_write_denied:protected_path');
      if (data.content.length > 5_000_000) throw new Error('filesystem_write_denied:file_size_cap');
      const relativePath = relative(context.workspaceRoot, resolved);
      const fileKey = canonicalProjectPath(relativePath);
      const lockName = `file:${context.projectId}:${fileKey}`;
      if (!(await store.lock(lockName, context.runId, 30_000)))
        throw new Error('filesystem_write_denied:resource_locked');
      try {
        const existing = await store.get<ProjectFile>(projectFileId(context.projectId, fileKey));
        if (data.expectedSha256 !== undefined) {
          let currentContent: string;
          try {
            currentContent = await sandbox(context.workspaceRoot).readFile(
              relativePath,
              context.signal,
            );
          } catch (error) {
            if (String(error).includes('sandbox_read_failed'))
              throw new Error('filesystem_write_conflict:current_file_unreadable');
            throw error;
          }
          const currentDigest = sha256Text(currentContent);
          if (
            currentDigest !== data.expectedSha256 ||
            (existing && existing.sha256 !== currentDigest)
          )
            throw new Error('filesystem_write_conflict:stale_sha256');
        }
        await sandbox(context.workspaceRoot).writeFile(relativePath, data.content, context.signal);
        const digest = sha256Text(data.content);
        const file = {
          ...entity({
            kind: 'file',
            ownerId: context.actorId,
            scope: context.projectId,
            projectId: context.projectId,
            path: relativePath,
            sha256: digest,
            size: Buffer.byteLength(data.content),
            versionLabel: `v${(existing?.version ?? 0) + 1}`,
          }),
          id: projectFileId(context.projectId, fileKey),
        } as ProjectFile;
        const savedFile = await store.upsert(file);
        await store.audit({
          kind: 'audit-event',
          ownerId: context.actorId,
          scope: context.projectId,
          actorId: context.actorId,
          action: 'filesystem.write',
          resourceType: 'file',
          resourceId: `path:${data.path}`,
          risk: 'medium',
          decision: 'executed',
          metadata: {
            runId: context.runId,
            path: data.path,
            sha256: digest,
            versionLabel: savedFile.versionLabel,
            expectedSha256: data.expectedSha256,
          },
        });
      } finally {
        await store.unlock(lockName, context.runId);
      }
      const digest = sha256Text(data.content);
      const version = await store.get<ProjectFile>(projectFileId(context.projectId, fileKey));
      return {
        path: relativePath,
        bytes: Buffer.byteLength(data.content),
        sha256: digest,
        versionLabel: version?.versionLabel ?? 'v1',
      };
    },
  });
  registry.register({
    definition: toolBase(
      'filesystem.stat',
      'Inspect file metadata within the project workspace.',
      'safe',
      {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          path: { type: 'string' },
          size: { type: 'number' },
          isFile: { type: 'boolean' },
        },
        required: ['path', 'size', 'isFile'],
        additionalProperties: false,
      },
    ),
    execute: async (input, context) => {
      const path = String((input as { path: string }).path);
      const resolved = await assertWorkspaceRealPath(context.workspaceRoot, path);
      if (!pathAllowed(context.workspaceRoot, resolved, context.allowedPaths))
        throw new Error('filesystem_stat_denied:path_not_allowed');
      if (pathProtected(context.workspaceRoot, resolved, context.protectedPaths))
        throw new Error('filesystem_stat_denied:protected_path');
      const info = await sandbox(context.workspaceRoot).stat(
        relative(context.workspaceRoot, resolved),
        context.signal,
      );
      return { path, size: info.size, isFile: info.isFile };
    },
  });
  registry.register({
    definition: toolBase(
      'shell.exec',
      'Execute a bounded allowlisted command in the project workspace.',
      'high',
      {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
        },
        required: ['command'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          code: { type: 'number' },
        },
        required: ['stdout', 'stderr', 'code'],
        additionalProperties: false,
      },
    ),
    execute: async (input, context) => {
      const data = input as { command: string; args?: string[] };
      const fullCommand = [data.command, ...(data.args ?? [])].join(' ');
      validateCommand(fullCommand, ['node', 'npm', 'pnpm']);
      const args = data.args ?? [];
      const safeReadOnlyInvocation =
        (data.command === 'node' || data.command === 'npm' || data.command === 'pnpm') &&
        args.length === 1 &&
        ['--version', '--help'].includes(args[0]!);
      if (!safeReadOnlyInvocation) throw new Error('shell_denied:command_not_permitted');
      // Not conditional on the policy any more. Every sandbox refuses a policy
      // other than `blocked`, so gating this on `blocked` only created a path
      // where setting `allowlist` on a profile would relax the check while
      // introducing no host restriction to replace it.
      if (/curl|wget|Invoke-WebRequest|npm|pnpm|npx|git/i.test(fullCommand))
        throw new Error('shell_denied:network_blocked');
      const result = await sandbox(context.workspaceRoot).run(
        data.command,
        data.args ?? [],
        context.network,
        context.signal,
        context.environmentKeys ?? [],
      );
      return {
        stdout: redactSecrets(result.stdout),
        stderr: redactSecrets(result.stderr),
        code: result.code,
      };
    },
  });
  return registry;
}
