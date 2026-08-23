# Changelog

## Unreleased

- `outputFormat: markdown` is now a real runtime format: the system prompt instructs Markdown, providers still receive `text` unless JSON is requested, and verification fails unstructured Markdown.
- Opening the Office UI as `file://` now shows a blocking banner and disables buttons instead of looking like a live, unresponsive office.
- `allowedPluginIds` is enforced on `plugin.invoke`. Installed connectors still fail closed without a live credential.
- Plugin `projectIds` now deny cross-project invocation, and registered MCP servers can be invoked through `mcp.invoke` only after enablement, export, and integrity checks. Live MCP execution remains unavailable without a verified runtime.
- Plugin `network: open` is refused at invocation, and `allowlist` requires connector hosts. Blocked plugins still cannot pretend they have live network access.
- Enabled schedules now fire through a bounded five-field cron matcher and `tickSchedules`. A due assigned task starts a run; the same UTC minute will not start a second one. Stored IANA timezones are honoured, and unknown zones fail closed.

## 0.2.0 — 2026-08-22

### Gates that were not gating

- Brand scan passed its two-term alternation to `git grep` without `-E`, so the pipe was literal and neither term was ever searched for; it also matched its own source and was permanently red. Fixed with `-E`, path-based self-exclusion, and a self-test that throws if the pattern stops matching the brand.
- `npm run format:check` could not pass on Windows: Git for Windows sets `core.autocrlf=true` system-wide, so the tree checked out CRLF against LF blobs and Prettier flagged all 111 files locally while Linux CI stayed green. A `.gitattributes` pins the working tree to LF everywhere, and local `verify` now runs format and lint as CI does.
- The CI container job declares `needs: verify`, so while verify was red it never ran — hiding a Dockerfile that omitted `tsconfig.build.json` and a server that bound `127.0.0.1` inside the container, making its published port unreachable.
- `npm run smoke` printed "passed" and exited 127: it raced `child.kill()` against `process.exit()`, tripping a libuv assertion on Windows after every check had passed. Server shutdown now waits for the child, and scripts set `process.exitCode`.

### Controls that were declared but never enforced

An audit of every field on the agent profile, approval policy, and tool definition for an actual runtime read found eight, each now enforced with unit coverage for the decision and orchestrator-level coverage for the wiring:

- `mode` — run modes had no semantics; `plan` could mutate files and `emergency-stop` stopped nothing.
- `verificationPolicy` — one hardcoded check ran regardless of what a profile declared.
- `memoryPolicy` — and the orchestrator never loaded memory into agent context at all, so the policy governed a path that did not exist.
- `escalationPolicy` — every failure ended the run as `failed`.
- `environmentKeys` — the local sandbox inherited the entire parent environment, including the master key and OIDC configuration.
- `skills` — agents were never told their own skills existed.
- `autoApproveReversible` — approval sources are now combined in one ranked decision.
- `rateLimitPerMinute` — a looping agent could call a tool without limit.

### Security

- `assertSafeEndpoint(…, allowLocal)` rejected only _private_ hostnames, so a public host passed every check and a model registered through the offline-only local path could reach an arbitrary remote server over plaintext while the API reported `offlineOnly: true`. Local now means loopback, with host normalisation shared so an IPv6 literal cannot be classified two ways.
- `allowlist` and `open` network policies had no host enforcement anywhere; the local runtime ignored the policy entirely, making a non-blocked policy strictly weaker than `blocked`. Both runtimes now refuse identically.
- The container sandbox never passed `--interactive`, so every sandboxed file write saw EOF on stdin, wrote an empty file, and exited 0. Found by running the sandbox against a live Docker daemon for the first time.
- Sandbox image and container base images are pinned by digest, with production failing closed on an unpinned image.

### Added

- Installation preflight (`npm run preflight`) enforcing the Node floor from `package.json`, separating blockers from warnings, with per-platform remediation.
- Checksum-verified model artifact import, fail-closed at every step, with a dry-run planning endpoint that reports size, free space, and host resources before any transfer.
- Host resource detection that reports GPU and VRAM as explicitly undetected rather than guessed.
- Portable local model configuration export/import carrying no credential material.
- A permission-scoped connector catalog for the eight named integrations; installing one produces a disabled, host-allowlisted plugin that grants no authority.
- `memory.write` for agents, bounded by write scope, with approval before persistence.

### Verified

- Container sandbox against a live Docker daemon: non-root execution, no network, read-only root filesystem, workspace-confined reads and writes, with `BOT_BUFFET_REQUIRE_DOCKER_TESTS=1` in CI so the coverage cannot skip silently.
- Container image serves health, readiness, UI, and API through its published port as a non-root user, with Docker's own healthcheck reporting healthy.
- 519 tests across 57 files; coverage ratcheted to the measured figures so a regression fails the build.

