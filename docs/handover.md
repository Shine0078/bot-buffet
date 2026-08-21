# Handover

Run `npm ci && npm run verify` before changing behavior. Keep the repository buildable, add a regression test for each bug, update `docs/status.md`, and never stage unrelated files. Complete owner gates before calling a deployment production-ready. The safe emergency action is `POST /api/v1/stop-all` followed by credential disablement at the secret manager.
