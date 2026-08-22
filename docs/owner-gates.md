# External owner-gate checklist

- Identity owner: configure OIDC/SSO, claims-to-role mapping, MFA, session expiry, and emergency disablement.
- Identity owner: provision the production OIDC issuer, audience, HTTPS JWKS URI, claims-to-role mapping, MFA/session policy, and tenant memberships. Signed-JWT cross-tenant denial evidence is now covered locally by `tests/auth-isolation.test.ts`; the real identity provider and membership provisioning remain external.
- Secrets owner: replace the `.env.example` master-key placeholder with at least 32 random bytes from KMS/secret storage; verify rotation and recovery without exporting plaintext credentials.
- Platform owner: provision Postgres/D1, object storage, queue/workflow, vector index, TLS/DNS, WAF, metrics, and log retention.
- Provider owner: connect at least one local endpoint and one online account; run real adapter/auth/usage/error tests for API keys, environment-variable references, PKCE, device authorization, OpenAI-compatible, Anthropic, Gemini, Cohere, Azure OpenAI, and Bedrock (including Azure deployment/API-version behavior and Bedrock SigV4/region/least-privilege credentials); set quotas and rotation reminders. The local suite covers wire normalization, signing, device-code handling, and non-persisted environment references, but does not claim real account success.
- Security owner: run SAST/dependency/secret scans, DAST, sandbox escape, SSRF/path/command/prompt-injection and cross-tenant tests; sign threat model.
- Security/platform owner: deploy a receiving webhook worker or queue, deliver every subscribed event to a live HTTPS endpoint, verify `v1,t=<unix>,s=<sha256>` signatures, reject stale/tampered/replayed payloads, exercise bounded retries and idempotency, and retain delivery/audit evidence without storing webhook secrets.
- Security owner: keep `BOT_BUFFET_SANDBOX_MODE=docker` (or an equivalent microVM runner) in every environment, validate the pinned provider socket transport with DNS-rebinding tests, and provide a kernel/container sandbox escape report. The host-process fallback has been removed because it cannot provide a portable ancestor no-follow guarantee.
- Release owner: configure CI OIDC signing/attestation and artifact registry policy, deploy staging, perform restore and rollback drills, collect `/readyz` and smoke evidence, approve production.

Until each owner supplies evidence, the status ledger must say “blocked” for that gate; local implementation work must continue without inventing provider or deployment success.

## Connector scope verification

Every connector except GitHub declares its OAuth or API scopes with
`scopesVerified: false` in `src/connectors.ts`. Those strings are plausible but
were not checked against the providers' current documentation, and a wrong
scope string fails in one of two ways: it does not connect, or it grants more
authority than intended without saying so.

Before connecting each service, confirm the exact scope strings against the
provider's current documentation, narrow them to the least privilege that still
supports the tools listed for that connector, update `src/connectors.ts`, and
set `scopesVerified: true` for that entry.

| Connector  | Declared scopes                | Documentation                                       |
| ---------- | ------------------------------ | --------------------------------------------------- |
| Cloudflare | `workers:read`, `workers:edit` | https://developers.cloudflare.com/api/              |
| Figma      | `file_read`                    | https://www.figma.com/developers/api                |
| Asana      | `tasks:read`, `tasks:write`    | https://developers.asana.com/docs                   |
| Canva      | `design:content:read`          | https://www.canva.dev/docs/connect/                 |
| SciSpace   | `papers:read`                  | https://typeset.io/                                 |
| Consensus  | `search:read`                  | https://consensus.app/                              |
| Wolfram    | `query:read`                   | https://products.wolframalpha.com/api/documentation |

GitHub's `repo` and `read:org` were checked against its documented scope list
and are marked verified.

Also required per connector, and not claimable from this repository: create the
account and credential, complete the OAuth or API-key flow, run a real
integration test for each tool the connector contributes, and confirm the
declared `allowedHosts` match the endpoints the provider actually serves.
