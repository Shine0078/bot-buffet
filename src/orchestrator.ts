import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { JsonStateStore } from './store.js';
import {
  Agent,
  ApprovalRequest,
  Checkpoint,
  Model,
  ModelRoute,
  Project,
  Run,
  RunStep,
  Task,
  entity,
  id,
  now,
} from './types.js';
import { ModelAdapter, ModelRequest } from './providers.js';
import { ModelRouter } from './router.js';
import { ToolContext, ToolRegistry } from './tools.js';
import { decidePolicy, redactSecrets } from './security.js';
import { assembleContext } from './context.js';

export interface OrchestratorDeps {
  store: JsonStateStore;
  router: ModelRouter;
  adapters: (model: Model) => ModelAdapter;
  tools: ToolRegistry;
  workspaceRoot: (project: Project) => string;
}
export interface RunCommand {
  runId: string;
  type: 'pause' | 'resume' | 'cancel' | 'stop' | 'fork' | 'rollback';
  checkpointId?: string;
}

export class Orchestrator extends EventEmitter {
  private readonly controllers = new Map<string, AbortController>();
  private readonly runPromises = new Map<string, Promise<void>>();
  constructor(private readonly deps: OrchestratorDeps) {
    super();
  }

  async createRun(input: {
    ownerId: string;
    project: Project;
    agent: Agent;
    task: Task;
    mode?: Run['mode'];
    maxSteps?: number;
    parentRunId?: string;
  }): Promise<Run> {
    const run = entity({
      kind: 'run',
      ownerId: input.ownerId,
      scope: input.project.id,
      projectId: input.project.id,
      environmentId: input.agent.environmentId,
      agentId: input.agent.id,
      taskId: input.task.id,
      mode: input.mode ?? input.agent.profile.mode,
      status: 'queued' as const,
      stepCount: 0,
      maxSteps: input.maxSteps ?? input.agent.profile.maxSteps,
      cancelRequested: false,
      parentRunId: input.parentRunId,
      costCents: 0,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
    }) as Run;
    await this.deps.store.insert(run);
    await this.emitAudit(run, 'run.created', 'safe', 'executed', { taskId: input.task.id });
    return run;
  }

  async start(runId: string): Promise<void> {
    if (this.runPromises.has(runId)) return;
    const promise = this.execute(runId).finally(() => this.runPromises.delete(runId));
    this.runPromises.set(runId, promise);
    await promise;
  }

