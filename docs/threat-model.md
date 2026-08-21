# Threat model

Assets include credentials, private prompts/files/memory, project code, provider quotas, approvals, and audit evidence. Trust boundaries are the browser/API, orchestrator, model providers, tools/sandbox, plugins, and storage.

Controls: tenant/project scopes on every entity; redaction at adapter, tool, API, and UI boundaries; offline routing; path confinement; protected files; command allowlist/metacharacter rejection; time/output caps; no-new-privileges container; approval gates for high/critical actions; append-only hash-chain audit; no credentials in model context; and explicit untrusted-content labels in future research connectors.

Required pre-production exercises: path traversal, command injection, SSRF through provider/tool endpoints, prompt injection against tool descriptions, cross-tenant reads, webhook signature forgery, rate-limit exhaustion, credential leakage in errors, audit tampering, and sandbox escape. Record findings and remediation in the incident log.
