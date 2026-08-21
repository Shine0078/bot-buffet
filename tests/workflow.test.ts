import { describe, expect, it } from 'vitest';
import {
  MAX_WORKFLOW_NODES,
  readyNodes,
  validateWorkflow,
  workflowLevels,
} from '../src/workflow.js';
import { WorkflowEdge, WorkflowNode } from '../src/types.js';

const node = (id: string, kind: WorkflowNode['kind'] = 'task'): WorkflowNode => ({
  id,
  kind,
  config: {},
});
const edge = (from: string, to: string): WorkflowEdge => ({ from, to });

describe('workflow graphs', () => {
  const nodes = [node('plan'), node('build'), node('test'), node('review', 'approval')];
  const edges = [edge('plan', 'build'), edge('plan', 'test'), edge('build', 'review')];

  it('validates a well-formed DAG and reports roots and leaves', () => {
    const result = validateWorkflow(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.roots).toEqual(['plan']);
    expect(result.leaves.sort()).toEqual(['review', 'test']);
  });

  it('rejects cycles, self loops, duplicates, unknown edges, and bad kinds', () => {
    const cyclic = validateWorkflow([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]);
    expect(cyclic.valid).toBe(false);
    expect(cyclic.errors).toContain('workflow_no_root');
    expect(cyclic.errors).toContain('workflow_cycle_detected');

    expect(validateWorkflow([node('a')], [edge('a', 'a')]).errors).toContain(
      'workflow_edge_self_loop:a',
    );
    expect(validateWorkflow([node('a'), node('a')], []).errors).toContain(
      'workflow_node_duplicate:a',
    );
    expect(validateWorkflow([node('a')], [edge('a', 'ghost')]).errors).toContain(
      'workflow_edge_unknown_node',
    );
    expect(
      validateWorkflow([{ id: 'a', kind: 'teleport' as WorkflowNode['kind'], config: {} }], [])
        .errors,
    ).toContain('workflow_node_kind_invalid:a');
    expect(validateWorkflow([], []).errors).toContain('workflow_nodes_required');
  });

  it('bounds graph size', () => {
    const many = Array.from({ length: MAX_WORKFLOW_NODES + 1 }, (_, index) => node(`n${index}`));
    expect(validateWorkflow(many, []).errors).toContain('workflow_nodes_too_many');
  });

  it('orders nodes into concurrent dependency levels', () => {
    const levels = workflowLevels(nodes, edges);
    expect(levels[0]).toEqual(['plan']);
    expect(levels[1]?.sort()).toEqual(['build', 'test']);
    expect(levels[2]).toEqual(['review']);
    expect(() =>
      workflowLevels([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]),
    ).toThrow();
  });

  it('returns only nodes whose dependencies completed', () => {
    const workflow = { nodes, edges };
    expect(readyNodes(workflow, new Set())).toEqual(['plan']);
    expect(readyNodes(workflow, new Set(['plan'])).sort()).toEqual(['build', 'test']);
    expect(readyNodes(workflow, new Set(['plan', 'build', 'test']))).toEqual(['review']);
    expect(readyNodes(workflow, new Set(['plan', 'build', 'test', 'review']))).toEqual([]);
  });

  it('skips descendants of a failed node instead of starting them', () => {
    const workflow = { nodes, edges };
    const ready = readyNodes(workflow, new Set(['plan']), new Set(['build']));
    expect(ready).toEqual(['test']);
    expect(ready).not.toContain('review');
  });
});
