# Memory and context

Memory namespaces are explicit and ACL-filtered. Durable progress is structured run state and checkpoints, not an unbounded prompt. A production context assembler should calculate token/latency budgets, retrieve fresh relevant items, rerank, compact old history, attach source citations, and require approval before durable writes. Delete/export operations must remove vectors, relational rows, and object references together.
