# Deployment guide

Local: `npm ci && npm run verify && npm run dev`. Staging: build the pinned container, provision a private data volume/database, configure OIDC and secret references, run migrations, `/readyz`, smoke tests, accessibility checks, provider connection tests, and a sandbox escape suite. Production requires an explicit approval gate, TLS/domain, WAF/rate limits, metrics/log export, backup schedule, restore drill, and rollback image.

The Docker image runs as an unprivileged user with a read-only root filesystem, dropped capabilities, no-new-privileges, and a healthcheck. The current JSON store is a local/dev adapter; do not present it as multi-replica production persistence.
