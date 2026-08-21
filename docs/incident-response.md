# Incident response

1. Record the request ID, run ID, project, actor, provider, and approximate time without copying secrets or private prompts.
2. Invoke `POST /api/v1/stop-all`, disable affected provider credentials, and preserve the redacted audit/export evidence.
3. If a workspace or credential boundary is suspected, revoke all credentials for that scope, rotate the master/KMS key according to the owner runbook, and block external provider egress.
4. Verify the audit chain, compare the last known-good checkpoint, and quarantine suspicious artifacts or memory. Do not overwrite the only copy of state.
5. Restore into an isolated target, run permission, sandbox, golden-task, and provider smoke tests, then promote through the staging approval gate. Roll back traffic to the last verified image if health, error, or evaluation thresholds fail.

The incident record must include root cause, affected scopes, containment time, evidence locations, owner actions, and a regression test or policy change that prevents recurrence. External OIDC, KMS, WAF, container, and provider actions are owned by the deployment/security owners in `docs/owner-gates.md`.