  private async execute(runId: string): Promise<void> {
    const run = await this.deps.store.get<Run>(runId);
    if (!run) throw new Error('run_not_found');
    const agent = await this.deps.store.get<Agent>(run.agentId);
    const task = run.taskId ? await this.deps.store.get<Task>(run.taskId) : undefined;
    const project = await this.deps.store.get<Project>(run.projectId);
    if (!agent || !project || !task) throw new Error('run_context_missing');
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    await this.updateRun(run, {
      status: 'running',
      startedAt: run.startedAt ?? now(),
      pausedAt: undefined,
      cancelRequested: false,
    });
    try {
      for (let sequence = run.stepCount + 1; sequence <= run.maxSteps; sequence += 1) {
        const current = await this.deps.store.get<Run>(runId);
        if (!current) throw new Error('run_deleted');
        if (current.cancelRequested || controller.signal.aborted) {
          await this.updateRun(current, { status: 'cancelled', finishedAt: now() });
          break;
        }
        if (current.status === 'paused') {
          this.emit('run', { type: 'run.paused', run: current });
          return;
        }
        const state = await this.deps.store.getRunState(runId);
        const assembled = assembleContext(
          [
            {
              id: task.id,
              text: `Task: ${task.title}\n${task.description}\nAcceptance: ${task.acceptanceCriteria.join('; ')}`,
              scope: 'task',
              relevance: 1,
              sourceIds: [],
            },
            {
              id: `${run.id}:state`,
              text: `State: ${JSON.stringify(redactSecrets(state))}`,
              scope: 'run',
              relevance: 0.8,
              sourceIds: [],
            },
          ],
          Math.max(128, Math.min(2048, Math.floor(agent.profile.tokenLimit / 4))),
        );
        const request: ModelRequest = {
          model: '',
          messages: [
            {
              role: 'system',
              content: `${agent.profile.systemInstructions}\nProject rules: ${agent.profile.projectRules.join('\n')}`,
            },
            {
              role: 'user',
              content: assembled.text,
            },
          ],
          maxTokens: Math.min(agent.profile.tokenLimit, 4096),
          responseFormat: agent.profile.outputFormat === 'json' ? 'json' : 'text',
          signal: controller.signal,
        };
        const route = await this.deps.store.list<ModelRoute>(
          (x) =>
            x.kind === 'model-route' &&
            (x.projectId === run.projectId || x.agentId === run.agentId),
        );
        const decision = await this.deps.router.choose(
          {
            contextTokens: 4096,
            privacy: 'private',
            localPreferred: true,
            offline: process.env.BOT_BUFFET_OFFLINE === 'true',
          },
          route[0],
        );
        const model = await this.deps.store.get<Model>(decision.modelId);
        if (!model) throw new Error('model_not_found');
        request.model = model.modelName;
        const step = entity({
          kind: 'run-step',
          ownerId: run.ownerId,
          scope: run.projectId,
          runId,
          sequence,
          type: 'model',
          status: 'started',
          name: 'model.complete',
          input: redactSecrets(request),
          startedAt: now(),
          redacted: true,
        });
        await this.deps.store.insert(step);
        const response = await this.deps.adapters(model).complete(request);
        await this.deps.store.put({
          ...step,
          status: 'succeeded',
          output: redactSecrets({
            content: response.content,
            toolCalls: response.toolCalls,
            usage: response.usage,
          }),
          finishedAt: now(),
          durationMs: response.latencyMs,
          updatedAt: now(),
          version: step.version,
        } as RunStep);
        const nextState: Record<string, unknown> = {
          ...state,
          lastResponse: response.content,
          lastModel: model.id,
          lastStep: sequence,
        };
        if (response.toolCalls.length) {
          for (const call of response.toolCalls) {
            const tool = this.deps.tools.get(call.name);
            if (!tool) throw new Error(`tool_not_found:${call.name}`);
            const decisionPolicy = decidePolicy(
              tool.definition.risk,
              run.projectId,
              call.name,
              agent.profile.approvalPolicy.requiredRisks.map((risk) => ({
                action: '*',
                effect: 'approval' as const,
                risks: [risk],
              })),
            );
            if (
              decisionPolicy.decision === 'approval-required' ||
              agent.profile.approvalPolicy.requiredRisks.includes(tool.definition.risk)
            ) {
              await this.requestApproval(
                run,
                step.id,
                tool.definition.risk,
                call.name,
                call.arguments,
              );
              await this.updateRun(current, { status: 'waiting_approval' });
              return;
            }
            const context: ToolContext = {
              actorId: run.ownerId,
              runId,
              projectId: run.projectId,
              workspaceRoot: this.deps.workspaceRoot(project),
              allowedPaths: agent.profile.allowedPaths,
              protectedPaths: agent.profile.protectedPaths,
              network: agent.profile.network,
              signal: controller.signal,
            };
            const output = await this.deps.tools.invoke(call.name, call.arguments, context);
            nextState[`tool:${call.name}`] = redactSecrets(output);
            this.emit('run', { type: 'tool.executed', runId, tool: call.name });
          }
        }
        const verification = await this.verify(task, nextState);
        const verifyStep = entity({
          kind: 'run-step',
          ownerId: run.ownerId,
          scope: run.projectId,
          runId,
          sequence: sequence + 0.5,
          type: 'verification',
          status: verification.passed ? 'succeeded' : 'failed',
          name: 'verification.acceptance',
          input: { criteria: task.acceptanceCriteria },
          output: verification,
          startedAt: now(),
          finishedAt: now(),
          durationMs: 0,
          redacted: true,
        });
        await this.deps.store.insert(verifyStep);
        await this.deps.store.setRunState(runId, nextState);
        const checkpoint = entity({
          kind: 'checkpoint',
          ownerId: run.ownerId,
          scope: run.projectId,
          runId,
          sequence,
          stateHash: createHash('sha256').update(JSON.stringify(nextState)).digest('hex'),
          state: nextState,
          files: [],
          createdBy: 'system',
        });
        await this.deps.store.insert(checkpoint);
        await this.updateRun(current, {
          stepCount: sequence,
          checkpointId: checkpoint.id,
          tokensIn: current.tokensIn + response.usage.inputTokens,
          tokensOut: current.tokensOut + response.usage.outputTokens,
          latencyMs: current.latencyMs + response.latencyMs,
          status: verification.passed ? 'completed' : 'running',
          finishedAt: verification.passed ? now() : undefined,
        });
        if (verification.passed) break;
      }
      const final = await this.deps.store.get<Run>(runId);
      if (final && final.status === 'running')
        await this.updateRun(final, {
          status: 'failed',
          error: 'max_steps_exceeded',
          finishedAt: now(),
        });
    } catch (error) {
      const current = await this.deps.store.get<Run>(runId);
      if (current)
        await this.updateRun(current, {
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          error: redactSecrets((error as Error).message) as string,
          finishedAt: now(),
        });
    } finally {
      this.controllers.delete(runId);
    }
  }

