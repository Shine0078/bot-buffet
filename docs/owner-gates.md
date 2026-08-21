# External owner-gate checklist

- Identity owner: configure OIDC/SSO, claims-to-role mapping, MFA, session expiry, and emergency disablement.
- Platform owner: provision Postgres/D1, object storage, queue/workflow, vector index, TLS/DNS, WAF, metrics, and log retention.
- Provider owner: connect at least one local endpoint and one online account; run real adapter/auth/usage/error tests; set quotas and rotation reminders.
- Security owner: run SAST/dependency/secret scans, DAST, sandbox escape, SSRF/path/command/prompt-injection and cross-tenant tests; sign threat model.
- Release owner: deploy staging, perform restore and rollback drills, collect `/readyz` and smoke evidence, approve production.

Until each owner supplies evidence, the status ledger must say “blocked” for that gate; local implementation work must continue without inventing provider or deployment success.
