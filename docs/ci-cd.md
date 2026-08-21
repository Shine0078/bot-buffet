# CI/CD and release gates

The checked-in workflow runs formatting, type checking, tests, lint, dependency audit, secret scan, build, an unsigned artifact provenance manifest, SBOM generation, SARIF upload, container build, readiness smoke check, and container logs on failure. `npm run verify` is the local equivalent of the type/test/build gate; `npm run provenance` writes `provenance.json` with the commit and SHA-256 digests for the build artifacts.

Release promotion additionally requires migration validation, browser/accessibility and evaluation regression suites, signed provenance/attestation, staging deployment, real provider authentication tests, restore and rollback drills, and a human production approval. Third-party actions are pinned to immutable commit SHAs; periodically verify those SHAs against reviewed upstream releases.

Automatic rollback is traffic-level: stop the failing deployment, route to the last verified image, disable affected credentials, and re-run `/readyz`, golden-task, permission, audit, and provider smoke checks before reopening promotion.
