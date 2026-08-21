# Changelog

## 0.1.0 — 2026-08-21

- Initial Bot Buffet control-plane baseline with durable local state, orchestrator, policy/sandbox controls, model routing, Office UI, tests, CI, container, SBOM, and operational docs.
- Security hardening pass: scope-aware authorization and parent checks, production principal isolation, private/offline model enforcement, mandatory high-risk approvals with CAS transitions, realpath/protected-path sandboxing, read-only shell policy, TLS/private endpoint checks, bounded API/SSE resources, and serialized audit mutations.
- Follow-up control-plane pass: durable run idempotency replay, model retry/backoff and time/token/cost limits, MCP server registry, disabled integrity-pinned plugin update/rollback/delete, security headers, typed Role/MCPServer entities, and product/API/plugin/incident/CI documentation.
- Control-plane lifecycle pass: serialized entity mutations, tool timeout enforcement, checkpoint-state fork/rollback, safe project deletion with credential revocation, and disabled schedule/webhook registries.
- Budget enforcement pass: typed `Budget` entity, daily/monthly/lifetime spend windows, scoped budget CRUD and pre-execution cost estimation APIs, durable per-call usage/cost records, and orchestrator admission control that blocks runs on hard limits and emits soft budget warnings.
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
