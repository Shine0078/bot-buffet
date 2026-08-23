# Deployment guide

Local: `npm ci && npm run verify && npm run dev`. Staging: build the pinned container, provision a private data volume/database, configure OIDC and secret references, run migrations, `/readyz`, smoke tests, accessibility checks, provider connection tests, and a sandbox escape suite. Production requires an explicit approval gate, TLS/domain, WAF/rate limits, metrics/log export, backup schedule, restore drill, and rollback image.

The Docker image runs as an unprivileged user with a read-only root filesystem, dropped capabilities, no-new-privileges, and a healthcheck. The current JSON store is a local/dev adapter; do not present it as multi-replica production persistence.

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

## Compose deployment

`docker compose up --build` is verified working from a clean clone.

Two defects were fixed to get there. `env_file: [.env]` was required, so compose
failed outright for anyone who had not created a gitignored file — including
`docker compose config`. And the service did not set `BOT_BUFFET_HOST`, so the
process bound loopback inside the container and the published port could never
reach it.

The compose service carries the same posture the sandbox evidence was gathered
under — read-only root, `tmpfs /tmp`, all capabilities dropped,
`no-new-privileges`, and pids/memory/cpu limits — so compose and the verified
`docker run` invocation cannot drift apart. Verified on this machine: ready in
one second, uid 100, read-only root enforced, data volume writable, healthcheck
reporting `healthy`, and a clean `down --volumes`.

## Startup failures

A misconfigured deployment fails closed and now explains itself. Instead of a
Node stack trace, the operator sees the problem, a concrete remedy, and the
error code:

```
Bot Buffet could not start.

  Problem: Production requires the container sandbox, but BOT_BUFFET_SANDBOX_MODE
           is not set to "docker".

  To fix:
    Set BOT_BUFFET_SANDBOX_MODE=docker and give the process a reachable Docker daemon.
    Note: the shipped image contains no Docker CLI or socket, so docker mode cannot run
    from inside the container as built. See the sandbox topology decision in
    docs/owner-gates.md for the four supported deployment shapes.

  Error code: sandbox_runtime_required
```

An error the harness does not recognise is re-thrown untouched rather than
wrapped in a friendlier but less accurate message.