  private async verify(
    task: Task,
    state: Record<string, unknown>,
  ): Promise<{ passed: boolean; evidence: string[] }> {
    const text = JSON.stringify(state);
    const evidence = task.acceptanceCriteria.filter((criterion) =>
      text.toLowerCase().includes(criterion.toLowerCase()),
    );
    return {
      passed:
        task.acceptanceCriteria.length === 0 || evidence.length === task.acceptanceCriteria.length,
      evidence,
    };
  }
  private async updateRun(run: Run, changes: Partial<Run>): Promise<void> {
    const latest = (await this.deps.store.get<Run>(run.id)) ?? run;
    const saved = await this.deps.store.put({
      ...latest,
      ...changes,
      updatedAt: now(),
      version: latest.version,
    } as Run);
    this.emit('run', { type: `run.${saved.status}`, run: saved });
  }
  private async requestApproval(
    run: Run,
    stepId: string,
    risk: ApprovalRequest['risk'],
    action: string,
    payload: unknown,
  ): Promise<ApprovalRequest> {
    const request = entity({
      kind: 'approval-request',
      ownerId: run.ownerId,
      scope: run.projectId,
      runId: run.id,
      stepId,
      risk,
      action,
      payload: redactSecrets(payload),
      status: 'pending' as const,
      requestedAt: now(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    }) as ApprovalRequest;
    await this.deps.store.insert(request);
    await this.emitAudit(run, 'approval.requested', risk, 'approval-required', {
      approvalId: request.id,
      action,
    });
    this.emit('run', { type: 'approval.requested', approval: request });
    return request;
  }
  private async emitAudit(
    run: Run,
    action: string,
    risk: RunStep['type'] extends never ? never : 'safe' | 'low' | 'medium' | 'high' | 'critical',
    decision: 'allowed' | 'denied' | 'approval-required' | 'executed',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.store.audit({
      kind: 'audit-event',
      ownerId: run.ownerId,
      scope: run.projectId,
      actorId: run.ownerId,
      action,
      resourceType: 'run',
      resourceId: run.id,
      risk,
      decision,
      metadata,
    });
  }

  async command(command: RunCommand): Promise<Run | undefined> {
    const run = await this.deps.store.get<Run>(command.runId);
    if (!run) return undefined;
    if (command.type === 'pause')
      return this.deps.store.put({
        ...run,
        status: 'paused',
        pausedAt: now(),
        version: run.version,
      } as Run);
    if (command.type === 'resume') {
      await this.deps.store.put({
        ...run,
        status: 'queued',
        pausedAt: undefined,
        version: run.version,
      } as Run);
      void this.start(run.id);
      return this.deps.store.get<Run>(run.id);
    }
    if (command.type === 'cancel' || command.type === 'stop') {
      const controller = this.controllers.get(run.id);
      controller?.abort();
      return this.deps.store.put({
        ...run,
        cancelRequested: true,
        status: 'cancelled',
        finishedAt: now(),
        version: run.version,
      } as Run);
    }
    if (command.type === 'fork') {
      const checkpoint = command.checkpointId
        ? await this.deps.store.get<Checkpoint>(command.checkpointId)
        : undefined;
      const fork = {
        ...run,
        id: id('run'),
        parentRunId: run.id,
        checkpointId: checkpoint?.id,
        status: 'queued' as const,
        stepCount: checkpoint?.sequence ?? run.stepCount,
        startedAt: undefined,
        finishedAt: undefined,
        cancelRequested: false,
        error: undefined,
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      await this.deps.store.insert(fork);
      return fork;
    }
    if (command.type === 'rollback')
      return this.deps.store.put({
        ...run,
        status: 'rolled_back',
        checkpointId: command.checkpointId,
        updatedAt: now(),
        version: run.version,
      } as Run);
    return run;
  }
}
