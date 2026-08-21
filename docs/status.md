# Bot Buffet status ledger

Updated 2026-08-21. This is the source of truth for implementation evidence.

## Delivered locally

- TypeScript/Node build, durable JSON state, entity hierarchy, audit hash chain, locks, and atomic writes.
- Orchestrator loop: context assembly, routing, model call, typed tool validation, policy/approval gate, sandboxed execution, verification, checkpointing, pause/resume/stop/fork/rollback.
- Local mock model and OpenAI-compatible adapter; offline router guard and local discovery probes.
- Filesystem/shell tools with lexical plus realpath confinement, allowlisted/protected descendants, metacharacter and code-execution-flag rejection, read-only command policy, timeout, output, and network controls.
- Office UI, responsive list/table alternative, SSE live events, health/readiness, and emergency stop.
- Unit/security/integration tests, CI, container, SBOM, and operations documents.
- Encrypted credential vault, provider test/revoke endpoints, actor-bound OAuth PKCE start/callback exchange, authorization-filtered memory/plugin/file APIs, parent-scope checks, approval expiry/CAS, request limits, correlation IDs, and bounded SSE.
- Budgeted context assembler with freshness/relevance ordering, compaction, redaction, and source-citation carry-through.
- Research source intake, evaluation dataset/case registration and deterministic evaluation-run execution, run replay/export, and aggregated observability summary endpoints.
- Research foundation captured in `docs/research-foundation.md`, including inspected sources and explicit inaccessible-source owner actions.
- Portable backup/restore scripts verify SHA-256 manifests, optionally sign them with HMAC-SHA-256, and restore into a separate target directory by default.
- Development credential vaults generate a random 32-byte key beside the encrypted record instead of deriving key material from the username; the key is intentionally excluded from backups.
- Multi-agent coordination helpers provide structured handoff packets, evidence comparison, and bounded parallel execution.
- Durable idempotency replay, run time/token/cost guards with model retry backoff, MCP server metadata, integrity-pinned disabled plugin lifecycle operations, security headers, and API/plugin regression coverage.
- Safe project deletion with child credential revocation, disabled schedule bindings, and HTTPS/secret-protected webhook metadata routes.
- CI now pins third-party action SHAs and emits an unsigned commit/artifact provenance manifest; signed OIDC attestation remains a release-owner gate. The latest provenance run covers 36 artifacts at commit `fdbba0a936abcfeb97405164d52da31a42d8f8d6`.
- Anthropic and Gemini now use native provider adapters instead of being routed through the OpenAI-compatible wire format.
- Cohere now uses a native v2 chat/model adapter with normalized content, tool calls, usage, health, and model discovery; Azure OpenAI uses deployment-scoped `api-key` requests; and Bedrock uses SigV4-signed Converse requests with region-aware model probes.
- The production entrypoint now uses the same provider adapter factory as the API/control-plane registry, so native adapter selection is effective at runtime.
- Production authentication now validates RS256 OIDC bearer JWTs in-process, fails closed when issuer/audience/JWKS configuration is absent, and maps verified `sub` claims to scoped actors; loopback-only bootstrap auth is separate.
- Provider adapters now use a pinned socket transport: the DNS-preflight address is passed directly to the connection while preserving the provider hostname for Host/SNI, with response and abort caps covered by tests.
- Built-in filesystem and shell tools now route through a sandbox runtime; production startup fails closed unless `BOT_BUFFET_SANDBOX_MODE=docker`, and Docker execution applies a read-only workspace, no network, dropped capabilities, `no-new-privileges`, resource limits, and a non-root user.
- Local model discovery now probes Ollama, LM Studio, llama.cpp, LocalAI, vLLM, and Jan loopback endpoints.
- Office bootstrap now supplies scoped files, memory, evaluation datasets, and registered tools to the table views; agent desks expose keyboard activation and accessible labels with regression coverage.

## Evidence

Run `npm run verify` for typecheck, tests, and build. Run `npm run audit`, `npm run security:scan`, and `npm run sbom` before release. The 54-test suite exercises redaction, path traversal, shell controls, endpoint SSRF/TLS checks, pinned provider egress, encrypted credential persistence and production key validation, random development vault-key persistence, context compaction/citations, audit integrity/CAS, locks, idempotency claims and API replay, offline/private routing, native Anthropic/Gemini/Cohere/Azure OpenAI/Bedrock adapter selection and wire/signature normalization, local runtime discovery coverage, tool contracts and timeout caps, API limits/auth, verified OIDC authentication, actor-bound OAuth PKCE start/callback state consumption, deterministic evaluation execution and unsupported-grader handling, project deletion, plugin lifecycle, checkpoint state recovery, sandbox runtime fail-closed/Docker argument controls, Office UI accessibility/data contracts, and signed backup/restore plus tamper rejection. The committed run at `fdbba0a` reports 60.68% statements, 50.53% branches, 61.98% functions, and 63.80% lines against 50% statement/line/function and 40% branch gates. Local smoke checks cover health/readiness, UI delivery, a completed run, bearer auth, provider credential redaction, scoped memory, plugin enablement, source intake, evaluation registration and execution, project export, and observability summary; real external provider and deployment evidence is not claimed.

The committed Codex Security standard scan `2a4ee2aa-d64e-4f14-aff2-557f320b9e21` reviewed the earlier committed scope at revision `36578cd` and produced one source-backed high finding: the development/local fallback still performs host filesystem operations without a kernel sandbox or descriptor-relative no-follow guarantee. Production now refuses that fallback, but Docker/microVM staging and escape evidence remain external. The provider working-tree diff was reviewed in scan `b19a1d6b-91c8-4ed2-8661-b635d175013b` against the pre-commit snapshot and produced zero reportable findings across provider selection, Cohere, Azure OpenAI, Bedrock/SigV4, credential validation, redaction, and model probes. CI action SHAs are immutable; signed OIDC provenance/attestation, backup encryption and external key custody, immutable retention, webhook delivery signing, real provider-account tests, staging deployment, and restore drills remain owner gates. Both security scans recorded that the TAC access advisory was unavailable because the security connector is not connected.

## External owner gates (not claimable locally)

1. Configure an identity provider and production secret store; owner must set least-privilege OAuth/API credentials.
2. Provision Postgres/D1, object storage, queue/workflow, vector index, TLS/domain, backups, alerts, and a staging environment.
3. Connect and run real integration tests for each online provider and optional Cloudflare/GitHub/Figma/Asana/Canva/SciSpace/Consensus/Wolfram connectors.
4. Perform staging deployment, restore drill, rollback drill, penetration testing, and production approval.

Each gate has exact actions in `docs/owner-gates.md`.

## Verification limitation

The local TypeScript, test, lint, audit, build, HTTP health/auth, UI delivery, run, audit-chain, and SBOM checks are rerun after each implementation commit. Production JWT validation is implemented, but real issuer configuration, tenant memberships, and provider accounts remain owner-supplied. Cohere, Azure OpenAI, and Bedrock have unit-level wire/signature coverage; the owner must still run real sandbox-account integration tests for each provider. Docker image build/runtime and container-escape verification are blocked by the local Docker daemon being unavailable (`dockerDesktopLinuxEngine` pipe not found). Owner action: start Docker Desktop or provide a staging container runner, pin and attest the sandbox image, run `docker build`, start with `BOT_BUFFET_AUTH_MODE=production` and `BOT_BUFFET_SANDBOX_MODE=docker`, call `/readyz`, execute a smoke run, inspect logs/mount/network policy, run the sandbox escape/TOCTOU suite, and perform rollback verification. These are explicit external gates, not completion claims.
