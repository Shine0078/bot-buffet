# Bot Buffet status ledger

Updated 2026-08-21. This is the source of truth for implementation evidence.

## Delivered locally

- TypeScript/Node build, durable JSON state, entity hierarchy, audit hash chain, locks, and atomic writes.
- Orchestrator loop: context assembly, routing, model call, typed tool validation, policy/approval gate, sandboxed execution, verification, checkpointing, pause/resume/stop/fork/rollback.
- Local mock model and OpenAI-compatible adapter; offline router guard and local discovery probes.
- Filesystem/shell tools with traversal, protected-path, metacharacter, timeout, output, and network controls.
- Office UI, responsive list/table alternative, SSE live events, health/readiness, and emergency stop.
- Unit/security/integration tests, CI, container, SBOM, and operations documents.
- Encrypted credential vault, provider test/revoke endpoints, scoped memory/plugin/file APIs.
- Budgeted context assembler with freshness/relevance ordering, compaction, redaction, and source-citation carry-through.
- Research source intake, evaluation dataset/case registration, run replay/export, and aggregated observability summary endpoints.
- Research foundation captured in `docs/research-foundation.md`, including inspected sources and explicit inaccessible-source owner actions.
- Portable backup/restore scripts verify SHA-256 manifests and restore into a separate target directory by default.
- Multi-agent coordination helpers provide structured handoff packets, evidence comparison, and bounded parallel execution.

## Evidence

Run `npm run verify` for typecheck, tests, and build. Run `npm run audit`, `npm run security:scan`, and `npm run sbom` before release. The 15-test suite exercises redaction, path traversal, shell controls, endpoint SSRF checks, encrypted credential persistence, context compaction/citations, audit integrity, locks, offline routing, tool contracts, and checkpoint completion. Live smoke checks also verified health/readiness, UI delivery, a completed run, production bearer auth, provider credential redaction, scoped memory, plugin enablement, source intake, evaluation registration, project export, and observability summary.

## External owner gates (not claimable locally)

1. Configure an identity provider and production secret store; owner must set least-privilege OAuth/API credentials.
2. Provision Postgres/D1, object storage, queue/workflow, vector index, TLS/domain, backups, alerts, and a staging environment.
3. Connect and run real integration tests for each online provider and optional Cloudflare/GitHub/Figma/Asana/Canva/SciSpace/Consensus/Wolfram connectors.
4. Perform staging deployment, restore drill, rollback drill, penetration testing, and production approval.

Each gate has exact actions in `docs/owner-gates.md`.

## Verification limitation

The local TypeScript, test, lint, audit, build, HTTP health/auth, UI delivery, run, audit-chain, and SBOM checks pass. Docker image build/runtime verification is currently blocked by the local Docker daemon being unavailable (`dockerDesktopLinuxEngine` pipe not found). Owner action: start Docker Desktop or provide a staging container runner, then run `docker build`, start the image, call `/readyz`, execute a smoke run, inspect logs, and perform rollback verification. This is an explicit external gate, not a completion claim.
