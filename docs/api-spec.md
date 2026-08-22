# API specification

The Node service exposes versioned JSON endpoints under `/api/v1`, `/healthz`, `/readyz`, and an SSE stream at `/events`. Every response carries `x-request-id`, `cache-control: no-store`, `x-content-type-options: nosniff`, and a structured `{ code, message }` error on request failure. Requests are capped at 2 MB and API callers are rate-limited per remote address.

Core resources include projects, providers, models, memory, plugins, MCP servers, files, sources, schedules, webhooks, evaluation datasets/cases, runs, approvals, audit, and observability. Projects can be archived or safely deleted after active runs are stopped; deletion revokes child credentials and preserves audit events. Run creation accepts an `Idempotency-Key`; the key is hashed and the 202 response is durably replayable for 24 hours. SSE requires a project scope in production, checks project authorization, caps subscribers, and emits heartbeats.

The project, task, run, and audit list endpoints preserve their historical array
response when no paging query is supplied. Supplying `limit` (1-100) or an
opaque `cursor` returns `{ items, total, limit, nextCursor? }`; cursors encode a
bounded offset over the already authorization-filtered result, so pagination
cannot widen tenant visibility. These lists also support bounded resource
filters (`workspaceId`/`archived`, `projectId`/`status`, and `projectId`/`action`
respectively). Malformed cursors, filters, and out-of-range limits are rejected
before the list is read.

SSE now requires a project scope in every mode and drops events that do not carry an authenticated project scope; an unscoped event is never treated as a wildcard broadcast.

`GET /api/v1/local-models/discover` probes only the configured loopback OpenAI-compatible runtimes and returns `{ providers, offlineOnly: true }`; each result includes provider kind, endpoint, reachability, and discovered model names. It is authenticated and never falls back to cloud discovery.

`GET/POST /api/v1/model-routes` lists or creates scoped routing policies. Creation validates strategy, project/agent parent scope, bounded primary/fallback model lists, offline-only mode, and optional non-negative cost ceilings; the router consumes project/agent routes before its default health/privacy ordering.

Each model request receives only enabled tools whose stable name or ID is present in the agent profile's `allowedToolIds`; the request carries the typed input schema and bounded description used by the provider adapter. The orchestrator repeats the allowlist check before execution, so provider-supplied or stale tool calls cannot widen authority.

`GET/POST /api/v1/environments`, `/api/v1/agents`, and `/api/v1/tasks` provide the authenticated project workbench lifecycle. Environment creation defaults to a blocked network; agent creation requires a project/environment pair and emits a bounded fail-safe profile; task creation validates environment, assignee, parent, and dependency project scope before persistence.

`PATCH /api/v1/agents/:id` updates an agent profile with the caller's current entity `version` and compare-and-swap persistence. Mutable instructions, model/tool/plugin/path allowlists, network mode, resource limits, output mode, escalation mode, and run mode are bounded before storage; approval, verification, and memory policy subdocuments remain unchanged by this general profile route. Stale versions are rejected and each accepted update increments both the entity and profile versions while retaining a bounded change log and an audit event containing only versions and changed field names.

`GET /api/v1/agents/:id/plugins` returns only enabled plugins activated for the agent's workspace, project, or agent assignment and permitted by the profile's `allowedPluginIds` list. `POST /api/v1/plugins/:id/assign` and `/unassign` require the current plugin version, administrator authorization on the target, and a matching workspace boundary; target types are `workspace`, `project`, and `agent`. Enable/disable also requires the current plugin version. Enabling a plugin with project/agent assignments preserves those narrower grants instead of silently widening it to the whole workspace.

`GET /api/v1/plugins/:id/dependencies`, `/permissions`, and `/auth` provide bounded dependency, declared-permission/network/retention, and credential-status review. `POST /api/v1/plugins/:id/auth` accepts a current plugin version plus an API key or custom secret, stores the secret only in the encrypted vault, records a fingerprint and declared scopes, and never returns the secret. `DELETE /api/v1/plugins/:id/auth` requires the current plugin version and revokes the vault record. Update/rollback and uninstall require an `expectedVersion`/`version` compare-and-swap token; updates force an integrity-pinned release. Plugin uninstall also revokes and deletes its credential record. The local host remains metadata-only: it does not execute arbitrary package code, and executable plugin hosting remains an isolated production owner gate.

