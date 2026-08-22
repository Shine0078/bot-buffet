# Memory and context

Memory namespaces are explicit and ACL-filtered. Durable progress is structured run state and checkpoints, not an unbounded prompt. `src/context.ts` calculates a token budget, orders fresh/relevant items, compacts overflow, redacts values, and carries source IDs as citations; the orchestrator uses it for every model request. New memory records start with `approved: false`; `POST /api/v1/memory/:id/approval` requires the current entity version and uses compare-and-swap before recording an approval/rejection audit event. A production retriever should add vector/rerank backends and require approval before durable writes. Delete/export operations must remove vectors, relational rows, and object references together.

## Agent-facing memory

Memory reaches an agent through the run loop, filtered by the agent profile's
`memoryPolicy`. Two rules decide what it sees.

**Namespace, then identity.** A readable namespace is not enough — the item's
`namespaceId` must match _this run's_ instance of that namespace. Permission to
read `project` memory means this project's, not every project's. Without that
pairing a readable scope would be a cross-tenant read, which is the failure the
whole namespace design exists to prevent. Session memory is bound to the run
that produced it, and `organization` and `artifact` are never matched from a run
context because a run cannot identify them.

**Then approval, expiry, and retention.** Unapproved items are withheld when the
policy requires approval, expired items are dropped, and items older than
`retentionDays` are excluded (`0` means no limit, not "nothing readable").

Every exclusion is returned with its reason rather than silently dropped, so a
run that behaved as though it had forgotten something can be explained from its
own record.

Selected memory is ranked below the task and the current run state and competes
for the same token budget, so a large memory store compacts rather than crowding
out the work in hand.

## Writing memory

Agents record notes with the `memory.write` tool, bounded by `writableScopes`.
Write scope is separate from read scope on purpose: an agent that may read
project memory is not thereby entitled to change it, and the usual configuration
is a broad read scope with a narrow write scope.

- **No policy means no authority.** An agent invoked without a memory policy
  cannot write, rather than defaulting to permitted.
- **The namespace identity comes from the run, never the caller.** The tool
  schema does not accept a `namespaceId`, so an agent cannot record a note
  against another project, agent, or run.
- **Approval before persistence.** Where the policy requires it the note is
  stored unapproved, which keeps it out of agent context until a human accepts
  it — recorded either way, so nothing is lost while it waits.
- Text is bounded, empty writes are refused, and every write is audited with its
  namespace, approval state, and originating run.
