# Provider adapter guide

`ModelAdapter` normalizes completion, health, model listing, usage, latency, tool calls, and structured output. `OpenAICompatibleAdapter` supports localhost servers and OpenAI-compatible gateways; add provider-specific adapters when semantics differ rather than silently dropping capabilities. Store only credential fingerprints and expiry/scopes in entities. Secrets must come from an OS keychain or external secret manager at runtime.

To add a provider: define capability detection, typed error mapping, health/list probes, auth test and revocation behavior, redaction tests, contract tests with a real sandbox account, and routing metadata. Update `docs/owner-gates.md` with the credential owner and expiry process.
