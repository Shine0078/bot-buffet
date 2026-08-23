# Backup and restore

Local state is the `.data/state.json` file and encrypted credentials are `.data/credentials.enc.json`; use `npm run backup -- ./backup-2026-08-21` while the service is stopped. The development vault key is `.data/credentials.enc.json.key`; it is random, deliberately excluded from backups, and must be supplied separately when restoring encrypted credentials. If `BOT_BUFFET_BACKUP_KEY` (or the master key) is present, the backup also writes `manifest.mac`, an HMAC-SHA-256 signature over the exact manifest bytes. `npm run restore -- ./backup-2026-08-21` verifies both file hashes and that signature; production requires a key and signed manifest. Production backups must also be encrypted, versioned, retention-limited, and tested. Restore to a new project/tenant, provision the vault key or production KMS binding before starting the service, verify object and audit hashes, run migrations, verify `/readyz`, execute a golden task and permission tests, then promote by changing traffic—not by overwriting the only copy.

## Rollback drill

`npm run restore:drill` proves that _data_ survives destruction. It says nothing
about what happens when a _release_ is bad, which is a different failure and the
one a rollback procedure exists for.

`npm run rollback:drill` covers that. It injects a realistic bad release — a
production deploy with no sandbox runtime configured, which exercises the
harness's real fail-closed path rather than an artificial crash — and asserts
the three things a rollback has to answer:

| Question                 | Assertion                                                      |
| ------------------------ | -------------------------------------------------------------- |
| Is the failure detected? | The bad release never becomes ready and exits non-zero         |
| Is it diagnosable?       | The failure prints an actionable message, not a stack trace    |
| Can service be restored? | Readiness returns after rolling back to the known-good release |
| Is state intact?         | Project count is unchanged, and the audit chain still verifies |

Verified against a live Docker engine: all ten checks pass. The drill skips with
a clear message when no daemon is reachable, and fails rather than skipping when
`BOT_BUFFET_REQUIRE_DOCKER_TESTS=1` is set, which CI sets.

### What it does not prove

It rolls back a container on one host. It does not exercise a staged rollout, a
load balancer draining connections, a database migration being reversed, or
multi-replica coordination. Those belong to the deployment gate in
`docs/owner-gates.md` and are not claimed here.
