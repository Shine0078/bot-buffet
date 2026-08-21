# Bot Buffet status ledger

Updated 2026-08-21. This is the source of truth for implementation evidence.

## Delivered locally

- TypeScript/Node build, durable JSON state, entity hierarchy, audit hash chain, locks, and atomic writes.
- Orchestrator loop: context assembly, routing, model call, typed tool validation, policy/approval gate, sandboxed execution, verification, checkpointing, pause/resume/stop/fork/rollback.
- Local mock model and OpenAI-compatible adapter; offline router guard and local discovery probes.
- Filesystem/shell tools with traversal, protected-path, metacharacter, timeout, output, and network controls.
- Office UI, responsive list/table alternative, SSE live events, health/readiness, and emergency stop.
- Unit/security/integration tests, CI, container, SBOM, and operations documents.

## Evidence

Run `npm run verify` for typecheck, tests, and build. Run `npm run audit` and `npm run sbom` before release. The test suite exercises redaction, path traversal, shell controls, audit persistence/integrity, locks, offline routing, tool contracts, and checkpoint completion.

## External owner gates (not claimable locally)

1. Configure an identity provider and production secret store; owner must set least-privilege OAuth/API credentials.
2. Provision Postgres/D1, object storage, queue/workflow, vector index, TLS/domain, backups, alerts, and a staging environment.
3. Connect and run real integration tests for each online provider and optional Cloudflare/GitHub/Figma/Asana/Canva/SciSpace/Consensus/Wolfram connectors.
4. Perform staging deployment, restore drill, rollback drill, penetration testing, and production approval.

Each gate has exact actions in `docs/owner-gates.md`.

## Verification limitation

The local TypeScript, test, lint, audit, build, HTTP health/auth, UI delivery, run, audit-chain, and SBOM checks pass. Docker image build/runtime verification is currently blocked by the local Docker daemon being unavailable (`dockerDesktopLinuxEngine` pipe not found). Owner action: start Docker Desktop or provide a staging container runner, then run `docker build`, start the image, call `/readyz`, execute a smoke run, inspect logs, and perform rollback verification. This is an explicit external gate, not a completion claim.
