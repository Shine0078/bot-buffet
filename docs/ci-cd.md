# CI/CD and release gates

The checked-in workflow runs formatting, type checking, tests, lint, dependency audit, secret scan, build, SBOM generation, SARIF upload, container build, readiness smoke check, and container logs on failure. `npm run verify` is the local equivalent of the type/test/build gate.

Release promotion additionally requires migration validation, browser/accessibility and evaluation regression suites, provenance/attestation, staging deployment, real provider authentication tests, restore and rollback drills, and a human production approval. Third-party actions should be pinned to immutable commit SHAs as an owner-managed supply-chain hardening task; the current workflow uses major-version tags and this remains a documented low finding.

Automatic rollback is traffic-level: stop the failing deployment, route to the last verified image, disable affected credentials, and re-run `/readyz`, golden-task, permission, audit, and provider smoke checks before reopening promotion.
