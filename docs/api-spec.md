# API specification

The Node service exposes versioned JSON endpoints under `/api/v1`, `/healthz`, `/readyz`, and an SSE stream at `/events`. Every response carries `x-request-id`, `cache-control: no-store`, `x-content-type-options: nosniff`, and a structured `{ code, message }` error on request failure. Requests are capped at 2 MB and API callers are rate-limited per remote address.

Core resources include projects, providers, models, memory, plugins, MCP servers, files, sources, schedules, webhooks, evaluation datasets/cases, runs, approvals, audit, and observability. Projects can be archived or safely deleted after active runs are stopped; deletion revokes child credentials and preserves audit events. Run creation accepts an `Idempotency-Key`; the key is hashed and the 202 response is durably replayable for 24 hours. SSE requires a project scope in production, checks project authorization, caps subscribers, and emits heartbeats.

Schedules are created disabled and bind a bounded cron expression to a task in the same project. Webhooks are created disabled, require an HTTPS URL and a 32-byte secret, and persist only a fingerprint in the entity while encrypting the secret in the credential vault. Enable/disable operations require project write/admin authorization; delivery workers and signature verification remain deployment work.

Production currently accepts a configured bearer token and maps it to `BOT_BUFFET_API_SUBJECT`. This is a bootstrap principal only. The owner must put verified OIDC/SSO middleware in front of the service before treating the API as multi-user. The development `x-bot-buffet-user` header is ignored in production.

Mutating routes enforce resource kind, owner/workspace membership, role action, parent scope, version/CAS where transitions race, approval pending/expiry, and project/environment consistency. Provider endpoints require TLS and public DNS resolution unless the provider is explicitly local. See `docs/authentication.md`, `docs/tool-contracts.md`, and `docs/owner-gates.md` for deployment obligations.
