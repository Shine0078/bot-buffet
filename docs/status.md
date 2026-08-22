# Samuel Abraham — Bot Buffet status ledger

Updated 2026-08-22. This is the source of truth for implementation evidence.

## 2026-08-22 session

### Security-hardening verification update

The registered repository-wide Codex Security Standard scan
`7cbe9768-a037-4700-934b-550b1a3dba15` is sealed with zero reportable findings
across eleven reviewed security surfaces. Its immutable snapshot is revision
`cf869564dd9023b0283512b9f20c4fa07f62728`; the workbench warns that `HEAD`
changed while the scan was running. The current checkout received the
follow-on fixes below and passed the complete local verification suite. The
earlier baseline reported seven high-confidence findings (one critical, three
high, three medium); all of those source paths are now closed and covered by
regressions:

- environment-backed public providers now require exact operator endpoint
  allowlists; production additionally requires exact variable allowlists, and
  control-plane/cloud credential names are rejected;
- unscoped SSE/webhook events fail closed, and budget/injection/tool events carry
  their project scope;
- IPv4-mapped and IPv4-compatible IPv6 literals are treated as private/metadata
  destinations;
- tool output is stored in the fenced untrusted representation before it can
  re-enter model context;
- all file and shell tools now require Docker or a separately managed microVM;
  the unsafe host-process fallback and its ancestor-symlink race are removed,
  and startup probes the runner before the control plane becomes ready;
- evaluation regexes reject nested quantifiers, backreferences, and lookarounds
  before the synchronous engine runs.
- production authentication is now mandatory for `NODE_ENV=production` or any
  non-loopback bind, and Docker/Compose default to `BOT_BUFFET_AUTH_MODE=production`;
- production local-provider environment references now use the same exact
  variable allowlist as public providers;
- `/healthz` and `/readyz` are intentionally unauthenticated liveness probes so
  a production Docker healthcheck can succeed without an OIDC token.
- model locality is derived from the validated provider endpoint rather than a
  caller-controlled body flag, and offline/private routing rejects forged
  metadata;
- high-severity untrusted tool output is durably persisted and transitions the
  run into an explicit approval gate before the next model turn;
- backup state is AES-256-GCM encrypted when a backup key is configured, and
  production restore rejects plaintext state; request and SSE admission buckets
  are scoped per API instance with actor/project/global caps and connection
  lifetimes;
- verification accepts only harness-produced tool evidence, never model text,
  and the secret scan no longer treats a bare `.env` file as an extensionless
  exemption.

Latest evidence: `npm run verify` (64 files, 615 tests),
`npm run preflight`, `npm run audit`, `npm run security:scan`, `npm run sbom`,
`npm run provenance`, `npm run smoke`, `npm run restore:drill`, a Docker image
build, the Docker sandbox integration suite (13 tests), and a negative
production-image startup test without an externally managed runner all passed
as expected. The sealed scan artifacts and SARIF export are at
`C:\Users\samue\AppData\Local\Temp\codex-security-scans-YrbIFO\Bot-Buffet\cf869564dd9023b0283512b9f20c4fa07f62728a_20260822T104520Z_h5b49p9t`
(scan `7cbe9768-a037-4700-934b-550b1a3dba15`). The image intentionally exits
with `sandbox_runner_unavailable` when no dedicated runner is supplied; no
privileged Docker socket is mounted by default.

Remote Desktop Commander inspection of the requested desktop-app download
could not run because the only configured device (`AIONIX`) was offline. The
read-only local review and its scope caveat are recorded in the dedicated
upstream-review document under `docs/`; no unrelated remote files were modified.

Earlier in this session Docker Desktop was failing to start: its Inference
manager could not remove a stale
`AppData/Local/Docker/run/dockerInference` socket whose reparse data was
corrupt, so the engine never came up. Per-file deletion is impossible for those
entries, so the socket directory was rotated aside and the optional Docker AI
feature that owns that socket was disabled in `settings-store.json` (backed up
first). The engine then started, and everything below was verified against it.

Defects found and fixed this session, each at its source:

| Defect                                                                                                                                                                                               | Why it survived                                                                                                         | Evidence now                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Brand gate passed its two-term alternation to `git grep` without `-E`, so the separator was a literal and neither term was ever searched for; it also matched its own source and was permanently red | A gate that is always red is indistinguishable from a gate nobody reads                                                 | `tests/brand-scan.test.ts`, plus a self-test that throws if the pattern stops matching the brand                   |
| `npm run format:check` could not pass on Windows: `core.autocrlf=true` gave a CRLF working tree against LF blobs, flagging all 111 files locally while Linux CI stayed green                         | Nobody ran the gate on Windows                                                                                          | `.gitattributes` pins the working tree to LF on every platform; local `verify` now runs format and lint as CI does |
| Dockerfile copied `tsconfig.json` but the build uses `tsconfig.build.json`, so `npm run build` failed inside the image                                                                               | The CI container job declares `needs: verify`, and verify was failing on the brand gate, so the container job never ran | `docker build` succeeds                                                                                            |
| The server always bound `127.0.0.1`, so a published container port could never reach it                                                                                                              | Same chain: the container job never ran its readiness check                                                             | `BOT_BUFFET_HOST`, loopback by default and `0.0.0.0` in the image; health verified through the published port      |
| The container sandbox never passed `--interactive`, so every sandboxed file write saw EOF on stdin, wrote an empty file, and exited 0                                                                | Silent data loss reported as success; no unit test can see it, because the argument list looks correct either way       | `tests/sandbox-docker.integration.test.ts` against a live daemon                                                   |
| The preflight reported Docker healthy from `docker --version`, which answers from the client alone                                                                                                   | Written and then immediately reproduced on this machine, where Docker was installed and not running                     | Probes `docker info`; absent and stopped are distinct states with distinct remediation                             |

