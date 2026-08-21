# Threat model

Assets include credentials, private prompts/files/memory, project code, provider quotas, approvals, and audit evidence. Trust boundaries are the browser/API, orchestrator, model providers, tools/sandbox, plugins, and storage.

Controls: scope-aware API filtering and parent authorization; RS256 OIDC bearer validation with issuer/audience/time/nonce checks; redaction at adapter, tool, API, and UI boundaries; offline/private routing with agent model/tool allowlists; lexical plus realpath confinement; protected files; read-only command allowlist and code-flag rejection; time/output/body/rate/SSE caps; no-new-privileges container; mandatory high/critical approval with expiry and compare-and-swap; serialized append-only hash-chain audit; no credentials in model context; and explicit untrusted-content labels in future research connectors. Residual risks are documented: provider endpoint DNS rebinding needs an async resolver/pinned egress proxy, and local process isolation is not a kernel sandbox.

Required pre-production exercises: path traversal, command injection, SSRF through provider/tool endpoints, prompt injection against tool descriptions, cross-tenant reads, webhook signature forgery, rate-limit exhaustion, credential leakage in errors, audit tampering, and sandbox escape. Record findings and remediation in the incident log.
