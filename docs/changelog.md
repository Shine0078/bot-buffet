# Changelog

## 0.1.0 — 2026-08-21

- Initial Bot Buffet control-plane baseline with durable local state, orchestrator, policy/sandbox controls, model routing, Office UI, tests, CI, container, SBOM, and operational docs.
- Security hardening pass: scope-aware authorization and parent checks, production principal isolation, private/offline model enforcement, mandatory high-risk approvals with CAS transitions, realpath/protected-path sandboxing, read-only shell policy, TLS/private endpoint checks, bounded API/SSE resources, and serialized audit mutations.
- Follow-up control-plane pass: durable run idempotency replay, model retry/backoff and time/token/cost limits, MCP server registry, disabled integrity-pinned plugin update/rollback/delete, security headers, typed Role/MCPServer entities, and product/API/plugin/incident/CI documentation.
- Control-plane lifecycle pass: serialized entity mutations, tool timeout enforcement, checkpoint-state fork/rollback, safe project deletion with credential revocation, and disabled schedule/webhook registries.
- Provider compatibility pass: native Anthropic Messages and Gemini generateContent adapters with normalized usage/tool-call responses and regression coverage.
- Runtime wiring pass: the service entrypoint now honors the provider adapter factory for online models.
- Credential hardening pass: development vaults now use random per-file keys, keep them out of backups, and verify reload behavior; the current security scan records only the remaining external sandbox gate.
- Identity hardening pass: production now validates RS256 OIDC bearer JWTs with JWKS rotation/cache, issuer/audience/time/nonce checks, and verified-subject actor mapping; the current security scan records only the remaining external sandbox gate.
- Egress hardening pass: provider adapters now connect to the address selected by DNS preflight through a pinned socket transport, eliminating the prior post-validation DNS rebinding finding and adding local transport tests.
- Sandbox hardening pass: built-in filesystem and shell tools now use a runtime abstraction; production refuses the host-process fallback and Docker mode applies a read-only workspace, blocked network, dropped capabilities, `no-new-privileges`, resource limits, and a non-root user. Docker/microVM staging and escape evidence remain release-owner gates.
- Local model discovery pass: loopback probes now cover all supported local OpenAI-compatible runtimes (Ollama, LM Studio, llama.cpp, LocalAI, vLLM, and Jan) with regression coverage.
