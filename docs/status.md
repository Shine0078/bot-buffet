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

## Evidence

Run `npm run verify` for typecheck, tests, and build. Run `npm run audit`, `npm run security:scan`, and `npm run sbom` before release. The 28-test suite exercises redaction, path traversal, shell controls, endpoint SSRF/TLS checks, encrypted credential persistence and production key validation, context compaction/citations, audit integrity/CAS, locks, idempotency claims and API replay, offline/private routing, native provider adapter selection, tool contracts and timeout caps, API limits/auth, project deletion, plugin lifecycle, and checkpoint state recovery. Local smoke checks cover health/readiness, UI delivery, a completed run, bearer auth, provider credential redaction, scoped memory, plugin enablement, source intake, evaluation registration, project export, and observability summary; external provider and deployment evidence is not claimed.

The committed Codex Security standard scan `ec1af528-b689-4ed0-ab7c-84257e1c7ffa` reviewed 73 inventoried files at revision `26f6328` and produced three source-backed high findings. The report is complete; the remaining findings are the documented OIDC principal, DNS-pinned egress, and kernel sandbox. CI action SHAs are immutable; signed OIDC provenance/attestation, backup encryption and external key custody, immutable retention, webhook delivery signing, and restore drills remain owner gates.

## External owner gates (not claimable locally)

1. Configure an identity provider and production secret store; owner must set least-privilege OAuth/API credentials.
2. Provision Postgres/D1, object storage, queue/workflow, vector index, TLS/domain, backups, alerts, and a staging environment.
3. Connect and run real integration tests for each online provider and optional Cloudflare/GitHub/Figma/Asana/Canva/SciSpace/Consensus/Wolfram connectors.
4. Perform staging deployment, restore drill, rollback drill, penetration testing, and production approval.

Each gate has exact actions in `docs/owner-gates.md`.

## Verification limitation

The local TypeScript, test, lint, audit, build, HTTP health/auth, UI delivery, run, audit-chain, and SBOM checks are rerun after each implementation commit. Direct production identity remains a static bearer subject until the owner supplies OIDC/SSO claim validation; Docker image build/runtime verification is blocked by the local Docker daemon being unavailable (`dockerDesktopLinuxEngine` pipe not found). Owner action: start Docker Desktop or provide a staging container runner, then run `docker build`, start the image, call `/readyz`, execute a smoke run, inspect logs, and perform rollback verification. These are explicit external gates, not completion claims.