`POST /api/v1/mcp-servers/:id/enable|disable` requires the current server `version`, uses compare-and-swap, and appends a high-risk audit event; stale toggles fail with `mcp_server_version_required` before changing the server.

`PATCH /api/v1/tasks/:id` requires the current task `version`, permits only the documented backlog/ready/running/blocked/done/cancelled transitions, and uses compare-and-swap persistence so stale clients receive a conflict instead of overwriting a newer state.

`PATCH /api/v1/projects/:id` requires the current project `version`, bounds the mutable name/archive fields, uses compare-and-swap persistence, and appends a scoped `project.updated` audit event. Stale updates fail with `project_version_required` before changing the project.

`POST /api/v1/runs/:id/pause|resume|cancel|stop|fork|rollback` controls durable execution. Pause, resume, cancel, stop, and rollback use compare-and-swap on the current run version; concurrent operators receive `concurrent_update` rather than silently overwriting a newer transition. Executor state commits use the same CAS boundary, and an accepted rollback aborts in-flight execution so a stale model/tool result cannot restore a rolled-back run. Each accepted command records the authenticated operator in the tamper-evident audit chain and emits a scoped SSE/webhook event (`run.paused`, `run.resumed`, `run.cancelled`, `run.forked`, or `run.rolled_back`; stop uses the cancelled event with a `run.stopped` audit action). Fork creates a new queued run and may copy only a checkpoint belonging to the parent run.

`POST /api/v1/projects/:id/duplicate` creates a same-workspace configuration copy
with remapped project, environment, agent, task, workflow, budget, and schedule
IDs. Active execution state, credentials, provider/model records, files, memory,
artifacts, webhooks, and audit history are intentionally excluded; copied agents
and tasks start idle/ready, and workflows, budgets, and schedules start disabled.
The optional `name` and `slug` are sanitized and sibling-slug collisions receive
an explicit numeric suffix; duplication claims a bounded workspace lock while
allocating the slug so concurrent copies cannot select the same name.

Filesystem tools expose the same conflict model: reads return a SHA-256 content
version and durable `versionLabel`; writes may supply `expectedSha256`, which is
checked against both the stored `ProjectFile` record and the current sandbox
bytes before mutation. Stale writes fail closed with
`filesystem_write_conflict`, and successful writes update the project file
record and audit metadata.

Model registration also rejects non-finite, negative, or unbounded cost, latency, and routing-weight metadata before it reaches the router.

`GET/POST /api/v1/budgets` lists or creates project and agent-scoped spend limits. Creation validates the period (`daily`, `monthly`, `lifetime`), a positive bounded `limitCents`, a `warnRatio` between 0 and 1, and that any `agentId` is readable by the caller and belongs to the same project. The list response attaches a computed status containing spend, projection, remaining cents, and `ok`/`warning`/`exceeded` state for the current window.

`POST /api/v1/budgets/estimate` returns the estimated cost of a model call before it runs, along with the budget decision, soft warnings, and any blocking budget. Token counts are bounded and non-negative, and an optional `agentId` is authorized and project-checked so callers cannot narrow the evaluated budget set to a scope they do not own.

`POST /api/v1/sources/:id/retrieve` requires the current source `version`, fetches over the pinned transport, stores a SHA-256 content hash and retrieval timestamp on success, and records `inaccessible` on failure through compare-and-swap persistence. `GET/POST /api/v1/citations` validates claim-to-source support; `verified` is set by the harness only when the source is available, retrieved, and hashed, and a caller-supplied `verified` flag is ignored. `GET /api/v1/projects/:id/research-brief` returns usable/pending/inaccessible source counts, unsupported claim ids, and detected contradictions.

