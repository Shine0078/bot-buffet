# Bot Buffet status ledger

Updated 2026-08-21. This is the source of truth for implementation evidence.

## Delivered locally

- TypeScript/Node build, durable JSON state, entity hierarchy, audit hash chain, locks, and atomic writes.
- Orchestrator loop: context assembly, routing, model call, typed tool validation, policy/approval gate, sandboxed execution, verification, checkpointing, pause/resume/stop/fork/rollback.
- Local mock model and OpenAI-compatible adapter; offline router guard and local discovery probes.
- Filesystem/shell tools with lexical plus realpath confinement, allowlisted/protected descendants, metacharacter and code-execution-flag rejection, read-only command policy, timeout, output, and network controls.
- Office UI, responsive list/table alternative, SSE live events, health/readiness, and emergency stop.
- Unit/security/integration tests, CI, container, SBOM, and operations documents.
- Encrypted credential vault, provider test/revoke endpoints, authorization-filtered memory/plugin/file APIs, parent-scope checks, approval expiry/CAS, request limits, correlation IDs, and bounded SSE.
- Budgeted context assembler with freshness/relevance ordering, compaction, redaction, and source-citation carry-through.
- Research source intake, evaluation dataset/case registration, run replay/export, and aggregated observability summary endpoints.
- Research foundation captured in `docs/research-foundation.md`, including inspected sources and explicit inaccessible-source owner actions.
- Portable backup/restore scripts verify SHA-256 manifests, optionally sign them with HMAC-SHA-256, and restore into a separate target directory by default.
- Development credential vaults generate a random 32-byte key beside the encrypted record instead of deriving key material from the username; the key is intentionally excluded from backups.
- Multi-agent coordination helpers provide structured handoff packets, evidence comparison, and bounded parallel execution.
- Durable idempotency replay, run time/token/cost guards with model retry backoff, MCP server metadata, integrity-pinned disabled plugin lifecycle operations, security headers, and API/plugin regression coverage.
- Safe project deletion with child credential revocation, disabled schedule bindings, and HTTPS/secret-protected webhook metadata routes.
- CI now pins third-party action SHAs and emits an unsigned commit/artifact provenance manifest; signed OIDC attestation remains a release-owner gate.
- Anthropic and Gemini now use native provider adapters instead of being routed through the OpenAI-compatible wire format.
- The production entrypoint now uses the same provider adapter factory as the API/control-plane registry, so native adapter selection is effective at runtime.
- Production authentication now validates RS256 OIDC bearer JWTs in-process, fails closed when issuer/audience/JWKS configuration is absent, and maps verified `sub` claims to scoped actors; loopback-only bootstrap auth is separate.
- Provider adapters now use a pinned socket transport: the DNS-preflight address is passed directly to the connection while preserving the provider hostname for Host/SNI, with response and abort caps covered by tests.
- Built-in filesystem and shell tools now route through a sandbox runtime; production startup fails closed unless `BOT_BUFFET_SANDBOX_MODE=docker`, and Docker execution applies a read-only workspace, no network, dropped capabilities, `no-new-privileges`, resource limits, and a non-root user.
- Local model discovery now probes Ollama, LM Studio, llama.cpp, LocalAI, vLLM, and Jan loopback endpoints.
- Office bootstrap now supplies scoped files, memory, evaluation datasets, and registered tools to the table views; agent desks expose keyboard activation and accessible labels with regression coverage.

## Evidence

Run `npm run verify` for typecheck, tests, and build. Run `npm run audit`, `npm run security:scan`, and `npm run sbom` before release. The 40-test suite exercises redaction, path traversal, shell controls, endpoint SSRF/TLS checks, pinned provider egress, encrypted credential persistence and production key validation, random development vault-key persistence, context compaction/citations, audit integrity/CAS, locks, idempotency claims and API replay, offline/private routing, native provider adapter selection, local runtime discovery coverage, tool contracts and timeout caps, API limits/auth, verified OIDC authentication, project deletion, plugin lifecycle, checkpoint state recovery, sandbox runtime fail-closed/Docker argument controls, and Office UI accessibility/data contracts. CI coverage is now a non-interactive V8 gate with 50% minimum statements/lines/functions and 40% branches; the current run is 55.86% statements, 58.62% lines, 55.41% functions, and 46.40% branches. Local smoke checks cover health/readiness, UI delivery, a completed run, bearer auth, provider credential redaction, scoped memory, plugin enablement, source intake, evaluation registration, project export, and observability summary; external provider and deployment evidence is not claimed.

The committed Codex Security standard scan `ab23b54a-a07a-496a-a8a8-f9c9f04bbe0a` reviewed 78 inventoried files at revision `200cc02` and produced one source-backed high finding: the development/local fallback still performs host filesystem operations without a kernel sandbox or descriptor-relative no-follow guarantee. Production now refuses that fallback, but Docker/microVM staging and escape evidence remain external. CI action SHAs are immutable; signed OIDC provenance/attestation, backup encryption and external key custody, immutable retention, webhook delivery signing, and restore drills remain owner gates.

## External owner gates (not claimable locally)

1. Configure an identity provider and production secret store; owner must set least-privilege OAuth/API credentials.
2. Provision Postgres/D1, object storage, queue/workflow, vector index, TLS/domain, backups, alerts, and a staging environment.
3. Connect and run real integration tests for each online provider and optional Cloudflare/GitHub/Figma/Asana/Canva/SciSpace/Consensus/Wolfram connectors.
4. Perform staging deployment, restore drill, rollback drill, penetration testing, and production approval.

Each gate has exact actions in `docs/owner-gates.md`.

## Verification limitation

The local TypeScript, test, lint, audit, build, HTTP health/auth, UI delivery, run, audit-chain, and SBOM checks are rerun after each implementation commit. Production JWT validation is implemented, but real issuer configuration, tenant memberships, and provider accounts remain owner-supplied. Docker image build/runtime and container-escape verification are blocked by the local Docker daemon being unavailable (`dockerDesktopLinuxEngine` pipe not found). Owner action: start Docker Desktop or provide a staging container runner, pin and attest the sandbox image, run `docker build`, start with `BOT_BUFFET_AUTH_MODE=production` and `BOT_BUFFET_SANDBOX_MODE=docker`, call `/readyz`, execute a smoke run, inspect logs/mount/network policy, run the sandbox escape/TOCTOU suite, and perform rollback verification. These are explicit external gates, not completion claims.
