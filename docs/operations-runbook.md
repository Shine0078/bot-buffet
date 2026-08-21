# Operations runbook

Check `/healthz`, `/readyz`, provider health, queue depth (when provisioned), error groups, latency, cost, approval backlog, and audit-chain verification. For an incident: press global stop, preserve redacted traces/checkpoints, disable the affected credential/plugin, identify the last verified checkpoint, and communicate scope. Resume only after a reviewer records the decision.

Rollback: stop new runs, deploy the previous immutable image, restore the last verified data snapshot if required, run readiness and smoke tests, then re-enable traffic. Never delete evidence while investigating.