## 0.1.0 — 2026-08-21

- Initial Bot Buffet control-plane baseline with durable local state, orchestrator, policy/sandbox controls, model routing, Office UI, tests, CI, container, SBOM, and operational docs.
- Security hardening pass: scope-aware authorization and parent checks, production principal isolation, private/offline model enforcement, mandatory high-risk approvals with CAS transitions, realpath/protected-path sandboxing, read-only shell policy, TLS/private endpoint checks, bounded API/SSE resources, and serialized audit mutations.
- Follow-up control-plane pass: durable run idempotency replay, model retry/backoff and time/token/cost limits, MCP server registry, disabled integrity-pinned plugin update/rollback/delete, security headers, typed Role/MCPServer entities, and product/API/plugin/incident/CI documentation.
- Control-plane lifecycle pass: serialized entity mutations, tool timeout enforcement, checkpoint-state fork/rollback, safe project deletion with credential revocation, and disabled schedule/webhook registries.
- Budget enforcement pass: typed `Budget` entity, daily/monthly/lifetime spend windows, scoped budget CRUD and pre-execution cost estimation APIs, durable per-call usage/cost records, and orchestrator admission control that blocks runs on hard limits and emits soft budget warnings.
- Cost observability pass: project/agent/model/run cost aggregation with window filtering and run-rate forecasting, authenticated `GET /api/v1/usage` and `GET /api/v1/alerts` endpoints, and durable redacted budget alerts raised from the orchestrator.
- Workflow graph pass: DAG validation with cycle/self-loop/duplicate/unknown-edge rejection and size bounds, dependency-level scheduling, failure-aware ready-node computation, and scoped workflow create/list/plan APIs.
- Office UI pass: budget, usage, workflow, and alert table views with bootstrap and live usage data.
- Runtime smoke suite executed against the built server in CI, plus a redaction fix for aggregate usage counters.
- Artifact registry pass: content hashing, credential/size export scanning, scoped artifact APIs, and tamper-evident checkpoint manifests.
- Evaluation pass: regex/numeric/schema/normalized graders, separated LLM-as-judge support with fail-closed verdicts, golden-baseline regression comparison, and an audited release gate.
- Observability pass: OTLP/JSON run traces derived from durable steps and a Prometheus-style `/metrics` endpoint.
- Browser/accessibility pass: Playwright + axe-core suite over the served UI, CI Chromium install, and WCAG contrast fixes to the design tokens.
- Recovery pass: end-to-end destroy-and-restore drill wired into CI, proving state and audit-chain survival.
- Isolation pass: explicit cross-tenant, membership, and role-action authorization tests.
- Research pass: pinned source retrieval with content hashing, harness-decided citation verification, contradiction detection, and research briefs.
- Durability pass: restart/compaction/failure recovery evidence and adversarial sandbox boundary tests.
- Prompt-injection pass: untrusted-content fencing and labeling, six injection detectors, audited orchestrator enforcement, and a policy risk-threshold fix.
- Webhook delivery pass: published event catalog and registration validation, versioned timestamped HMAC signatures, signed test deliveries, redacted orchestrator-event dispatch over pinned HTTPS, bounded retries, and outcome-only auditing.
- Provider compatibility pass: native Anthropic Messages and Gemini generateContent adapters with normalized usage/tool-call responses and regression coverage.
- Runtime wiring pass: the service entrypoint now honors the provider adapter factory for online models.
- Credential hardening pass: development vaults now use random per-file keys, keep them out of backups, and verify reload behavior; the current security scan records only the remaining external sandbox gate.
- Identity hardening pass: production now validates RS256 OIDC bearer JWTs with JWKS rotation/cache, issuer/audience/time/nonce checks, and verified-subject actor mapping; the current security scan records only the remaining external sandbox gate.
- Egress hardening pass: provider adapters now connect to the address selected by DNS preflight through a pinned socket transport, eliminating the prior post-validation DNS rebinding finding and adding local transport tests.
- Sandbox hardening pass: built-in filesystem and shell tools now use a runtime abstraction; production refuses the host-process fallback and Docker mode applies a read-only workspace, blocked network, dropped capabilities, `no-new-privileges`, resource limits, and a non-root user. Docker/microVM staging and escape evidence remain release-owner gates.
- Local model discovery pass: loopback probes now cover all supported local OpenAI-compatible runtimes (Ollama, LM Studio, llama.cpp, LocalAI, vLLM, and Jan) with regression coverage.
- Local discovery API pass: added the authenticated `GET /api/v1/local-models/discover` endpoint with an explicit offline-only response contract and regression coverage.
- Routing policy API pass: added validated scoped model-route creation/listing for project/agent primary and fallback chains, strategy selection, offline-only routing, and cost ceilings.
- Routing enforcement pass: model metadata now carries optional latency/weight signals, route ceilings filter estimated token cost before selection, weighted/lowest-latency strategies are enforced, and orchestrator routing supplies bounded output estimates.
- Workbench lifecycle pass: added authenticated environment, agent, and task creation/listing APIs with blocked-network agent defaults, bounded profiles, and project-scope validation for assignees, parents, and dependencies.
- Task state safety pass: added versioned task PATCH transitions with an allowlisted state machine, bounded mutable fields, and stale-write rejection.
- Model metadata safety pass: model registration now rejects non-finite, negative, or unbounded cost, latency, and routing-weight values.
- Routing isolation pass: route references are authorization-checked and scope-checked, while automatic selection is constrained to the active project/workspace inventory.
- Agent profile management pass: added an authenticated, bounded `PATCH /api/v1/agents/:id` profile update with entity/profile versioning, compare-and-swap stale-write rejection, bounded change history, and tamper-evident audit events; shared redaction now distinguishes operational token metadata from credentials.
- Local registration pass: added an authenticated idempotent loopback provider/model registration endpoint with provider-kind allowlisting and an explicit offline-only response.
- CI reliability pass: declared the Vitest V8 coverage provider and added non-interactive minimum coverage thresholds so the checked-in coverage job no longer pauses for a missing dependency.
- Tooling hygiene pass: ignored generated coverage reports in ESLint so CI lint output stays limited to repository source and tests.
- Security reporting pass: the secret scanner now emits a valid `results.sarif` artifact for clean and failing scans, making the pinned CI SARIF upload actionable instead of silently missing its input.
- Office accessibility/data pass: bootstrap now feeds scoped files, memory, evaluation datasets, and tools into the UI tables, while generated agent desks support Enter/Space activation and accessible labels with static regression coverage.
- Backup/restore verification pass: added integration coverage for signed manifests, deliberate vault-key exclusion, verified restoration, and tamper rejection before promotion.
- OAuth hardening pass: added actor-bound, one-time OAuth 2.0 PKCE sessions with S256 challenges, strict HTTPS/loopback redirect validation, bounded session capacity, server-side code exchange, and encrypted credential storage.
- Evaluation execution pass: added deterministic exact-match/contains graders, explicit unsupported-grader failures, scoped evaluation-run persistence, evidence-only results, and API regression coverage.
- Provider fidelity pass: Cohere now uses a native v2 chat/model adapter with normalized tool calls and usage; Azure OpenAI uses deployment-scoped `api-key` requests; and Bedrock uses SigV4-signed Converse requests instead of being silently routed through the OpenAI-compatible wire format.
- Device authorization pass: added bounded actor/provider-bound device-code sessions, server-side polling with pending/slow-down handling, device-code redaction, encrypted token persistence, and API regression coverage.
- Capability normalization pass: added streaming chunk normalization, bounded 32-request batching, OpenAI-compatible SSE parsing, validated OpenAI/Cohere embeddings, and adapter contract coverage across provider families.
- Credential-source pass: added validated environment-variable provider references that resolve at adapter-use time without persisting or returning the environment secret.
- Memory approval pass: added an authenticated, version/CAS-protected memory approval/rejection route with tamper-evident audit events.
- Streaming transport pass: added a DNS-pinned async response transport with abort and 10 MB caps, so OpenAI-compatible SSE chunks are delivered incrementally rather than buffered.
- Runtime streaming pass: the orchestrator now forwards redacted model deltas over the live run event stream while preserving durable usage, tool-call, retry, and cancellation semantics.
- Concurrency guard pass: run starts now enforce agent profile concurrency limits and durably mark excess concurrent runs as blocked.
- Tenant-isolation evidence pass: added `tests/auth-isolation.test.ts`, which mints RS256-signed JWTs and proves the production OIDC path scopes each verified subject to its own tenant while denying unaffiliated and cross-tenant access.
- Office action pass: wired New project, View all, and table Add so they create a project, open the runs table, and create a scoped task; project creation now provisions a blocked-network environment so tasks can be added immediately.
- Office run pass: inspector Start run and scoped chat now post a run and agent memory through the control plane, and Settings is a real table view of workspace/project/auth state.
- Office add pass: the table Add button now creates memory notes, local model registrations, monthly budgets, and workflow graphs for the active project, with browser coverage for each path.
- Office run-control pass: the inspector now pauses, resumes, and stops the selected agent's active run through the existing run-command API, with browser coverage for pause and stop.
- Brand pass: the product is now Samuel Abraham's Bot Buffet in the Office chrome, README, package metadata, and bootstrap workspace name. No Munder Difflin branding remains in the Bot Buffet UI.
- Workspace path pass: agent scratch now lives under the durable data directory so a read-only container root does not fail startup.
