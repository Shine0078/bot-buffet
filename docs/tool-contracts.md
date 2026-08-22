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

| Tool               | Risk   | Reversible | Notes                                                                            |
| ------------------ | ------ | ---------- | -------------------------------------------------------------------------------- |
| `filesystem.read`  | safe   | yes        | Workspace-confined, protected paths refused; returns SHA-256/version             |
| `filesystem.write` | medium | no         | Locked, size-capped, audited; optional SHA-256 precondition rejects stale writes |
| `shell.run`        | medium | no         | Read-only probes only; explicit sandbox environment                              |
| `memory.write`     | low    | yes        | Bounded by `writableScopes`; identity from the run                               |

`memory.write` takes its namespace identity from the run rather than the
caller — the schema does not accept a `namespaceId` — so an agent cannot record
a note against another project, agent, or run. Where the memory policy requires
approval the note is stored unapproved, which keeps it out of agent context
until a human accepts it while still recording it.

`filesystem.read` returns `sha256` and a durable `versionLabel` for the
project-relative file. `filesystem.write` accepts an optional `expectedSha256`;
when supplied, the harness checks both the durable file record and the current
workspace bytes before writing. A mismatch fails with
`filesystem_write_conflict` and leaves the existing bytes untouched. Successful
writes update the durable `ProjectFile` record and increment its version label,
so concurrent agents can compare-and-swap their edits instead of silently
overwriting one another.

`shell.run` receives an explicitly constructed environment: the few variables a
process needs to execute, plus whatever the agent profile's `environmentKeys`
names, and nothing else. It is never the ambient environment.
