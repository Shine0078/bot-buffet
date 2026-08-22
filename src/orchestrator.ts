import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { JsonStateStore } from './store.js';
import {
  Agent,
  Alert,
  ApprovalRequest,
  Budget,
  Checkpoint,
  CostRecord,
  Environment,
  MemoryItem,
  Model,
  ModelRoute,
  Project,
  Run,
  RunStep,
  Task,
  UsageRecord,
  Workspace,
  entity,
  id,
  now,
} from './types.js';
import { ModelAdapter, ModelRequest, ModelResponse } from './providers.js';
import { ModelRouter } from './router.js';
import { ToolContext, ToolRegistry } from './tools.js';
import { decidePolicy, redactSecrets } from './security.js';
import { assembleContext, memoryToContext } from './context.js';
import { BudgetDecision, estimateCostCents, evaluateBudgets } from './budgets.js';
import { labelUntrusted } from './injection.js';
import { canStartInMode, decideMode, escalationOutcome } from './modes.js';
import { verifyDeterministic } from './verification.js';
import { selectReadableMemory } from './memoryScope.js';

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
  private readonly activeAgentRuns = new Map<string, number>();
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
    const run = await this.deps.store.get<Run>(runId);
    if (!run) throw new Error('run_not_found');
    const agent = await this.deps.store.get<Agent>(run.agentId);
    const limit = Math.max(1, agent?.profile.concurrencyLimit ?? 1);
    const active = this.activeAgentRuns.get(run.agentId) ?? 0;
    if (active >= limit) {
      const blocked = await this.deps.store.put({
        ...run,
        status: 'blocked',
        error: 'agent_concurrency_limit',
        finishedAt: now(),
        version: run.version,
      } as Run);
      this.emit('run', { type: 'run.blocked', run: blocked });
      return;
    }
    this.activeAgentRuns.set(run.agentId, active + 1);
    const promise = this.execute(runId).finally(() => {
      this.runPromises.delete(runId);
      const remaining = (this.activeAgentRuns.get(run.agentId) ?? 1) - 1;
      if (remaining > 0) this.activeAgentRuns.set(run.agentId, remaining);
      else this.activeAgentRuns.delete(run.agentId);
    });
    this.runPromises.set(runId, promise);
    await promise;
  }

  private async execute(runId: string): Promise<void> {
    const run = await this.deps.store.get<Run>(runId);
    if (!run) throw new Error('run_not_found');
    const agent = await this.deps.store.get<Agent>(run.agentId);
    const environment = await this.deps.store.get<Environment>(run.environmentId);
    const task = run.taskId ? await this.deps.store.get<Task>(run.taskId) : undefined;
    const project = await this.deps.store.get<Project>(run.projectId);
    const workspace = project
      ? await this.deps.store.get<Workspace>(project.workspaceId)
      : undefined;
    if (!agent || !project || !task) throw new Error('run_context_missing');
    // Emergency stop is a mode, not just a button: a run carrying it must not
    // execute a single step, whichever path started it.
    if (!canStartInMode(run.mode)) {
      await this.updateRun(run, {
        status: 'blocked',
        error: 'mode_run_halted',
        finishedAt: now(),
      });
      await this.emitAudit(run, 'run.mode_halted', 'medium', 'denied', { mode: run.mode });
      return;
    }
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
        if (
          agent.profile.timeLimitMs > 0 &&
          Date.now() - Date.parse(current.startedAt ?? now()) > agent.profile.timeLimitMs
        ) {
          await this.updateRun(current, {
            status: 'blocked',
            error: 'time_limit_exceeded',
            finishedAt: now(),
          });
          return;
        }
        if (agent.profile.costLimitCents > 0 && current.costCents >= agent.profile.costLimitCents) {
          await this.updateRun(current, {
            status: 'blocked',
            error: 'cost_limit_exceeded',
            finishedAt: now(),
          });
          return;
        }
        if (current.cancelRequested || controller.signal.aborted) {
          await this.updateRun(current, { status: 'cancelled', finishedAt: now() });
          break;
        }
        if (current.status === 'paused') {
          this.emit('run', { type: 'run.paused', run: current });
          return;
        }
        const state = await this.deps.store.getRunState(runId);
        // Load the memory this agent is permitted to see. The policy's
        // readable scopes are paired with this run's own identities, so a
        // readable namespace means this project's memory rather than every
        // project's — without that pairing a readable scope is a cross-tenant
        // read.
        const memorySelection = selectReadableMemory(
          await this.deps.store.list<MemoryItem>((x) => x.kind === 'memory'),
          agent.profile.memoryPolicy,
          {
            ownerId: run.ownerId,
            workspaceId: project.workspaceId,
            projectId: run.projectId,
            environmentId: run.environmentId,
            agentId: run.agentId,
            taskId: run.taskId,
            runId: run.id,
          },
        );
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
            // Memory competes for the same budget as everything else and is
            // ranked below the task and current state, so a large memory store
            // compacts rather than crowding out the work in hand.
            ...memorySelection.readable.map((item) => memoryToContext(item, 0.6)),
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
        const offline =
          process.env.BOT_BUFFET_OFFLINE === 'true' || workspace?.offlineMode === true;
        const decision = await this.deps.router.choose(
          {
            contextTokens: 4096,
            privacy: 'private',
            localPreferred: true,
            offline,
            allowedModelIds: agent.profile.allowedModels,
            preferredModelId: agent.profile.preferredModelId,
            fallbackModelIds: agent.profile.fallbackModelIds,
            estimatedOutputTokens: Math.min(agent.profile.tokenLimit, 4096),
            scopeIds: [project.id, project.workspaceId],
          },
          route[0],
        );
        const model = await this.deps.store.get<Model>(decision.modelId);
        if (!model) throw new Error('model_not_found');
        request.model = model.modelName;
        const estimatedCostCents = estimateCostCents(
          model,
          assembled.estimatedTokens,
          request.maxTokens ?? 0,
        );
        const preflight = await this.evaluateBudgets(
          run.projectId,
          run.agentId,
          estimatedCostCents,
        );
        for (const warning of preflight.warnings) {
          this.emit('run', { type: 'budget.warning', runId, budget: warning });
          await this.raiseAlert(run, 'warning', 'Budget warning', warning.budgetId, {
            budget: warning.name,
            projectedCents: warning.projectedCents,
            limitCents: warning.limitCents,
          });
        }
        if (!preflight.allowed) {
          await this.updateRun(current, {
            status: 'blocked',
            error: 'budget_exceeded',
            finishedAt: now(),
          });
          this.emit('run', { type: 'budget.exceeded', runId, budget: preflight.blockedBy });
          await this.raiseAlert(
            run,
            'critical',
            'Budget exceeded',
            preflight.blockedBy?.budgetId ?? run.projectId,
            {
              budget: preflight.blockedBy?.name,
              limitCents: preflight.blockedBy?.limitCents,
              runId,
            },
          );
          await this.deps.store.audit({
            kind: 'audit-event',
            ownerId: run.ownerId,
            scope: run.projectId,
            actorId: run.ownerId,
            action: 'budget.blocked',
            resourceType: 'budget',
            resourceId: preflight.blockedBy?.budgetId ?? run.projectId,
            risk: 'high',
            decision: 'denied',
            metadata: {
              runId,
              period: preflight.blockedBy?.period,
              limitCents: preflight.blockedBy?.limitCents,
            },
          });
          return;
        }
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
        const response = await this.completeWithRetry(
          this.deps.adapters(model),
          request,
          2,
          run.id,
          run.projectId,
        );
        const responsePreview = redactSecrets(response.content.slice(0, 1000));
        const stepCostCents = estimateCostCents(
          model,
          response.usage.inputTokens,
          response.usage.outputTokens,
        );
        await this.deps.store.insert(
          entity({
            kind: 'usage',
            ownerId: run.ownerId,
            scope: run.agentId,
            runId,
            projectId: run.projectId,
            agentId: run.agentId,
            modelId: model.id,
            tokensIn: response.usage.inputTokens,
            tokensOut: response.usage.outputTokens,
            latencyMs: response.latencyMs,
            costCents: stepCostCents,
            recordedAt: now(),
          }) as UsageRecord,
        );
        await this.deps.store.insert(
          entity({
            kind: 'cost',
            ownerId: run.ownerId,
            scope: run.agentId,
            runId,
            projectId: run.projectId,
            agentId: run.agentId,
            amountCents: stepCostCents,
            currency: 'USD',
            category: 'model',
          }) as CostRecord,
        );
        const nextTokensIn = current.tokensIn + response.usage.inputTokens;
        const nextTokensOut = current.tokensOut + response.usage.outputTokens;
        if (
          agent.profile.tokenLimit > 0 &&
          nextTokensIn + nextTokensOut > agent.profile.tokenLimit
        ) {
          await this.updateRun(current, {
            status: 'blocked',
            error: 'token_limit_exceeded',
            finishedAt: now(),
          });
          return;
        }
        if (
          agent.profile.costLimitCents > 0 &&
          current.costCents + stepCostCents > agent.profile.costLimitCents
        ) {
          await this.updateRun(current, {
            status: 'blocked',
            error: 'cost_limit_exceeded',
            finishedAt: now(),
          });
          return;
        }
        await this.deps.store.put({
          ...step,
          status: 'succeeded',
          output: redactSecrets({
            content: responsePreview,
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
          lastResponse: responsePreview,
          lastModel: model.id,
          lastStep: sequence,
        };
        if (response.toolCalls.length) {
          for (const call of response.toolCalls) {
            const tool = this.deps.tools.get(call.name);
            if (!tool) throw new Error(`tool_not_found:${call.name}`);
            if (!tool.definition.enabled) throw new Error(`tool_disabled:${call.name}`);
            if (
              !agent.profile.allowedToolIds.includes(tool.definition.id) &&
              !agent.profile.allowedToolIds.includes(tool.definition.name)
            )
              throw new Error(`tool_not_allowed:${call.name}`);
            // The run's mode constrains what this step may do, in addition to
            // the policy below and never instead of it. A mode can only narrow
            // what policy already permits, so selecting one is never an
            // escalation.
            const modeDecision = decideMode(run.mode, tool.definition.risk);
            if (!modeDecision.allowed) {
              await this.deps.store.audit({
                kind: 'audit-event',
                ownerId: run.ownerId,
                scope: run.projectId,
                actorId: run.ownerId,
                action: 'tool.mode_refused',
                resourceType: 'run',
                resourceId: run.id,
                risk: tool.definition.risk,
                decision: 'denied',
                metadata: {
                  mode: run.mode,
                  tool: call.name,
                  code: modeDecision.code,
                  reason: modeDecision.reason,
                },
              });
              throw new Error(`${modeDecision.code}:${call.name}`);
            }
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
              // The mode's own approval threshold. Supervised mode approves
              // every action that is not read-only, which policy alone would
              // not require.
              modeDecision.requiresApproval ||
              tool.definition.risk === 'high' ||
              tool.definition.risk === 'critical' ||
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
              agentId: run.agentId,
              taskId: run.taskId,
              memoryPolicy: agent.profile.memoryPolicy,
              workspaceRoot: this.deps.workspaceRoot(project),
              allowedPaths: agent.profile.allowedPaths,
              protectedPaths: agent.profile.protectedPaths,
              network: [agent.profile.network, environment?.network ?? 'blocked'].sort(
                (a, b) =>
                  ({ blocked: 0, allowlist: 1, open: 2 })[a] -
                  { blocked: 0, allowlist: 1, open: 2 }[b],
              )[0] as ToolContext['network'],
              signal: controller.signal,
            };
            const output = await this.deps.tools.invoke(call.name, call.arguments, context);
            // Tool output is external data. Label it untrusted before it can re-enter model
            // context, and record any instruction-shaped payload it carries.
            const labeled = labelUntrusted(
              typeof output === 'string' ? output : JSON.stringify(output),
              `tool:${call.name}`,
            );
            nextState[`tool:${call.name}`] = redactSecrets(output);
            nextState[`tool:${call.name}:trust`] = labeled.trust;
            if (labeled.signals.length) {
              nextState[`tool:${call.name}:injection`] = labeled.signals.map(
                (signal) => signal.pattern,
              );
              await this.emitAudit(
                run,
                'tool.untrusted_content',
                labeled.suspicious ? 'high' : 'low',
                labeled.suspicious ? 'approval-required' : 'allowed',
                { tool: call.name, signals: labeled.signals.map((signal) => signal.pattern) },
              );
              this.emit('run', {
                type: 'injection.detected',
                runId,
                tool: call.name,
                signals: labeled.signals.map((signal) => signal.pattern),
              });
            }
            this.emit('run', { type: 'tool.executed', runId, tool: call.name });
          }
        }
        const verification = verifyDeterministic(agent.profile.verificationPolicy, {
          task,
          state: nextState,
        });
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
          tokensIn: nextTokensIn,
          tokensOut: nextTokensOut,
          costCents: current.costCents + stepCostCents,
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
      if (current) {
        const message = redactSecrets((error as Error).message) as string;
        if (controller.signal.aborted) {
          await this.updateRun(current, {
            status: 'cancelled',
            error: message,
            finishedAt: now(),
          });
        } else {
          // The profile's escalation policy decides what a failure means.
          // It was validated on write and never consulted, so every failure
          // ended the run regardless of what the operator had chosen.
          const escalation = agent.profile.escalationPolicy;
          const outcome = escalationOutcome(escalation);
          await this.updateRun(current, {
            status: outcome.status,
            error: message,
            // A paused run keeps its checkpoint and can be resumed, so it must
            // not be stamped as finished.
            finishedAt: outcome.status === 'paused' ? undefined : now(),
            pausedAt: outcome.status === 'paused' ? now() : undefined,
          });
          await this.emitAudit(current, 'run.escalated', 'medium', 'executed', {
            escalationPolicy: escalation,
            status: outcome.status,
            reason: outcome.reason,
          });
        }
      }
    } finally {
      this.controllers.delete(runId);
    }
  }

  private async completeWithRetry(
    adapter: ModelAdapter,
    request: ModelRequest,
    maxRetries: number,
    runId: string,
    projectId: string,
  ): Promise<ModelResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const started = Date.now();
        let responseId = `stream_${Date.now()}`;
        let content = '';
        let usage: ModelResponse['usage'] = { inputTokens: 0, outputTokens: 0 };
        const toolArguments = new Map<string, { id: string; name: string; arguments: string }>();
        let receivedChunk = false;
        for await (const chunk of adapter.stream(request)) {
          receivedChunk = true;
          responseId = chunk.id || responseId;
          content += chunk.delta;
          if (chunk.usage) usage = chunk.usage;
          for (const toolCall of chunk.toolCalls ?? []) {
            const key = toolCall.id ?? `${toolCall.name ?? 'tool'}:${toolArguments.size}`;
            const current = toolArguments.get(key) ?? {
              id: toolCall.id ?? key,
              name: toolCall.name ?? 'unknown',
              arguments: '',
            };
            if (toolCall.name) current.name = toolCall.name;
            if (toolCall.arguments) current.arguments += toolCall.arguments;
            toolArguments.set(key, current);
          }
          this.emit('run', {
            type: 'model.delta',
            runId,
            projectId,
            id: responseId,
            delta: redactSecrets(chunk.delta),
            done: chunk.done,
          });
        }
        if (!receivedChunk) throw new Error('model_stream_empty');
        const toolCalls = [...toolArguments.values()].map((call) => {
          let parsed: Record<string, unknown> = {};
          if (call.arguments) {
            try {
              const candidate: unknown = JSON.parse(call.arguments);
              if (candidate && typeof candidate === 'object' && !Array.isArray(candidate))
                parsed = candidate as Record<string, unknown>;
            } catch {
              throw new Error('model_tool_arguments_invalid');
            }
          }
          return { id: call.id, name: call.name, arguments: parsed };
        });
        return {
          id: responseId,
          content,
          toolCalls,
          usage,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        lastError = error;
        if (request.signal?.aborted || attempt === maxRetries) throw error;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 250 * 2 ** attempt);
          request.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('run_cancelled'));
            },
            { once: true },
          );
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error('model_retry_failed');
  }
  /** Persist an operator-visible alert scoped to the run's project. */
  private async raiseAlert(
    run: Run,
    severity: Alert['severity'],
    title: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.store.insert(
      entity({
        kind: 'alert',
        ownerId: run.ownerId,
        scope: run.projectId,
        severity,
        title,
        message: JSON.stringify(redactSecrets(metadata)).slice(0, 500),
        acknowledged: false,
        resourceId,
      }) as Alert,
    );
  }
  /** Aggregate every budget that applies to this project/agent pair and decide admission. */
  private async evaluateBudgets(
    projectId: string,
    agentId: string,
    additionalCents: number,
  ): Promise<BudgetDecision> {
    const budgets = await this.deps.store.list<Budget>(
      (x) => x.kind === 'budget' && (x as Budget).projectId === projectId,
    );
    if (!budgets.length)
      return { allowed: true, warnings: [], statuses: [] } satisfies BudgetDecision;
    const usage = await this.deps.store.list<UsageRecord>((x) => x.kind === 'usage');
    const costs = await this.deps.store.list<CostRecord>((x) => x.kind === 'cost');
    return evaluateBudgets(
      budgets,
      { projectId, agentId },
      { usage, costs },
      additionalCents,
      new Date(),
    );
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
      if (command.checkpointId && (!checkpoint || checkpoint.runId !== run.id))
        throw new Error('checkpoint_scope_mismatch');
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
      if (checkpoint) await this.deps.store.setRunState(fork.id, checkpoint.state);
      return fork;
    }
    if (command.type === 'rollback') {
      let checkpoint: Checkpoint | undefined;
      if (command.checkpointId) {
        checkpoint = await this.deps.store.get<Checkpoint>(command.checkpointId);
        if (!checkpoint || checkpoint.runId !== run.id)
          throw new Error('checkpoint_scope_mismatch');
      }
      if (checkpoint) await this.deps.store.setRunState(run.id, checkpoint.state);
      return this.deps.store.put({
        ...run,
        status: 'rolled_back',
        checkpointId: command.checkpointId,
        updatedAt: now(),
        version: run.version,
      } as Run);
    }
    return run;
  }
}
