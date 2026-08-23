# Tool contract guide

Every tool has a stable name, JSON input/output schema, scope, risk, reversibility, auth requirement, timeout, rate/output limits, version, owner, and audit behavior. The registry validates both input and redacted output before returning. Tools should return structured evidence and safe error codes; never return raw provider errors or credentials.

## Enforcement order

`ToolRegistry.invoke` applies the contract in a fixed order, and the order is
part of the contract:

1. **Tool exists and is enabled.**
2. **Input schema validation.** A malformed call is reported as malformed.
3. **Rate limit.** Checked after validation, deliberately: a malformed call
   should not consume budget and come back reported as throttled. The window is
   per tool and per project, so one project cannot starve another. A refused
   call does not enter the window either, or a client retrying during a block
   would never escape it. A non-positive `rateLimitPerMinute` means unlimited
   rather than forbidden.
4. **Timeout.** `timeoutMs` races the execution.
5. **Output redaction**, then output schema validation, then `outputLimitBytes`.

Approval, run-mode constraints, and the agent's tool allowlist are enforced by
the orchestrator _before_ it reaches this point — the registry's job is the
contract, not the authority.

## Built-in tools

| Tool               | Risk   | Reversible | Notes                                               |
| ------------------ | ------ | ---------- | --------------------------------------------------- |
| `filesystem.read`  | safe   | yes        | Workspace-confined, protected paths refused         |
| `filesystem.write` | medium | no         | Locked per file, size-capped, audited               |
| `shell.run`        | medium | no         | Read-only probes only; explicit sandbox environment |
| `memory.write`     | low    | yes        | Bounded by `writableScopes`; identity from the run  |

`memory.write` takes its namespace identity from the run rather than the
caller — the schema does not accept a `namespaceId` — so an agent cannot record
a note against another project, agent, or run. Where the memory policy requires
approval the note is stored unapproved, which keeps it out of agent context
until a human accepts it while still recording it.

`shell.run` receives an explicitly constructed environment: the few variables a
process needs to execute, plus whatever the agent profile's `environmentKeys`
names, and nothing else. It is never the ambient environment.

## Concurrent-edit conflict detection

`filesystem.write` takes a lock, but a lock is not conflict detection. It
prevents two writes at the same instant; it does not prevent the failure that
actually loses work when several agents share a project:

1. Agent A reads `notes.md`.
2. Agent B takes the lock, writes `notes.md`, releases it.
3. Agent A takes the lock and writes content derived from its now-stale read.

Every step holds the lock correctly and B's work is gone. The lock is released
between A's read and A's write, which is where the conflict lives.

The write tool therefore accepts two optional claims:

| Field        | Meaning                               | Refused when                                                    |
| ------------ | ------------------------------------- | --------------------------------------------------------------- |
| `baseSha256` | "I am replacing exactly this content" | The current content differs (`stale_base`), or the file is gone |
| `expectNew`  | "I am creating this file"             | Something is already there (`unexpected_existing`)              |

A third conflict needs no claim: if the file registry's recorded hash and the
bytes on disk disagree, the file was changed outside the harness
(`out_of_band`). That is checked first, because a writer's claim about the base
cannot be evaluated meaningfully against a file the registry no longer knows.

Checks run **inside the lock**, so a stale base is caught between another
writer's commit and this one's. Refusals are audited as
`filesystem.write_conflict` at medium risk, so a conflict is visible afterwards
rather than only surfacing as a failed tool call.

A writer that makes no claim is allowed through. Not every write is
read-modify-write, and requiring a claim would make simple creation awkward —
so the guard is opt-in, and an agent that cares about losing a concurrent edit
must supply `baseSha256`. That trade-off is deliberate and is recorded in
`src/conflicts.ts` rather than left implicit.