`GET/POST /api/v1/artifacts` lists or registers project artifacts. Registration hashes content with SHA-256, records size and MIME type, validates that any `runId` belongs to the same project, and runs an export scan that blocks embedded API keys, private keys, null bytes, and payloads over 25 MB before persistence. `GET /api/v1/projects/:id/artifact-manifest` returns an order-independent checkpoint manifest whose `manifestSha256` changes if any recorded artifact hash is altered.

`GET/POST /api/v1/workflows` lists or creates project-scoped workflow graphs. Creation validates a bounded, acyclic, uniquely-identified DAG: unknown edge endpoints, self loops, duplicate node ids, unsupported node kinds, missing roots, cycles, and oversized graphs are rejected before persistence. Workflows are created disabled. `GET /api/v1/workflows/:id/plan` returns dependency-ordered execution levels plus the nodes ready to run, accepting optional `completed` and `failed` node id lists; unknown node ids are rejected, and descendants of a failed node are withheld rather than scheduled.

`GET /api/v1/usage` aggregates spend and token usage for the caller's visible projects. `groupBy` accepts `project`, `agent`, `model`, or `run`; `period` accepts `daily`, `monthly`, or `lifetime`; an optional `projectId` is authorized before use. Cost records are authoritative for money and usage records supply tokens and latency, so a run with a recorded cost is never double-counted. The response includes per-bucket cost, token, latency, and call totals plus a run-rate `forecastCents` for the window.

`GET /api/v1/alerts` lists authorization-filtered operator alerts. The orchestrator raises a `warning` alert when a budget crosses its warn ratio and a `critical` alert when a hard limit blocks a run; alert messages pass through secret redaction and are length-bounded.

`GET/POST /api/v1/incidents` lists or records durable, scoped incident records.
API-created incidents are explicitly labeled `operator`; trusted `system` and
`security` provenance is reserved for harness-generated records. Creation
requires project or workspace write authorization, bounds and redacts
title/summary/evidence fields, and optionally verifies a referenced run belongs
to the selected project. `PATCH /api/v1/incidents/:id` requires approval
authorization and the current entity version; lifecycle transitions are
`open` → `acknowledged` → `resolved` (with a required bounded resolution), and
each create/transition is audit-recorded. Incident reads support project,
status, severity, and the common cursor pagination contract.

The orchestrator performs the same evaluation before every model call. Estimated cost is charged against applicable budgets; exceeding a hard limit durably blocks the run with `budget_exceeded`, emits a `budget.exceeded` event, and writes a `budget.blocked` audit record. Soft warnings emit `budget.warning` without blocking. Each completed model call writes durable usage and cost records scoped to the project, agent, and run, so budgets reflect real spend across restarts.

Routing only accepts model IDs readable by the actor and within the selected project/agent scope. Automatic routing also filters its inventory to the run's project/workspace scopes before selecting a provider.

`POST /api/v1/local-models/register` registers a discovered loopback model and its local provider in one idempotent operation. Only the six supported local provider kinds and loopback-safe endpoints are accepted; the response is explicitly `offlineOnly: true` and contains no credential material.

`POST /api/v1/local-models/import/plan` is a dry run that answers, before any transfer begins, what an import would do: declared size, free and total space on the model volume, space remaining afterwards, measured host CPU/memory/disk, and an advisory fit verdict. It writes nothing and reuses the same decision function as the enforcing route, so the preview cannot drift from what the import will allow. GPU and VRAM are reported as an explicit undetected state rather than fabricated, because a wrong figure would green-light a model the machine cannot load.

`POST /api/v1/local-models/import` registers a verified weight artifact against a local model. It requires write authorization on the model, because importing weights changes what that model executes. Verification is performed by the harness against the bytes on disk: the SHA-256 is recomputed by streaming the file and compared in constant time, and the record is written only when it matches. An artifact with no digest is refused outright rather than imported with a warning; the digest must be 64 hex characters; the size must be a positive integer and is checked against free space plus headroom before any transfer starts; only `https:` and `file:` sources are accepted; and the file name must be a plain name confined beneath the model store root. The model record is updated by compare-and-swap on the observed version. Every outcome is audited: refusals at medium risk with their refusal list, and a digest mismatch at high risk with the expected and actual digests, because a substituted weight file is an integrity event rather than a validation error.

