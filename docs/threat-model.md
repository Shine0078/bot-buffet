# Threat model

Assets include credentials, private prompts/files/memory, project code, provider quotas, approvals, and audit evidence. Trust boundaries are the browser/API, orchestrator, model providers, tools/sandbox, plugins, and storage.

Controls: scope-aware API filtering and parent authorization; RS256 OIDC bearer validation with issuer/audience/time/nonce checks; pinned provider sockets after DNS preflight; redaction at adapter, tool, API, and UI boundaries; offline/private routing with agent model/tool allowlists; lexical plus realpath confinement; protected files; read-only command allowlist and code-flag rejection; time/output/body/rate/SSE caps; a sandbox runtime that fails closed in production and uses Docker with a read-only workspace, blocked network, dropped capabilities, `no-new-privileges`, resource limits, and a non-root user; mandatory high/critical approval with expiry and compare-and-swap; serialized append-only hash-chain audit; no credentials in model context; and enforced untrusted-content labeling on every tool result, which fences external data with a standing data-not-commands instruction, neutralizes fence-escape attempts, sanitizes the origin label, detects six instruction-shaped payload classes, and records a `tool.untrusted_content` audit event that requires approval for high-severity signals. Policy risk matching is threshold-based, so a rule declared for high risk no longer fires on safe actions. Residual risk: the development/local fallback is not a kernel sandbox, Docker/microVM deployment still needs staging escape evidence, and injection detection is pattern-based, so it reduces rather than eliminates the chance that a novel payload reaches a model as labeled data.

Locally exercised and covered by regression tests: path traversal (lexical, encoded, nested, absolute, null-byte, and symlink escape), command injection across five metacharacter classes, SSRF through provider, source, and webhook endpoints, prompt injection through tool output, cross-tenant reads, credential leakage in responses and traces, signed webhook tampering/replay checks, audit-chain tampering, and restore integrity. Still required before production and owned externally: webhook forgery/replay and retry behavior against a live receiving worker, rate-limit exhaustion under load, and kernel sandbox escape in a container or microVM. Record findings and remediation in the incident log.

## Findings closed on 2026-08-22

Recorded because each was a real gap rather than a hypothetical, and because
the pattern behind several of them is worth remembering.

### Ambient environment reaching sandboxed commands

The local sandbox runtime called `execFile` with no `env`, so every sandboxed
command inherited the whole parent environment — `BOT_BUFFET_MASTER_KEY`, the
OIDC configuration, and any provider credentials exported into the operator's
shell. `environmentKeys` on the agent profile exists to control exactly this and
was read by nothing.

Both runtimes now construct the environment explicitly: the few variables a
process needs to execute, plus whatever the profile names. For the container,
allowed variables are forwarded as `--env NAME` with values supplied through the
docker CLI's own environment, because `--env NAME=value` would place the secret
in the process argument list where any other process on the host can read it.

Exposure was limited by the shell tool permitting only `--version` and `--help`
on node, npm, and pnpm — but inherit-everything is the wrong default for the
boundary that contains agent-generated code.

### "Local" endpoints that were not local

`assertSafeEndpoint(endpoint, allowLocal = true)` rejected only _private_
hostnames, so a public host passed every check: not metadata, not private, and
the TLS requirement is skipped for local endpoints. A model registered through
the offline-only local path could therefore point at an arbitrary remote server
over plaintext while the API still reported `offlineOnly: true` — prompts
leaving the host under a label that said they could not.

The flag now means what it says: the host must be loopback, which is also what
local discovery probes. Fixing it surfaced a second defect in the first attempt,
where `URL.hostname` keeps the brackets on an IPv6 literal, so `[::1]` matched
no bare loopback form; host normalisation is now a single shared helper, so an
address cannot be classified one way by one check and another way by another.

### Network policies that only relaxed

`allowlist` and `open` had no host enforcement anywhere, because there is no
egress proxy to enforce an allowlist against. The container runtime refused
them; the local runtime ignored the policy entirely, so setting `allowlist` on a
profile relaxed the shell tool's network-shaped command check while introducing
no host restriction to replace it. A non-blocked policy was strictly weaker than
`blocked` with nothing compensating. Both runtimes now refuse identically.

### Controls that were declared but never enforced

Six agent-profile fields were declared, validated on write, stored on every
record, and read by nothing at runtime: `mode`, `verificationPolicy`,
`memoryPolicy`, `escalationPolicy`, `environmentKeys`, and `skills`. One
approval-policy field, `autoApproveReversible`, and one tool-definition field,
`rateLimitPerMinute`, were in the same state.

Each is a safety property the interface promises and the runtime does not
provide, which is worse than not offering it: an operator who sets `plan` mode
or a memory scope reasonably believes something is enforcing it. All are now
enforced, each with unit coverage for the decision and orchestrator-level
coverage for the wiring — a pure function passing its tests proves nothing about
whether the loop consults it, which is precisely how these survived.

The audit that finds this class of defect is mechanical: for each field on a
policy or contract type, grep for a runtime read outside the type definition and
the API validator. It is worth repeating whenever a policy type gains a field.
