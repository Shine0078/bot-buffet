# Deployment guide

Local: `npm ci && npm run verify && npm run dev`. Staging: build the pinned container, provision a private data volume/database, configure OIDC and secret references, run migrations, `/readyz`, smoke tests, accessibility checks, provider connection tests, and a sandbox escape suite. Production requires an explicit approval gate, TLS/domain, WAF/rate limits, metrics/log export, backup schedule, restore drill, and rollback image.

The Docker image runs as an unprivileged user with a read-only root filesystem, dropped capabilities, no-new-privileges, and a healthcheck. The current JSON store is a local/dev adapter; do not present it as multi-replica production persistence.

The image binds `0.0.0.0` because the port is published by Docker and defaults to
`BOT_BUFFET_AUTH_MODE=production`. Compose explicitly overrides any `.env`
development value. Supply the production OIDC issuer, audience, and HTTPS JWKS
configuration before starting; the server refuses a production image or any
non-loopback bind in development/bootstrap mode. Local smoke and restore checks
set an explicit loopback development environment.

## Image pinning

Both the runtime image's base layers and the agent sandbox image are pinned by
digest rather than by tag.

A tag is a mutable pointer. `node:22-alpine` resolves to different bytes week to
week, so an unpinned build means the runtime that ships — and, for the sandbox,
the environment that contains agent-generated code — can change without a single
line of this repository changing. Pinning makes a rebuild reproducible and makes
any upstream change a visible commit rather than an invisible one.

- `Dockerfile` pins both stages by digest; the readable tag is kept in a comment
  directly above each `FROM`.
- `BOT_BUFFET_SANDBOX_IMAGE` must be digest-pinned in production. Startup fails
  closed with `sandbox_image_required` or `sandbox_image_not_pinned`; see
  `docs/sandbox-security.md`.

Re-pin deliberately when updating a base image:

```sh
docker buildx imagetools inspect node:22-alpine --format '{{.Manifest.Digest}}'
```

Do not automate the re-pin. A pin that updates itself is not a pin — it only
adds the appearance of one.