Schedules are created disabled and bind a bounded five-field cron expression plus a validated IANA timezone to a task in the same project. The local dispatcher polls every 15 seconds, claims a matching UTC minute with compare-and-swap, requires the task's assigned agent and matching project/environment, creates exactly one durable run, and audits either `schedule.triggered` or a bounded `schedule.error`; the claim and last run/error survive restart. Webhooks are created disabled, require an HTTPS URL and a 32-byte secret, and persist only a fingerprint in the entity while encrypting the secret in the credential vault. `GET /api/v1/webhooks/events` returns the allowlisted event catalog; registration rejects unknown events; `POST /api/v1/webhooks/:id/test` sends a redacted, timestamped `v1` HMAC-signed test payload and records only delivery outcome. Enabled subscriptions receive matching redacted orchestrator events over the DNS-pinned transport with `x-bot-buffet-event` and `x-bot-buffet-signature` headers, bounded exponential retries, and outcome-only audit records. Enable/disable and test operations require project admin authorization. A dedicated production queue/worker and live external endpoint, replay/forgery, and multi-instance delivery evidence remain deployment owner gates.

Production requires a verified OIDC bearer JWT. Configure the issuer, audience, and HTTPS JWKS URI through `BOT_BUFFET_OIDC_ISSUER`, `BOT_BUFFET_OIDC_AUDIENCE`, and `BOT_BUFFET_OIDC_JWKS_URI`; the service validates the signature and time/audience/issuer claims and maps `sub` to the scoped actor. The development `x-bot-buffet-user` header is ignored in production. `bootstrap` mode is loopback-only and uses `BOT_BUFFET_BOOTSTRAP_TOKEN` solely for migration. Provider creation accepts either an encrypted API-key token or an `authType: "env"` plus environment-variable reference; environment secrets are resolved only when an adapter is used. Providers with OAuth metadata expose `POST /api/v1/providers/:id/oauth/start`, which creates an actor-bound one-time S256 PKCE session and returns an `authorizeUrl`; the callback exchanges the code server-side and stores only credential metadata plus an encrypted vault reference. Providers with `deviceAuthorizationEndpoint` additionally expose `POST /api/v1/providers/:id/device/start` and `POST /api/v1/providers/:id/device/poll`; device codes never appear in API responses, poll sessions are actor/provider-bound and rate-limited, and successful exchanges store only encrypted credential material and redacted metadata.

Provider health tests and administrative deletes require the current provider `version` and use compare-and-swap persistence. Successful health tests emit `provider.tested`; deletes disable the provider and credential, revoke the vault secret, and emit a critical `provider.disabled` audit event. OAuth PKCE and device-token exchanges create a fresh credential row and attach it with provider CAS; a lost race restores the prior vault value and removes the new row. Stale requests fail with `provider_version_required` before the provider or vault changes.

Evaluation case creation requires an existing authorized dataset and appends the case ID with a dataset-version compare-and-swap. If the dataset CAS loses a race, the newly inserted case is removed rather than left orphaned; missing datasets fail with `dataset_required`.

Mutating routes enforce resource kind, owner/workspace membership, role action, parent scope, version/CAS where transitions race, approval pending/expiry, and project/environment consistency. Memory writes begin unapproved and `POST /api/v1/memory/:id/approval` requires the current version for an auditable CAS transition. `POST /api/v1/memory/prune-expired` deletes only explicitly expired records the actor can write, supports an optional namespace/namespace-id filter, caps a run at 1,000 records, and audits the bounded deletion count; it never infers deletion from an agent's policy retention window. Provider endpoints require TLS and public DNS resolution unless the provider is explicitly local. See `docs/authentication.md`, `docs/tool-contracts.md`, and `docs/owner-gates.md` for deployment obligations.

Responses and event payloads pass through recursive secret redaction. Credential-shaped keys and provider token values are replaced with `[REDACTED]`; operational token budgets, limits, and usage counters remain visible for UI and observability.
