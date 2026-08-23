# External owner-gate checklist

- Identity owner: configure OIDC/SSO, claims-to-role mapping, MFA, session expiry, and emergency disablement.
- Identity owner: provision the production OIDC issuer, audience, HTTPS JWKS URI, claims-to-role mapping, MFA/session policy, and tenant memberships. Signed-JWT cross-tenant denial evidence is now covered locally by `tests/auth-isolation.test.ts`; the real identity provider and membership provisioning remain external.
- Secrets owner: replace the `.env.example` master-key placeholder with at least 32 random bytes from KMS/secret storage; verify rotation and recovery without exporting plaintext credentials.
- Platform owner: provision Postgres/D1, object storage, queue/workflow, vector index, TLS/DNS, WAF, metrics, and log retention.
- Provider owner: connect at least one local endpoint and one online account; run real adapter/auth/usage/error tests for API keys, environment-variable references, PKCE, device authorization, OpenAI-compatible, Anthropic, Gemini, Cohere, Azure OpenAI, and Bedrock (including Azure deployment/API-version behavior and Bedrock SigV4/region/least-privilege credentials); set quotas and rotation reminders. The local suite covers wire normalization, signing, device-code handling, and non-persisted environment references, but does not claim real account success.
- Security owner: run SAST/dependency/secret scans, DAST, sandbox escape, SSRF/path/command/prompt-injection and cross-tenant tests; sign threat model.
- Security/platform owner: deploy a receiving webhook worker or queue, deliver every subscribed event to a live HTTPS endpoint, verify `v1,t=<unix>,s=<sha256>` signatures, reject stale/tampered/replayed payloads, exercise bounded retries and idempotency, and retain delivery/audit evidence without storing webhook secrets.
- Security owner (**partially closed 2026-08-23**): `BOT_BUFFET_SANDBOX_MODE=docker` has now been exercised against a live Docker 29.5.3 engine, so the local child-process boundary is no longer the only evidence. Verified: non-root execution as uid 65532, unreachable network, read-only root filesystem (`EROFS`), `process.setuid(0)` refused with `EPERM`, no Docker socket inside the sandbox, no host mount root reachable, and symlink/TOCTOU containment with the race assumed already lost. See `tests/sandbox-docker.integration.test.ts` and the 2026-08-23 section of `docs/status.md`. **Still outstanding:** a kernel/container escape report from a security specialist, an equivalent microVM runner if preferred, DNS-rebinding of the pinned provider socket transport is now covered by tests/egress.test.ts, which proves the socket stays on the preflight address after a later lookup would have answered differently.

- **Platform owner — sandbox topology decision (new, blocks containerized production).** The shipped image contains neither the Docker CLI nor a daemon socket, so `BOT_BUFFET_SANDBOX_MODE=docker` cannot run from inside the container as built, while `assertSandboxConfiguration()` requires docker mode in production. A containerized production deployment therefore fails closed at startup. That is correct, and it needs an explicit choice:

  1. **Run the control plane directly on a host with a Docker daemon.** Simplest, and the topology verified on 2026-08-23. The control plane is then not itself containerized.
  2. **Mount the host daemon socket into the app container.** Only with eyes open: socket access is root-equivalent on the host, so anything that reaches it can start a privileged container and take the machine — and it would undo the isolation the sandbox exists to provide.
  3. **Point the app at a remote or rootless daemon over mutual TLS.** Keeps the control plane containerized and the daemon outside its trust boundary; requires provisioning the daemon, certificates, and rotation.
  4. **Replace the backend with a microVM runner** (Firecracker, Kata, or a managed sandbox service). Strongest isolation; requires implementing it behind the existing `SandboxRuntime` contract and producing fresh escape evidence.

  Until then, a containerized production process now fails closed with sandbox_topology_unavailable instead of a generic missing-docker error. Record the choice, then re-run the sandbox suite with `BOT_BUFFET_REQUIRE_DOCKER_TESTS=1` in the target environment, so the evidence reflects the deployed topology rather than a developer workstation.

- Release owner: configure CI OIDC signing/attestation and artifact registry policy, deploy staging, perform restore and rollback drills, collect `/readyz` and smoke evidence, approve production.

- **CI publication (closed 2026-08-23).** The workflow-scope problem that previously stopped `.github/workflows/ci.yml` reaching GitHub is resolved: the workflow is present on `origin/main` and runs format, lint, types, tests with coverage, dependency audit, secret scan, build, smoke, restore drill, provenance, SBOM, and a container job. `BOT_BUFFET_REQUIRE_DOCKER_TESTS=1` is set on the test step, so the container sandbox evidence is required rather than skipped. The container job now starts the image under the same hardening the sandbox evidence was gathered with and asserts non-root execution, a read-only root filesystem, a writable data volume, a valid audit chain, and durable state across a restart — previously it started the container unhardened and asserted only that `/readyz` answered, which a regression in the security posture would have passed. No owner action remains for CI publication itself; OIDC signing and attestation are still listed above.

Until each owner supplies evidence, the status ledger must say “blocked” for that gate; local implementation work must continue without inventing provider or deployment success.

## Connector scope verification

GitHub, Figma, Asana, and Canva OAuth scopes were checked against current provider documentation and are marked verified. Cloudflare, SciSpace, Consensus, and Wolfram still declare unverified API-key scope strings because those providers do not publish matching OAuth scope names.
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
