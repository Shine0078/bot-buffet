# External owner-gate checklist

- Identity owner: configure OIDC/SSO, claims-to-role mapping, MFA, session expiry, and emergency disablement.
- Identity owner: replace the single `BOT_BUFFET_API_SUBJECT` bearer bootstrap with verified OIDC/SSO middleware (issuer, audience, nonce, expiry, tenant claims) and provide cross-tenant denial evidence.
- Secrets owner: replace the `.env.example` master-key placeholder with at least 32 random bytes from KMS/secret storage; verify rotation and recovery without exporting plaintext credentials.
- Platform owner: provision Postgres/D1, object storage, queue/workflow, vector index, TLS/DNS, WAF, metrics, and log retention.
- Provider owner: connect at least one local endpoint and one online account; run real adapter/auth/usage/error tests; set quotas and rotation reminders.
- Security owner: run SAST/dependency/secret scans, DAST, sandbox escape, SSRF/path/command/prompt-injection and cross-tenant tests; sign threat model.
- Security owner: validate DNS-rebinding defenses through a pinned egress proxy or async resolver policy and provide a kernel/container sandbox escape report; the local child-process boundary is not sufficient evidence.
- Release owner: configure CI OIDC signing/attestation and artifact registry policy, deploy staging, perform restore and rollback drills, collect `/readyz` and smoke evidence, approve production.

Until each owner supplies evidence, the status ledger must say “blocked” for that gate; local implementation work must continue without inventing provider or deployment success.
