import { basename, relative, sep } from 'node:path';
import { JsonStateStore } from './store.js';
import { ToolDefinition, ID, JsonSchema } from './types.js';
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
  workspaceRoot: string;
  allowedPaths: string[];
  protectedPaths: string[];
  network: 'blocked' | 'allowlist' | 'open';
  signal?: AbortSignal;
}
export interface RegisteredTool {
  definition: ToolDefinition;
  execute: (input: unknown, context: ToolContext) => Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
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
    const errors = validateJsonSchema(tool.definition.inputSchema, input);
    if (errors.length) throw new Error(`tool_input_invalid:${errors.join(',')}`);
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
      return output;
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

export function createBuiltinTools(store: JsonStateStore): ToolRegistry {
  const registry = new ToolRegistry();
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
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
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
      return {
        path: relative(context.workspaceRoot, resolved),
        content: await sandbox(context.workspaceRoot).readFile(
          relative(context.workspaceRoot, resolved),
          context.signal,
        ),
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
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { path: { type: 'string' }, bytes: { type: 'number' } },
        required: ['path', 'bytes'],
        additionalProperties: false,
      },
    ),
    execute: async (input, context) => {
      const data = input as { path: string; content: string };
      const resolved = await assertWorkspaceRealPath(context.workspaceRoot, data.path, true);
      if (!pathAllowed(context.workspaceRoot, resolved, context.allowedPaths))
        throw new Error('filesystem_write_denied:path_not_allowed');
      if (pathProtected(context.workspaceRoot, resolved, context.protectedPaths))
        throw new Error('filesystem_write_denied:protected_path');
      if (data.content.length > 5_000_000) throw new Error('filesystem_write_denied:file_size_cap');
      const relativePath = relative(context.workspaceRoot, resolved);
      const lockName = `file:${context.projectId}:${relativePath}`;
      if (!(await store.lock(lockName, context.runId, 30_000)))
        throw new Error('filesystem_write_denied:resource_locked');
      try {
        await sandbox(context.workspaceRoot).writeFile(relativePath, data.content, context.signal);
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
          metadata: { runId: context.runId, path: data.path },
        });
      } finally {
        await store.unlock(lockName, context.runId);
      }
      return { path: data.path, bytes: Buffer.byteLength(data.content) };
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
