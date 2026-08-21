import { Workflow, WorkflowEdge, WorkflowNode } from './types.js';

export const MAX_WORKFLOW_NODES = 200;
export const MAX_WORKFLOW_EDGES = 400;
const NODE_KINDS: WorkflowNode['kind'][] = ['task', 'agent', 'approval', 'condition', 'parallel'];

export interface WorkflowValidation {
  valid: boolean;
  errors: string[];
  /** Nodes with no inbound edges; these start the graph. */
  roots: string[];
  /** Nodes with no outbound edges; the graph is finished when these complete. */
  leaves: string[];
}

/**
 * Validate a workflow graph before it is persisted or executed. The graph must be a bounded,
 * acyclic, fully-connected DAG with unique node ids and edges that reference real nodes.
 */
export function validateWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowValidation {
  const errors: string[] = [];
  if (!Array.isArray(nodes) || nodes.length === 0) errors.push('workflow_nodes_required');
  if (nodes.length > MAX_WORKFLOW_NODES) errors.push('workflow_nodes_too_many');
  if (edges.length > MAX_WORKFLOW_EDGES) errors.push('workflow_edges_too_many');
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !node.id) {
      errors.push('workflow_node_id_invalid');
      continue;
    }
    if (ids.has(node.id)) errors.push(`workflow_node_duplicate:${node.id}`);
    ids.add(node.id);
    if (!NODE_KINDS.includes(node.kind)) errors.push(`workflow_node_kind_invalid:${node.id}`);
  }
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to)) {
      errors.push('workflow_edge_unknown_node');
      continue;
    }
    if (edge.from === edge.to) errors.push(`workflow_edge_self_loop:${edge.from}`);
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + 1);
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  const roots = [...ids].filter((id) => !inbound.get(id));
  const leaves = [...ids].filter((id) => !outbound.get(id));
  if (ids.size > 0 && roots.length === 0) errors.push('workflow_no_root');

  // Kahn's algorithm: any node left with a remaining in-degree sits on a cycle.
  const remaining = new Map<string, number>([...ids].map((id) => [id, inbound.get(id) ?? 0]));
  const queue = roots.slice();
  let visited = 0;
  while (queue.length) {
    const current = queue.shift()!;
    visited += 1;
    for (const next of adjacency.get(current) ?? []) {
      const degree = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  if (ids.size > 0 && visited !== ids.size) errors.push('workflow_cycle_detected');
  return { valid: errors.length === 0, errors, roots, leaves };
}

/**
 * Order nodes into dependency levels. Every node in a level may run concurrently because it
 * depends only on nodes in earlier levels.
 */
export function workflowLevels(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[][] {
  const validation = validateWorkflow(nodes, edges);
  if (!validation.valid) throw new Error(validation.errors[0] ?? 'workflow_invalid');
  const dependencies = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set()]));
  for (const edge of edges) dependencies.get(edge.to)?.add(edge.from);
  const levels: string[][] = [];
  const done = new Set<string>();
  while (done.size < nodes.length) {
    const level = nodes
      .map((node) => node.id)
      .filter((id) => !done.has(id) && [...(dependencies.get(id) ?? [])].every((d) => done.has(d)));
    if (!level.length) throw new Error('workflow_cycle_detected');
    for (const id of level) done.add(id);
    levels.push(level);
  }
  return levels;
}

export interface WorkflowNodeState {
  nodeId: string;
  status: 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'skipped';
}

/**
 * Given completed and failed nodes, return the nodes that may start now. A node is only ready
 * when every upstream node completed; downstream nodes of a failure are skipped, not started.
 */
export function readyNodes(
  workflow: Pick<Workflow, 'nodes' | 'edges'>,
  completed: Set<string>,
  failed: Set<string> = new Set(),
): string[] {
  const dependencies = new Map<string, string[]>(workflow.nodes.map((node) => [node.id, []]));
  for (const edge of workflow.edges)
    dependencies.set(edge.to, [...(dependencies.get(edge.to) ?? []), edge.from]);
  const blocked = new Set<string>();
  const propagate = (nodeId: string): void => {
    for (const edge of workflow.edges) {
      if (edge.from !== nodeId || blocked.has(edge.to)) continue;
      blocked.add(edge.to);
      propagate(edge.to);
    }
  };
  for (const node of failed) propagate(node);
  return workflow.nodes
    .map((node) => node.id)
    .filter(
      (id) =>
        !completed.has(id) &&
        !failed.has(id) &&
        !blocked.has(id) &&
        (dependencies.get(id) ?? []).every((dependency) => completed.has(dependency)),
    );
}
