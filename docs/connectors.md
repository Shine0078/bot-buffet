# Connector guide

Bot Buffet ships a catalog of optional integrations. Nothing in the catalog is
connected, enabled, or reachable until an operator acts, and the harness runs
fully with none of them.

## What "optional" means here

It is a tested property, not a claim. `tests/connectors-api.test.ts` asserts
that a fresh instance reports every connector uninstalled, and that health,
readiness, projects, and bootstrap all answer with no connector installed at
all. Every catalog entry also has to state what the harness does without it,
and a connector whose absence would break a core path would fail that check.

## The catalog

| Connector  | Purpose                                                     | Auth        | Reaches                | Max risk |
| ---------- | ----------------------------------------------------------- | ----------- | ---------------------- | -------- |
| GitHub     | Repositories, branches, issues, pull requests, CI, releases | OAuth2 PKCE | `api.github.com`       | high     |
| Cloudflare | Hosting, queues, workflows, storage, deploy observability   | API key     | `api.cloudflare.com`   | critical |
| Figma      | Design tokens, components, accessibility annotations        | OAuth2 PKCE | `api.figma.com`        | safe     |
| Asana      | Task planning, milestones, approval routing                 | OAuth2 PKCE | `app.asana.com`        | medium   |
| Canva      | Brand assets, onboarding, reports, documentation visuals    | OAuth2 PKCE | `api.canva.com`        | low      |
| SciSpace   | Academic paper and PDF analysis                             | API key     | `api.scispace.com`     | safe     |
| Consensus  | Literature search and claim comparison                      | API key     | `api.consensus.app`    | safe     |
| Wolfram    | Mathematics, statistics, scientific validation              | API key     | `api.wolframalpha.com` | safe     |

Each entry also declares its data retention and its degraded behaviour; read
those in `GET /api/v1/connectors` before granting anything.

## Lifecycle

1. **List** — `GET /api/v1/connectors`. Static declaration plus installed state.
2. **Install** — `POST /api/v1/connectors/:id/install`. Requires workspace
   admin. Produces a **disabled** plugin, bound to no project or agent, with
   `network: allowlist` restricted to the connector's declared hosts. This
   grants no authority whatsoever; it records intent.
3. **Connect credentials** — through the provider/credential routes. Secrets go
   to the encrypted vault; only metadata and a fingerprint are stored on the
   record.
4. **Enable** — `POST /api/v1/plugins/:id/enable` with the current plugin
   `version`. This is the step that grants authority, is compare-and-swap
   protected, and is audited.
5. **Scope** — use `POST /api/v1/plugins/:id/assign` with a CAS `version` to
   bind the plugin to a workspace, project, or agent; use `/unassign` to remove
   the grant. `GET /api/v1/agents/:id/plugins` returns effective enabled plugins
   after workspace/project/agent checks and the agent profile's
   `allowedPluginIds` allowlist. A plugin assigned to a project or agent stays
   narrow when enabled; only an unassigned plugin receives the historical
   workspace-wide enable grant.

Install and enable are deliberately separate. It means an audit log can show
what authority was requested and when it was actually granted, and it means
reviewing a connector does not require granting it first.

## Rules enforced in code

`validateConnector` rejects a catalog entry that breaks any of these, and the
catalog is validated at load, so a malformed connector fails the build:

- **Explicit hosts.** Every connector declares bare hostnames, which become its
  egress allowlist. A host carrying a scheme, port, or path is rejected — it
  would widen the allowlist when compared against a request's hostname.
- **No open network.** `connectorPluginRecord` always produces
  `network: 'allowlist'`. There is no path from the catalog to `open`.
- **Scopes required.** Any connector that authenticates must declare the scopes
  it requests.
- **Retention and degraded behaviour required.** Both must be stated.
- **Tools bounded by declared risk.** No tool may exceed its connector's
  `maxRisk`.

## Scope verification

`scopesVerified` is true only where the scope strings were checked against the
provider's own documentation. Today that is GitHub alone: `repo` is the
narrowest documented scope that still permits private-repository pull requests,
and `read:org` is read-only and needed only for organization discovery.

Every other connector's scopes are marked unverified. They are plausible, not
confirmed, and a guessed scope string fails in one of two ways — it does not
connect, or it quietly grants more authority than intended. Confirm the exact
strings against current provider documentation before connecting; this is
recorded as an owner action in `docs/owner-gates.md`.

## What is not claimed

The catalog, the scoping, the lifecycle, and the isolation are implemented and
tested. **Live authentication and real API calls against these services are
not.** No connector has been exercised against a real account from this
repository, and no test here should be read as evidence that it has. Connecting
each service and running its integration tests is an owner gate.
