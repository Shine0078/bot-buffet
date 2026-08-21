# Memory and context

Memory namespaces are explicit and ACL-filtered. Durable progress is structured run state and checkpoints, not an unbounded prompt. `src/context.ts` calculates a token budget, orders fresh/relevant items, compacts overflow, redacts values, and carries source IDs as citations; the orchestrator uses it for every model request. A production retriever should add vector/rerank backends and require approval before durable writes. Delete/export operations must remove vectors, relational rows, and object references together.
