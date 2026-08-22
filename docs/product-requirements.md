# Product requirements

Samuel Abraham's Bot Buffet is a model-agnostic, user-controlled agent harness. The harness—not a provider—owns durable run state, context budgets, tool contracts, permissions, approvals, sandbox policy, verification, checkpoints, replay, and redacted observability.

The local profile supports multiple workspaces/projects, local model discovery, offline-only routing, typed filesystem tools, durable JSON state, an accessible Office UI, and portable backup/restore. Production profiles must replace the local adapters with a relational/object/queue/vector stack and an edge identity provider before exposure to multiple users.

Non-negotiable product properties are tenant isolation, no credentials in model context or logs, explicit approval for consequential actions, evidence-backed completion, resumability after process failure, and a visible emergency stop. Optional integrations remain disconnected-safe; the core control plane must continue when they are unavailable.

Acceptance evidence is maintained in `docs/status.md`. A green local test suite is necessary but does not substitute for the owner gates for OIDC, KMS, container isolation, staging deployment, real providers, restore, rollback, and penetration testing.