Container evidence, against the built image: `/healthz` and `/readyz` answer
through the published port, the UI is served, the API returns the bootstrap
project, security headers are present, the process runs as uid 100 rather than
root, and Docker's own healthcheck reports `healthy`.

Container sandbox evidence, against a live daemon: the container runtime is
selected, reads and writes round-trip through the bind mount and are confirmed
on the host, execution is as uid 65532, the network is unreachable, the root
filesystem refuses writes with `EROFS`, non-zero exits are reported, and any
network policy other than `blocked` is refused. `BOT_BUFFET_REQUIRE_DOCKER_TESTS=1`
in CI turns a missing daemon into a failure so this coverage cannot skip silently.

Added this session:

- Installation preflight (`npm run preflight`) enforcing the Node floor from
  `package.json`, with blockers and warnings separated and per-platform
  remediation. Decision logic is pure, so the Windows branches are tested on any
  host.
- Checksum-verified model artifact import. No digest means no import; the digest
  is recomputed by streaming the file and compared in constant time; free space
  is checked before any transfer; names are confined to the model store.
  `POST /api/v1/local-models/import/plan` previews size, space, host resources,
  and fit before a download starts.
- Host resource detection that reports GPU and VRAM as explicitly undetected
  rather than guessed, because a wrong VRAM figure would green-light a model the
  machine cannot load.
- Portable local model configuration export/import, carrying no credential
  material and revalidating every endpoint on import.
- Digest-pinned sandbox image required in production, failing closed at startup.
- Structural guard holding the Office UI to its escaping rule.

### The declared-but-never-read audit

Enforcing run modes revealed a pattern worth naming: a field declared on the
agent profile, validated when written, stored on every record, and read by
nothing at runtime. Every such field is a safety property the interface
promises and the runtime does not provide. Auditing all sixteen profile fields
for actual runtime consultation found five:

