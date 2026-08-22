import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { RateLimiter, createBuiltinTools, type ToolContext } from '../src/tools.js';
import type { MemoryPolicy } from '../src/types.js';

/**
 * `rateLimitPerMinute` was declared on every tool definition and enforced
 * nowhere, so a looping agent could call a tool without limit.
 */

const memoryPolicy: MemoryPolicy = {
  readableScopes: ['task'],
  writableScopes: ['task'],
  requireApproval: false,
  retentionDays: 0,
};

describe('rate limiter', () => {
  it('allows calls up to the limit and refuses the next one', () => {
    const limiter = new RateLimiter(() => 1_000);
    for (let index = 0; index < 3; index += 1) {
      expect(limiter.check('tool:project', 3), `call ${index}`).toBe(true);
    }
    expect(limiter.check('tool:project', 3)).toBe(false);
  });

  it('lets the window roll forward', () => {
    let clock = 1_000;
    const limiter = new RateLimiter(() => clock);
    expect(limiter.check('k', 1)).toBe(true);
    expect(limiter.check('k', 1)).toBe(false);
    clock += 60_001;
    expect(limiter.check('k', 1)).toBe(true);
  });

  it('does not extend the block when a refused call is retried', () => {
    // A refused call must not count against the window, or a client polling
    // during a block would never escape it.
    let clock = 1_000;
    const limiter = new RateLimiter(() => clock);
    expect(limiter.check('k', 1)).toBe(true);
    for (let index = 0; index < 5; index += 1) {
      clock += 1_000;
      expect(limiter.check('k', 1)).toBe(false);
    }
    clock = 1_000 + 60_001;
    expect(limiter.check('k', 1)).toBe(true);
  });

  it('keys separately, so one project cannot starve another', () => {
    const limiter = new RateLimiter(() => 1_000);
    expect(limiter.check('tool:project-a', 1)).toBe(true);
    expect(limiter.check('tool:project-a', 1)).toBe(false);
    expect(limiter.check('tool:project-b', 1)).toBe(true);
  });

  it('treats a non-positive limit as unlimited rather than as forbidden', () => {
    // A tool with no declared limit must not become unusable.
    const limiter = new RateLimiter(() => 1_000);
    for (const limit of [0, -1, Number.NaN]) {
      for (let index = 0; index < 50; index += 1) {
        expect(limiter.check(`k${limit}`, limit), String(limit)).toBe(true);
      }
    }
  });
});

describe('tool invocation is rate limited', () => {
  async function setup(clock: () => number) {
    const dir = await mkdtemp(join(tmpdir(), 'bot-buffet-rate-'));
    const store = createStore(dir);
    const tools = createBuiltinTools(store, clock);
    const context: ToolContext = {
      actorId: 'user-1',
      runId: 'run-1',
      projectId: 'project-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      workspaceRoot: dir,
      allowedPaths: ['.'],
      protectedPaths: [],
      network: 'blocked',
      memoryPolicy,
    };
    return { tools, context };
  }

  it('refuses a tool once its declared limit is reached', async () => {
    const { tools, context } = await setup(() => 1_000);
    const limit = tools.get('memory.write')!.definition.rateLimitPerMinute;
    for (let index = 0; index < limit; index += 1) {
      await tools.invoke('memory.write', { namespace: 'task', text: `note ${index}` }, context);
    }
    await expect(
      tools.invoke('memory.write', { namespace: 'task', text: 'one too many' }, context),
    ).rejects.toThrow(/tool_rate_limited/);
  });

  it('reports a malformed call as malformed rather than as throttled', async () => {
    // Schema validation runs first, so a bad call does not consume budget.
    const { tools, context } = await setup(() => 1_000);
    for (let index = 0; index < 200; index += 1) {
      await expect(tools.invoke('memory.write', { namespace: 'task' }, context)).rejects.toThrow(
        /tool_input_invalid/,
      );
    }
    await expect(
      tools.invoke('memory.write', { namespace: 'task', text: 'still fine' }, context),
    ).resolves.toBeTruthy();
  });

  it('recovers once the window rolls', async () => {
    let clock = 1_000;
    const { tools, context } = await setup(() => clock);
    const limit = tools.get('memory.write')!.definition.rateLimitPerMinute;
    for (let index = 0; index < limit; index += 1) {
      await tools.invoke('memory.write', { namespace: 'task', text: `note ${index}` }, context);
    }
    await expect(
      tools.invoke('memory.write', { namespace: 'task', text: 'blocked' }, context),
    ).rejects.toThrow(/tool_rate_limited/);
    clock += 60_001;
    await expect(
      tools.invoke('memory.write', { namespace: 'task', text: 'allowed again' }, context),
    ).resolves.toBeTruthy();
  });

  it('limits each project separately', async () => {
    const { tools, context } = await setup(() => 1_000);
    const limit = tools.get('memory.write')!.definition.rateLimitPerMinute;
    for (let index = 0; index < limit; index += 1) {
      await tools.invoke('memory.write', { namespace: 'task', text: `note ${index}` }, context);
    }
    await expect(
      tools.invoke(
        'memory.write',
        { namespace: 'task', text: 'other project' },
        { ...context, projectId: 'project-2' },
      ),
    ).resolves.toBeTruthy();
  });
});
