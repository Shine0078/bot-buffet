# Bot Buffet

Bot Buffet is a model-agnostic agent control plane: the harness owns state, tools, permissions, approvals, isolation, verification, routing, and recovery while models remain replaceable.

## Quick start

Requires Node.js 20+.

```sh
npm ci
npm run verify
npm run dev
```

Open <http://127.0.0.1:8787>. The first run creates a local workspace, a project, a supervised local agent, and an offline-safe mock model. State is stored atomically in `.data/state.json` (mode `0600`). Set `BOT_BUFFET_OFFLINE=true` to make the router reject all cloud models.

## What is implemented

- Typed control/data/execution-plane entities and scoped relationships.
- Durable state, checkpoints, resumable run control, locks, fork/rollback, and tamper-evident audit chain.
- Model registry and routing with local-first/offline enforcement plus OpenAI-compatible adapters.
- Encrypted local credential vault with fingerprints-only metadata, provider health testing, and revocation.
- Typed tool registry with schemas, policy decisions, path confinement, protected paths, command controls, output caps, and redaction.
- Scoped memory, plugin lifecycle, credential, and file registry API surfaces.
- Supervised orchestrator loop with approvals, deterministic evidence checks, usage/cost counters, retries-by-resume, and SSE events.
- Accessible responsive Office UI with a list/table alternative, reduced-motion mode, keyboard focus, and global stop.
- Health/readiness APIs, Docker hardening, CI checks, SBOM generation, and operational documentation.

Production deployments should replace the JSON adapter with the Postgres/D1 adapter described in `docs/data-model.md`, configure an external identity provider, and complete the owner gates in `docs/owner-gates.md`. No external credentials or provider accounts are bundled.

## API

`GET /healthz`, `GET /readyz`, `GET /events`, and versioned `/api/v1` endpoints for projects, providers, models, runs, approvals, audit verification, and emergency stop are available. Every response is redacted before leaving the process.

## Security posture

Run as an unprivileged user, keep `.data` private, inject credentials only into adapters, and do not enable `open` network mode without a reviewed policy. See `docs/threat-model.md` and `docs/sandbox-security.md`.
