# Data model and persistence

`src/types.ts` contains typed entities for users, organizations, workspaces, projects, environments, agents, profiles, providers, models/routes, tools/plugins, policies/permissions, tasks/workflows, runs/steps, approvals, checkpoints, files/artifacts, memory/sources/citations, evaluations, usage/cost, alerts, schedules, webhooks, and audit events.

The local adapter persists a versioned JSON document with atomic temp-file replacement and a private file mode. `JsonStateStore` normalizes legacy documents through the current migration boundary and rejects future schema versions rather than guessing at their shape. The production migration must map each entity to a relational table keyed by tenant/workspace/project scope, add foreign-key constraints, append-only audit storage, encrypted secret references, and optimistic version checks. Artifacts and source bundles belong in object storage; vectors belong in a tenant-filtered index.

Backups must capture relational state, object manifests, and encryption-key metadata. Restore must run into an isolated environment, verify hashes, replay migrations, and execute smoke tests before promotion.