| Field                | What it promised                                                            | What it did                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`               | plan/review/chat/supervised/autonomous/maintenance/emergency-stop semantics | Nothing. A `plan` run could mutate files exactly like `autonomous`, and `emergency-stop` did not stop anything.                           |
| `verificationPolicy` | Which checks decide whether a run may claim completion                      | Nothing. One hardcoded substring check ran regardless, so `requireEvidence: false` still required evidence and declared checks never ran. |
| `memoryPolicy`       | Readable and writable memory scopes, approval, retention                    | Nothing — and the orchestrator never loaded memory into agent context at all, so the policy governed a path that did not exist.           |
| `escalationPolicy`   | pause / retry / delegate / stop on failure                                  | Validated on write, never read. Every failure ended the run as `failed`.                                                                  |
| `environmentKeys`    | Which environment variables an agent may see                                | Nothing. The local sandbox inherited the entire parent environment, including the master key and OIDC configuration.                      |
| `skills`             | Progressive-disclosure references                                           | Nothing. An agent was never told its own skills existed.                                                                                  |

All six are now enforced, each with unit coverage for the decision and
orchestrator-level coverage for the wiring — because a pure function passing
its tests proves nothing about whether the loop consults it, which is precisely
how these survived.

Plugin activation is now a real scoped read path: effective plugins are filtered
by workspace/project/agent grants and the agent profile's `allowedPluginIds`.
Dependency, permission/network/retention, and auth-status review endpoints are
available; vault-backed plugin auth setup uses CAS versions, short fingerprints,
uninstall/revoke cleanup, and update/rollback/uninstall use current-version CAS
checks with integrity pinning. Model requests now dynamically expose only the
enabled, allowlisted tool schemas for the current agent; execution repeats that
allowlist check. The plugin list is still intentionally not an invocation
authority; a future executable host must consume this same helper before
exposing any plugin tool.

Suite: 622 tests across 64 files, all passing, with `verify` covering format,
lint, types, tests, build, and the brand gate. Coverage thresholds are ratcheted
to the measured figures so a regression fails rather than eroding quietly.

Still owner gates: staging and production deployment, real provider-account
integration tests, off-host backup custody, signed provenance/attestation, and
a production rollback drill.

## Delivered locally

- TypeScript/Node build, durable JSON state, entity hierarchy, audit hash chain, locks, and atomic writes.
- Orchestrator loop: context assembly, routing, model call, typed tool validation, policy/approval gate, sandboxed execution, verification, checkpointing, pause/resume/stop/fork/rollback.
- Local mock model and OpenAI-compatible adapter; offline router guard and local discovery probes.
- Filesystem/shell tools with lexical plus realpath confinement, allowlisted/protected descendants, metacharacter and code-execution-flag rejection, read-only command policy, timeout, output, and network controls.
- Office UI, responsive list/table alternative, SSE live events, health/readiness, and emergency stop.
- Unit/security/integration tests, CI, container, SBOM, and operations documents.
- Schedules now have a bounded cron/timezone parser and a durable local dispatcher: CAS minute claims prevent duplicate triggers across workers, assigned-agent/project/environment checks fail closed, and trigger/error outcomes are audited with restart-safe last-run state.
- Explicitly expired memory records can be pruned through an authorization-filtered, namespace-scoped, 1,000-record bounded route; deletion counts are audited and policy-based read retention never becomes an implicit delete.
- Run control mutations now use compare-and-swap versions, so concurrent pause/resume/cancel/stop/rollback commands cannot silently overwrite a newer state transition.
- Accepted run-control commands now record the authenticated operator (rather than defaulting every API action to the run owner) and emit immediate project-scoped SSE/webhook events for pause, resume, cancel/stop, fork, and rollback.
- State loading now applies an explicit schema migration boundary, persists normalized legacy state, and rejects malformed or future schema versions before any entity is served.
- Encrypted credential vault, provider test/revoke endpoints, actor-bound OAuth PKCE start/callback exchange, authorization-filtered memory/plugin/file APIs, parent-scope checks, approval expiry/CAS, request limits, correlation IDs, and bounded SSE.
- Device authorization now uses bounded actor/provider-bound sessions, server-side device-code polling, RFC pending/slow-down handling, and encrypted credential persistence without returning device codes or provider error bodies.
- Provider capability normalization now exposes streaming chunks, bounded 32-request batching, parses OpenAI-compatible SSE streams, validates OpenAI/Cohere embedding vectors, and preserves explicit unsupported-capability behavior.
- Provider creation now supports validated environment-variable credential references; adapter use resolves the variable without storing the raw secret in the vault or API state.
- Memory writes now require an explicit, version/CAS-protected approval transition before becoming durable approved context, with audit records for both approval and rejection.
- OpenAI-compatible streaming now uses a DNS-pinned async transport with incremental SSE delivery, abort support, and the same 10 MB response cap as buffered provider calls.
- Project duplication now copies only validated configuration with fresh IDs,
  resets active execution state, disables copied schedules/workflows/budgets,
  excludes credentials and live artifacts, and resolves slug collisions. The
  API and service tests cover remapping, exclusion, reset state, and collision
  behavior.
- Core project, task, run, and audit lists now support bounded cursor pagination
  while preserving array responses for existing callers without query params;
  resource filters are validated before authorization-filtered reads, and
  malformed cursors or out-of-range limits fail before data access.
- Durable incident records now have scoped create/list/CAS lifecycle routes,
  redacted bounded evidence, audited open/acknowledged/resolved transitions,
  and an Office table view separate from generated alerts.
- Plugin activation now has CAS-protected workspace/project/agent assignment
  and unassignment routes, matching workspace boundaries and administrator
  authorization. Effective agent plugin reads enforce both activation scope and
  the profile `allowedPluginIds` allowlist; enabling a narrowly assigned plugin
  does not widen it to the whole workspace.
- The orchestrator now consumes the normalized stream contract, emits redacted `model.delta` events to live run subscribers, and aggregates streamed content/tool arguments into the same durable response and accounting path.
- Orchestrator starts now enforce each agent profile's concurrency limit; excess runs become durably blocked with an explicit error while the active run retains normal checkpoint/retry behavior.
- Budgeted context assembler with freshness/relevance ordering, compaction, redaction, and source-citation carry-through.
- Research source intake, evaluation dataset/case registration and deterministic evaluation-run execution, run replay/export, and aggregated observability summary endpoints.
- Research foundation captured in `docs/research-foundation.md`, including inspected sources and explicit inaccessible-source owner actions.
- Portable backup/restore scripts verify SHA-256 manifests, optionally sign them with HMAC-SHA-256, and restore into a separate target directory by default.
- Development credential vaults generate a random 32-byte key beside the encrypted record instead of deriving key material from the username; the key is intentionally excluded from backups.
- Multi-agent coordination helpers provide structured handoff packets, evidence comparison, and bounded parallel execution.
- Durable idempotency replay, run time/token/cost guards with model retry backoff, MCP server metadata, integrity-pinned disabled plugin lifecycle operations, security headers, and API/plugin regression coverage.
- Safe project deletion with child credential revocation, disabled schedule bindings, and HTTPS/secret-protected webhook metadata routes.
- CI now pins third-party action SHAs and emits an unsigned commit/artifact provenance manifest; the latest local provenance evidence covers 44 build artifacts; signed OIDC attestation remains a release-owner gate.
- Anthropic and Gemini now use native provider adapters instead of being routed through the OpenAI-compatible wire format.
- Cohere now uses a native v2 chat/model adapter with normalized content, tool calls, usage, health, and model discovery; Azure OpenAI uses deployment-scoped `api-key` requests; and Bedrock uses SigV4-signed Converse requests with region-aware model probes.
- The production entrypoint now uses the same provider adapter factory as the API/control-plane registry, so native adapter selection is effective at runtime.
- Production authentication now validates RS256 OIDC bearer JWTs in-process, fails closed when issuer/audience/JWKS configuration is absent, and maps verified `sub` claims to scoped actors; loopback-only bootstrap auth is separate.
- Provider adapters now use a pinned socket transport: the DNS-preflight address is passed directly to the connection while preserving the provider hostname for Host/SNI, with response and abort caps covered by tests.
- Built-in filesystem and shell tools now route through a Docker or separately managed microVM runtime; startup fails closed when the runner is unavailable, and Docker execution applies a read-only workspace, no network, dropped capabilities, `no-new-privileges`, resource limits, and a non-root user.
- Local model discovery now probes Ollama, LM Studio, llama.cpp, LocalAI, vLLM, and Jan loopback endpoints.
- Authenticated `GET /api/v1/local-models/discover` now exposes those loopback probes to the Office UI and operators with an explicit `offlineOnly` result contract; cloud discovery is never used.
- Scoped `GET/POST /api/v1/model-routes` now exposes validated project/agent routing policies with bounded fallback chains, privacy/offline strategies, and cost ceilings to the model router.
- The model router now enforces route cost ceilings against estimated input/output tokens, honors weighted and lowest-latency strategies from model metadata, and rejects non-finite API cost ceilings before persistence.
- Authenticated environment, agent, and task APIs now create project-scoped workbench resources with blocked-network agent defaults, bounded profile/task fields, and assignee/parent/dependency scope checks.
- Task updates now require compare-and-swap versions and an allowlisted lifecycle transition, preventing stale or terminal-state overwrites.
- Routing now authorizes referenced models and constrains automatic inventory selection to the active project/workspace scope, preventing cross-project model leakage.
- Authenticated local-model registration now creates or reuses loopback providers/models idempotently, rejects cloud provider kinds, and returns an explicit offline-only contract.
- Office bootstrap now supplies scoped files, memory, evaluation datasets, and registered tools to the table views; agent desks expose keyboard activation and accessible labels with regression coverage.
- Agent profiles now support authenticated, versioned `PATCH /api/v1/agents/:id` updates with bounded model/tool/path/resource settings, compare-and-swap stale-write rejection, immutable approval/verification/memory policy subdocuments, bounded change history, and tamper-evident audit events containing only versions and changed field names.
- Shared response/event redaction now preserves operational token limits and usage counters while continuing to redact credential-shaped keys and values.
- Schedule and webhook enable/disable routes now require a compare-and-swap `version` in the request body, so concurrent or replayed toggles cannot silently overwrite newer state.
- Webhooks now validate subscriptions against a published event catalog, expose a signed test-delivery route, and dispatch redacted subscribed orchestrator events through DNS-pinned HTTPS with versioned HMAC signatures, bounded exponential retries, and outcome-only audit records. Live endpoint delivery, replay/forgery testing, and production worker/queue evidence remain owner gates.
- Budgets are now enforced rather than only reported: daily/monthly/lifetime windows, scoped `GET/POST /api/v1/budgets`, pre-execution `POST /api/v1/budgets/estimate`, durable per-call usage/cost records, orchestrator admission control that durably blocks runs on hard limits with a `budget.blocked` audit record, and non-blocking soft warnings. Estimate requests authorize and project-check any supplied `agentId` so budget scope cannot be narrowed by an unauthorized caller.
- Cost, token, and latency reporting is now queryable: `GET /api/v1/usage` aggregates by project, agent, model, or run over daily/monthly/lifetime windows with authorization-filtered inputs, no double counting between cost and usage records, malformed-number rejection, and run-rate forecasting. `GET /api/v1/alerts` exposes the durable redacted budget alerts the orchestrator raises at warn and hard-limit thresholds.
- Workflow graphs are now executable structure rather than dormant types: bounded DAG validation rejects cycles, self loops, duplicate ids, unknown edges, unsupported node kinds, and oversized graphs; `workflowLevels` orders nodes into concurrent dependency levels; and `readyNodes` withholds descendants of failed nodes. Scoped `GET/POST /api/v1/workflows` and `GET /api/v1/workflows/:id/plan` expose this to operators, with workflows created disabled.
- The Office UI now exposes budgets, monthly usage by agent, workflow graphs, and operator alerts as accessible table views, backed by an extended bootstrap payload and a live `GET /api/v1/usage` fetch; regression coverage asserts each view is wired rather than only present in markup.
- A runtime smoke suite (`npm run smoke`, wired into CI after build) starts the compiled server and asserts health, readiness, bootstrap, usage, alerts, workflow create/plan, budget creation, and negative cases against a live HTTP surface. It caught a real redaction defect where aggregate `totalTokensIn`/`totalTokensOut` counters were masked as credentials; the operational-key allowlist was corrected at source with regression coverage.
- Artifacts are now a real registry rather than a dormant type: `GET/POST /api/v1/artifacts` records SHA-256 content hashes with project/run scope checks, export scanning blocks embedded credential material, private keys, null bytes, and oversized payloads before persistence, and `GET /api/v1/projects/:id/artifact-manifest` emits an order-independent, tamper-evident checkpoint manifest.
- Evaluations now cover both sensor classes. Computational graders include exact match, containment, normalized containment, bounded regex, numeric tolerance, and JSON-schema validation, each failing closed on hostile or malformed input. Inferential grading accepts a separated judge whose verdicts are score-bounded and which fails the case when it throws or returns a non-finite score. `compareToBaseline` and `releaseGate` turn a golden dataset into a release gate that blocks on regressions, dropped cases, or a pass rate below the configured floor; `POST /api/v1/evaluations/runs` accepts `baselineRunId` plus `minimumPassRate` and writes an `evaluation.gate` audit event. Implementing the schema grader exposed a real defect: `validateJsonSchema` returns an error array rather than throwing, so the original grader passed every schema case. Fixed at source with regression coverage.
- Regex evaluation now walks nested groups, escapes, and character classes before allowing synchronous matching, rejecting nested quantifiers at any depth while retaining simple grouped expressions. A regression covers deeper nested optional quantifiers and a valid grouped pattern.

## Evidence

The final registered Standard scan `7cbe9768-a037-4700-934b-550b1a3dba15`
sealed zero reportable findings across the repository-wide surface. Its
canonical artifacts and SARIF export are at
`C:\Users\samue\AppData\Local\Temp\codex-security-scans-YrbIFO\Bot-Buffet\cf869564dd9023b0283512b9f20c4fa07f62728a_20260822T104520Z_h5b49p9t`.
The report targets the immutable `cf86956` snapshot and explicitly warns that
the repository `HEAD` changed while it ran; the follow-on current-tree fixes
including the schedule dispatcher, expiry-pruning, CAS run-control, and state
migration-boundary changes
are covered by the local evidence above but are not part of that sealed snapshot. No replacement
connector scan is available in this environment. TAC access remained
unavailable because the security connector is not connected.

The current-tree Standard scan `6092a041-2f28-471b-b42a-c9966049e310` reviewed
revision `3b2c812b06787198cccbb17d8814b2e06cf4b481` and reported one medium
regex-denial-of-service candidate. The cited optional-quantifier example was
already covered by `tests/evaluations.test.ts`; the follow-up structural group
parser and deeper-group regression now reject the broader nested-quantifier
class. Its canonical report is at
`C:\Users\samue\AppData\Local\Temp\codex-security-scans-YrbIFO\Bot-Buffet\3b2c812b06787198cccbb17d8814b2e06cf4b481_20260822T164744Z_15qrh36b`.

The post-remediation repository gate is authoritative at 622 passing tests
across 64 files; the longer historical coverage sentence below predates the
new nested-group regression.

Run `npm run verify` for typecheck, tests, and build. Run `npm run audit`, `npm run security:scan`, and `npm run sbom` before release. The current suite reports 621 passing tests across 64 files and covers redaction, path traversal, shell controls, endpoint SSRF/TLS checks, pinned provider egress, incremental streaming transport, encrypted credential persistence and production key validation, random development vault-key persistence, context compaction/citations, memory approval/CAS, explicit memory expiry/pruning, audit integrity/CAS, locks, idempotency claims and API replay, offline/private routing with provider-derived locality, native provider adapters and wire/signature normalization, normalized streaming, bounded batching, embedding vectors, environment-variable credential references, authenticated local model discovery, idempotent local model registration, local runtime discovery coverage, tool contracts and timeout caps, central tool enabled-state and invocation audit behavior, model-facing dynamic tool exposure and execution allowlists, API limits/auth, verified OIDC authentication, actor-bound OAuth PKCE and device authorization start/poll state consumption, pending/slow-down handling, deterministic evaluation execution and unsupported-grader handling, project deletion and safe project duplication, bounded cursor pagination, plugin lifecycle, scoped plugin assignment and effective agent allowlists, plugin dependency/permission/auth review and vault cleanup, plugin update/rollback/uninstall CAS and integrity pinning, MCP enable/disable CAS and audit behavior, bounded cron/timezone matching and CAS schedule dispatch, checkpoint state recovery, compare-and-swap run control and rollback/executor race protection, schema migration boundaries and future-version rejection, Docker-only sandbox runtime fail-closed/Docker argument controls, Office UI accessibility/data contracts, per-agent concurrency admission, bounded SSE admission and lifetime cleanup, model-route management and enforcement, environment/agent/task lifecycle scope checks, compare-and-swap task transitions, finite model metadata validation, routing scope isolation, signed AES-GCM backup/restore plus tamper rejection, versioned agent profile updates, operational-token redaction behavior, profile audit events, webhook signature/replay rejection, event catalog validation, signed test delivery, webhook API authorization, deployment auth posture, public production health probes, and scoped incident lifecycle records with redacted evidence and CAS transitions. Local smoke checks cover health/readiness, UI delivery, a completed run, bearer auth, provider credential redaction, scoped memory, plugin enablement, source intake, evaluation registration and execution, project export, and observability summary; real external provider and deployment evidence is not claimed.

The committed Codex Security standard scan `2a4ee2aa-d64e-4f14-aff2-557f320b9e21` reviewed the earlier committed scope at revision `36578cd` and produced one source-backed high finding: the development/local fallback still performs host filesystem operations without a kernel sandbox or descriptor-relative no-follow guarantee. Production now refuses that fallback, but Docker/microVM staging and escape evidence remain external. The provider working-tree diff was reviewed in scan `b19a1d6b-91c8-4ed2-8661-b635d175013b` against the pre-commit snapshot and produced zero reportable findings across provider selection, Cohere, Azure OpenAI, Bedrock/SigV4, credential validation, redaction, and model probes. The device-authorization working-tree diff was reviewed in scan `0b920189-fde4-48d6-b038-40ab4b640f0a` against `bfa691ed`; all four changed source files were covered and no reportable findings were identified. The final provider-capability diff was reviewed in scan `ab12068c-be09-4ddf-92ef-565abb3a3efe` against `2a9d48f`; the changed provider source was fully covered with no reportable findings. The environment-credential diff was reviewed in scan `ae628e4d-c52d-4cd5-a16c-8d81d64edd4c` against `0f07740`; all four changed source files were covered with no reportable findings. The memory-approval diff was reviewed in scan `9e6d2118-7119-4a99-a28b-dbe55ff1a8aa` against `b7421b3`; the changed API route was fully covered with no reportable findings. The async streaming transport working-tree diff was reviewed in scan `a3814d06-7c36-423f-8b02-c3b8b3199234` against `4a14b5dd8dd9ce7571078ddaa681b901e1b941d5`; the changed transport and provider adapter surfaces were fully covered with zero reportable findings. The orchestrator streaming-event working-tree diff was reviewed in scan `57859849-7b7c-4ad2-8290-b91a35b9e78d` against `a5884c21f953e62768450c4a3cfde2633a49b1e8`; the changed orchestrator surface and regression/documentation artifacts were fully covered with zero reportable findings. The authenticated local-model discovery diff was reviewed in scan `28b5b119-f1a3-44b2-83f3-be8327c14131` against `83cbbc9b8e01b8e8f1ae05bbdb282ad157743397`; the changed API route and test/documentation surfaces were fully covered with zero reportable findings. The agent-concurrency diff was reviewed in scan `6534662a-a1eb-4b13-b37b-ce5bfa7a3ae4` against `b6d4216704e1a724fd0a95ea330e4321421a81a9`; the changed admission/cleanup logic and concurrency regression surface were fully covered with zero reportable findings. The model-route management diff was reviewed in scan `ef279e37-289e-4557-b730-a9b89ed1ceaf` against `50e852a8ab258d5e50ffc0fe477e55d0d457f52b`; the changed scoped route API and regression/documentation surfaces were fully covered with zero reportable findings. The routing-enforcement working-tree diff was reviewed in scan `74db8ade-3a82-4db6-b173-abfe8c47c908` against `bca9b3d74a59d27ce2b22533e484aa8e159b8413`; all four changed source files were covered with zero reportable findings. The workbench lifecycle working-tree diff was reviewed in scan `ccf33d53-3c50-4272-b3b4-379a61d09ab5` against `9d595ca`; the changed API source was fully covered with zero reportable findings. The task-transition working-tree diff was reviewed in scan `d8895cf8-a8ec-416f-b865-87d5813b1b96` against `466fab8`; the changed task mutation surface was fully covered with zero reportable findings. The model-metadata validation working-tree diff was reviewed in scan `7ca15301-cf6a-43fd-a557-2405f26a6cb9` against `ed483d7`; the changed model registration surface was fully covered with zero reportable findings. The routing-scope-isolation working-tree diff was reviewed in scan `a0970972-ab02-4ed0-8e1c-6496ec8ccd35` against `ed7141f`; all three changed routing source files were covered with zero reportable findings. The local-model registration working-tree diff was reviewed in scan `8cd98155-b735-415c-a7dc-1d98baacf4ba` against `64b9d3c`; the changed local registration source was fully covered with zero reportable findings. The reused-model authorization working-tree diff was reviewed in scan `8d2cf160-ab97-4fc1-913b-03f8cd865158` against `32443ad`; the changed authorization guard was fully covered with zero reportable findings. CI action SHAs are immutable; signed OIDC provenance/attestation, backup encryption and external key custody, immutable retention, webhook delivery signing, real provider-account tests, staging deployment, and restore drills remain owner gates. The security scans recorded that the TAC access advisory was unavailable because the security connector is not connected.

The final agent-profile/redaction working-tree diff was reviewed in scan `c1b4327c-e973-45d6-8d7d-e486d26280da` against `944de4d82d67664061e962deb59907f78b5f0493`; `src/api.ts`, `src/security.ts`, and their regression surfaces were fully covered with zero reportable findings. TAC remained unavailable because the security-access connector was not connected.

The profile-audit working-tree diff was reviewed in scan `be142bc7-f697-411d-a7f9-59846ef5dcfa` against `2e00e9481f7eeae5688ad79237d8d9fca68dbf27`; the changed API handler and regression assertion were fully covered with zero reportable findings. TAC remained unavailable because the security-access connector was not connected.

The webhook working-tree diff was reviewed in scan `0a2435ff-7afa-4696-99d6-2518c33a2cbb` against `2c0e70b7817c7a54fbb117042ab2d32e68426deb`; `src/api.ts`, `src/webhooks.ts`, and their regression surfaces were reviewed with zero reportable findings. Coverage is intentionally partial for live receiver/replay testing, high-rate retry/load exhaustion, and the container/microVM boundary. TAC remained unavailable because the security-access connector was not connected.

After adding the bounded 10-second webhook request abort and rejection guard, the final working-tree diff was reviewed in scan `e6e354e6-eedc-4d41-a255-6dc5ab0bf9f3` against the same base revision with zero reportable findings. The same external coverage limitations remain.

- Observability is now collector-ready. `GET /api/v1/runs/:id/trace` renders a run and its durable steps as an OTLP/JSON payload with deterministic trace/span ids, parent-child structure, client spans for model and tool calls, error status mapping, and redacted error messages, so traces survive process restarts because they derive from persisted state rather than in-memory spans. `GET /metrics` exposes scrapeable gauges for total/active/failed runs, cumulative cost, and unacknowledged alerts. Both are covered by unit, API, and live smoke checks.

- Browser and accessibility testing is now real rather than string matching. A Playwright suite (pinned `playwright@1.62.1`, `axe-core@4.12.1`, Chromium installed in CI) loads the served Office UI, asserts zero console/page errors, exercises every table view including the new budget/workflow/alert/usage views, verifies keyboard focus reaches interactive controls with a visible focus indicator, checks the 390px mobile layout for horizontal overflow, and runs axe against WCAG 2 A/AA on both the office floor and a table view. axe is evaluated over CDP rather than injected as a script tag, so the application's real Content-Security-Policy stays enforced during the audit. The suite immediately found six genuine serious-impact WCAG contrast failures in `--muted`, `--mint-strong`, the live indicator, and the whiteboard label; the design tokens were darkened at source and the audit now reports zero violations.

- A real restore drill now runs in CI (`npm run restore:drill`). It creates live control-plane state through the HTTP API, verifies the audit chain, takes a signed backup, destroys the data directory outright, restores from the backup, restarts the server, and proves the project, artifact, and tamper-evident audit chain all survived. This closes the local half of the backup/restore gate; off-host backup custody, immutable retention, and production restore evidence remain owner gates.

- Cross-tenant and project isolation now has direct evidence in `tests/isolation.test.ts`: cross-workspace reads and writes are denied, project-scoped record filtering returns only the caller's tenant data, an actor with no membership is denied entirely, and role actions are enforced rather than granting blanket workspace access.
- Cross-tenant isolation now extends through the verified production OIDC path: `tests/auth-isolation.test.ts` mints real RS256-signed JWTs and proves a signed `alice` token lists only her project, a signed `bob` token lists only his, an unaffiliated signed subject sees nothing, and a validly signed cross-tenant write attempt is denied. The remaining identity work is provisioning a real issuer and membership store.
- Office action buttons now have handlers: New project posts a project and a blocked-network environment, View all opens the runs table, and table Add creates a scoped task. Browser coverage clicks those buttons instead of only asserting markup.
- Inspector Start run posts `/api/v1/runs` for the selected agent's project and task, chat persists an agent-scoped memory item and starts a run, and Settings renders live workspace/project/auth rows. Browser coverage clicks Start run, sends chat, and opens Settings.
- Table Add now creates the record that matches the current view: project-scoped memory, a local model registration, a monthly budget, or a one-node workflow. Browser coverage clicks Add in each of those views.
- Inspector Pause, Resume, and Stop now call `/api/v1/runs/:id/{pause,resume,stop}` for the selected agent's active run. Browser coverage pauses a live run, returns to the office floor, and stops it.
- Agent workspace files now resolve under the durable data directory (`BOT_BUFFET_DATA_DIR/workspace`) so a read-only container root does not fail `mkdir` at startup.

- The research workspace is now enforced rather than declarative. `POST /api/v1/sources/:id/retrieve` fetches content over the same SSRF-hardened, DNS-pinned transport used for providers, records a SHA-256 content hash and retrieval timestamp on success, and durably marks the source `inaccessible` on failure instead of inventing analysis. Citation verification is decided by the harness, never asserted by the caller: `POST /api/v1/citations` rejects empty claims and unknown sources, and marks `verified` only when the backing source is available, retrieved, and hashed. `GET /api/v1/projects/:id/research-brief` reports usable/pending/inaccessible source counts, unsupported claims, and contradictions detected by negation or divergent numeric values across claims about the same subject.

- Durability now has direct evidence in `tests/durability.test.ts`: state is written by one store instance and recovered by a fresh instance over the same directory, which is exactly what a crashed and relaunched process does. Projects, run counters, and checkpoint state survive; memory that context compaction omits still exists durably afterward, proving compaction is a context decision and not data loss; and a failed run retains its last checkpoint so work can resume. The audit hash chain verifies after every recovery.
- Sandbox boundaries are now exercised adversarially in `tests/sandbox-boundaries.test.ts`: absolute paths, encoded and nested traversal, null bytes, workspace-escaping symlinks, protected-path access through a nested directory, and five shell-injection metacharacter classes are all rejected.
- Filesystem reads now return a SHA-256/version witness and writes accept an optional expected digest. The harness checks the durable `ProjectFile` record and current sandbox bytes before mutation, rejects stale writes with `filesystem_write_conflict`, and updates the versioned file record after successful edits; `tests/tools.test.ts` covers the conflict path.

- Prompt-injection defense and untrusted-content labeling are now implemented in `src/injection.ts` and enforced in the orchestrator. Every tool result is treated as external data: it is fenced with an explicit `<untrusted origin="...">` wrapper carrying a standing instruction that its contents are data and never commands, attempts to close the fence early are neutralized so a payload cannot escape into the operator-trusted region, and the origin label is sanitized. Six instruction-shaped patterns are detected (instruction override, role override, spoofed system turns, exfiltration, tool coercion, fence escape). Detections are written to durable run state as a `:trust` and `:injection` marker, emitted as an `injection.detected` event, and recorded as a `tool.untrusted_content` audit event whose decision is `approval-required` for high-severity signals. `tests/orchestrator-injection.test.ts` proves this end to end with a tool that returns a poisoned payload during a real run.
- Security fix: `decidePolicy` compared risk backwards, so a rule written as "require approval for high risk" also matched every safe and low-risk action. The comparison now treats a rule's risks as a threshold, and `tests/security.test.ts` pins the semantics, including deny-before-approve ordering and project scoping. This was found while building the injection test, when a safe read unexpectedly paused for approval.

## Completion assessment (2026-08-21)

Measured against the master prompt's acceptance criteria, not against effort spent.

| Area                                                       | State                                       | Evidence                                                                            |
| ---------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| Control plane, entities, audit chain                       | Complete                                    | 162 tests, audit chain verification, cross-tenant isolation suite                   |
| Orchestrator loop, checkpoints, pause/resume/fork/rollback | Complete                                    | `tests/orchestrator.test.ts`                                                        |
| Local model registry and offline enforcement               | Complete                                    | discovery/registration routes, offline-only contracts                               |
| Online provider adapters                                   | Implemented, unproven against real accounts | wire/signature unit coverage only; owner gate 3                                     |
| Routing, budgets, cost/usage reporting                     | Complete                                    | `src/router.ts`, `src/budgets.ts`, `src/reporting.ts`                               |
| Tools, permissions, approvals, audit                       | Complete                                    | typed contracts, CAS approvals, threshold policy tests, injection labeling          |
| Sandboxing                                                 | Boundaries verified; kernel escape unproven | adversarial traversal/symlink/injection suite; live Docker daemon integration suite |
| Memory, context budgeting, compaction                      | Complete                                    | context budgeting plus restart/compaction/failure durability evidence               |
| Workflows and artifacts                                    | Complete                                    | DAG validation/scheduling, scanned artifact registry, manifests                     |
| Office UI and accessible tables                            | Complete                                    | browser-verified views, keyboard focus, mobile layout, contrast fixes               |
| Browser and axe accessibility tests                        | Complete                                    | `tests/browser.test.ts`: Playwright + axe WCAG2 A/AA, zero violations               |
| Observability                                              | Complete locally                            | OTLP run traces, `/metrics`, summary/usage/alerts endpoints                         |
| Evaluations                                                | Complete                                    | 6 graders, separated judge, golden baseline + audited release gate                  |
| CI/CD                                                      | Complete locally                            | format, types, tests, lint, audit, secret scan, build, smoke, SBOM, provenance      |
| Deployment, backups, rollback                              | Restore drill verified; deploy unverified   | `npm run restore:drill` destroys and restores state in CI; no staging deploy        |
| Documentation                                              | Complete for implemented surface            | 29 documents kept in sync per commit                                                |

Honest completion estimate: roughly 91 percent of the specification. The research workspace, durability recovery evidence, adversarial sandbox boundaries, cross-tenant isolation, prompt-injection defense, and signed webhook delivery path have now been implemented and verified locally, closing every locally feasible gap identified in the previous assessments. What remains cannot be truthfully claimed from this machine: live webhook endpoint delivery and replay/forgery evidence, real provider-account integration tests, kernel sandbox escape verification in a container or microVM, staging and production deployment, and a production rollback drill. Those are enumerated as owner gates below with exact actions. The estimate stays below 100 percent deliberately, because the acceptance criteria require verified staging deployment and production health, logs, alerts, and rollback evidence, which no amount of local work can supply.

## External owner gates (not claimable locally)

1. Configure an identity provider and production secret store; owner must set least-privilege OAuth/API credentials.
2. Provision Postgres/D1, object storage, queue/workflow, vector index, TLS/domain, backups, alerts, and a staging environment.
3. Connect and run real integration tests for each online provider and optional Cloudflare/GitHub/Figma/Asana/Canva/SciSpace/Consensus/Wolfram connectors.
4. Perform staging deployment, restore drill, rollback drill, penetration testing, and production approval.

Each gate has exact actions in `docs/owner-gates.md`.

## Verification limitation

The local TypeScript, test, lint, audit, build, HTTP health/auth, UI delivery, run, audit-chain, SBOM, image-build, container-readiness, and Docker sandbox checks are rerun after each implementation commit. Production JWT validation is implemented, but real issuer configuration, tenant memberships, and provider accounts remain owner-supplied. Cohere, Azure OpenAI, and Bedrock have unit-level wire/signature coverage; the owner must still run real sandbox-account integration tests for each provider. The local daemon is now reachable and the image/runtime checks passed; kernel escape/TOCTOU verification, signed image attestation, staging deployment, external backup custody, and production rollback remain external gates. Owner action: provision the production identity/secret store and staging runner, pin and attest the sandbox image, start with `BOT_BUFFET_AUTH_MODE=production` and `BOT_BUFFET_SANDBOX_MODE=docker`, call `/readyz`, execute a smoke run, inspect logs/mount/network policy, run the sandbox escape/TOCTOU suite, and perform rollback verification. These are explicit external gates, not completion claims.
