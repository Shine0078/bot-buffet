# Adversarial review: Munder Difflin

Reviewed 2026-08-22 against `C:\Users\samue\Downloads\munder-difflin-main\munder-difflin-main`.

This is a read-only review. Nothing in that directory was modified. Findings are
recorded with the file and line they came from so each one can be re-checked.

## 0. Scope caveat, read this first

**The reviewed directory is not a clean Munder Difflin checkout.** It contains a
Bot Buffet Git repository, and several of Munder Difflin's root files have been
overwritten by Bot Buffet's versions.

Evidence:

| Check                | Result                                                  |
| -------------------- | ------------------------------------------------------- |
| `git rev-parse HEAD` | `1207958…`, identical to `Documents/GitHub/Bot Buffet`  |
| `git remote -v`      | `https://github.com/Shine0078/bot-buffet.git`           |
| Root commit          | `8c6fb19 Build Bot Buffet agent control plane baseline` |
| Commit count         | 112, all Bot Buffet                                     |
| `git ls-files`       | 114 files, all Bot Buffet                               |
| Munder Difflin files | present but **untracked** (69 untracked entries)        |

The overwritten root files are `package.json`, `README.md`, `tsconfig.json`,
`tsconfig.build.json`, `.gitignore`, `.prettierrc.json`, `eslint.config.js`,
`vitest.config.ts`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`,
`.env.example`, and `.github/workflows/ci.yml`. `src/` is a merged tree: Munder
Difflin's `main/`, `preload/`, `renderer/`, and `shared/` subdirectories sit
alongside Bot Buffet's flat modules. `node_modules/` is Bot Buffet's install
(130 entries, no `electron`, `node-pty`, or `better-sqlite3`).

The most likely cause is that an earlier session ran `git init` and built Bot
Buffet inside the extracted download folder, then the result was copied to
`Documents/GitHub/Bot Buffet`. Because `munder-difflin-main` is the standard
GitHub zip-extract name, the original almost certainly shipped without a `.git`
directory, so no upstream history was destroyed — but the working files listed
above were.

**Owner action:** re-download Munder Difflin into a fresh directory before doing
any further work with it. Do not run `git clean` in the current one; that would
delete the surviving Munder Difflin source, which is untracked.

What this means for the review: Munder Difflin's own `package.json`, dependency
manifest, lockfile, README, and CI workflow are unavailable, so **dependency
audit, install-script review from the manifest, and CI review are out of
scope** — they cannot be performed against files that are no longer on disk.
Everything below is drawn from files that survived. That gap is recorded rather
than guessed at.

## 1. What Munder Difflin is

An Electron desktop application (`appId: in.munderdiffl.app`, v0.4.4, © Chaitanya
Giri) that runs a local "hive" of coding-agent CLIs — Claude Code, Codex, Grok,
Antigravity, Copilot — coordinated by an orchestrator persona. Roughly 57k lines
of TypeScript across `src/main` (47 modules), `src/preload`, `src/renderer`, and
`src/shared`, plus an Eleventy blog, a Remotion landing site, and packaging for
macOS, Windows, and Linux.

Architecturally it is the opposite bet from Bot Buffet: a local-first desktop app
that delegates to installed agent CLIs, rather than a server-side control plane
that owns the agent loop itself.

## 2. Security review

### 2.1 Strong, and worth copying

**Electron process isolation is correct.** `src/main/index.ts:2121-2133` sets
`contextIsolation: true` and `nodeIntegration: false`. The preload
(`src/preload/index.ts`, 1370 lines) exposes an explicit, individually typed API
rather than a blanket `invoke(channel, …)` bridge, so the renderer cannot reach
arbitrary IPC channels.

**Secrets are encrypted at rest and fail closed.** `src/main/integrations.ts:111`
refuses to write a secret when `safeStorage.isEncryptionAvailable()` is false,
rather than degrading to plaintext.

**Secrets are write-only across the IPC boundary.** `src/preload/index.ts:24`
documents the contract, and the renderer type is
`Omit<IntegrationRecord,'secretRef'> & { hasSecret: boolean }` — a secret value
is never returned to the renderer, only its presence.

**Content-Security-Policy is real.** `src/renderer/index.html:6` sets
`default-src 'self'; script-src 'self'` with no `unsafe-inline` on scripts, and a
narrow `connect-src` allowlist.

**Permissions are gated to a live feature, not granted once.**
`src/main/index.ts:2163-2173` implements both `setPermissionRequestHandler` and
`setPermissionCheckHandler`, and allows `media` only while a microphone feature
is actually on.

**The integration broker is not an open proxy.** `src/main/integrationBroker.ts:172-200`
layers five checks in order: loopback-only caller, capability token, path shape,
per-worker integration allowlist, record-still-enabled — then confines the
upstream URL beneath the integration's own origin. This is a good SSRF posture.

**The webhook surface is labelled as public and treated accordingly.**
`src/main/webhook.ts:18` marks it explicitly as tunnel-forwarded and unlike the
loopback broker, with a secret gate, schema validation, and rate limiting.

### 2.2 Findings

**F1 — `setWindowOpenHandler` opens any scheme (medium).**
`src/main/index.ts:2196-2199` calls `shell.openExternal(url)` with no validation
at all. The application's own IPC handler at `src/main/index.ts:3699-3703`
validates correctly, restricting to `https:` and `x-apple.systempreferences:`,
and its comment states the intent: "so the renderer can't shell arbitrary
schemes." The window-open path bypasses that intent entirely. Since the renderer
displays agent-generated content, a link produced by a compromised or
prompt-injected agent reaches `openExternal` unfiltered. **Fix:** apply the same
allowlist in both paths.

**F2 — `sandbox: false` (low, accepted trade-off).**
`src/main/index.ts:2123`. Required because the preload needs Node for `node-pty`.
Mitigated by `contextIsolation` and the CSP, but it removes a defence layer.

**F3 — Agents run with permission checks disabled (informational, by design).**
`src/main/index.ts:2686` spawns Claude with `--permission-mode bypassPermissions`,
and `:2734` grants OpenCode `edit`, `bash`, and `webfetch` when auto-mode is on.
This is a deliberate product decision — an unattended hive cannot stop for
prompts — but it means the agent's blast radius is the user's whole filesystem
with no harness-side gate. Bot Buffet takes the opposite position and should keep
doing so.

**F4 — `shell: true` with a variable command (low).**
`src/main/pty.ts:420` and `src/main/shellEnv.ts:81` run
`spawnSync('where', [command], { shell: true })`. `pty.ts:410` returns early if
`command` contains a separator, but nothing filters `&`, `|`, or `^`. The values
are internal today, so this is a latent hazard rather than a live bug.

**F5 — Installer scripts elevate (informational).**
`src/main/nodeInstall.ts:200-224` emits `sudo installer -pkg`, `sudo tar -xJf`,
and `msiexec /i`. This is unavoidable for a real Node install and is handled
about as carefully as it can be — see §3 — but it is the highest-privilege thing
the application does.

## 3. Installation process — studied in detail

This is the strongest part of the codebase and the source of most of what was
worth carrying over.

### 3.1 The install ladder

`src/main/cliInstall.ts:36-44` classifies the machine **before** running
anything:

| Machine state                       | Rung            | Action                            |
| ----------------------------------- | --------------- | --------------------------------- |
| npm present and new enough          | `npm`           | `npm install -g …`                |
| npm absent, Node installer resolved | `node-then-npm` | install Node, then the CLI        |
| npm absent, vendor installer exists | `native`        | vendor's self-contained installer |
| neither                             | `manual`        | print instructions, run nothing   |

The rationale is recorded in the source: the previous version printed and ran an
npm command regardless, so a user without Node watched `npm: command not found`
scroll past and concluded the app was broken. The rule that came out of it —
never run a command that cannot succeed; say what is missing instead — is the
single most transferable idea in the project.

### 3.2 Checksum verification, fail-closed

`src/main/nodeInstall.ts:230-262` resolves the installer by fetching
`index.json`, picking the latest LTS, deriving the artifact name, then fetching
`SHASUMS256.txt` and looking the digest up there. Three details matter:

- The digest comes from the distribution's signed checksum file, not from the
  index that named the artifact.
- `if (!sha256) return null;` — no digest means no install. The comment is
  explicit: "we would be running an unverified installer as root. Refuse."
- Every fetch carries `AbortSignal.timeout(6000)` because the resolver runs
  inside a spawn and must not hang the launch.

The emitted script verifies before installing and aborts on any failure, using
the tool each platform actually ships: `certutil` + `findstr` on Windows,
`shasum -a 256 -c` on macOS, `sha256sum -c` on Linux.

### 3.3 Testability

`cliInstall.ts` imports nothing from Electron, and both it and
`buildNodeInstallScript` take `platform` as a parameter. The Windows branch is
therefore reachable from a test on any host. This is why the module can be
trusted at all: the riskiest code in the application is the code most easily
exercised.

### 3.4 Injection discipline

`src/main/cliInstall.ts:59` sanitises the one user-derived value — the missing
binary name — to `[A-Za-z0-9._-]`, and the comment states the invariant plainly:
the install commands themselves are trusted constants. The Unix branch
single-quotes all echo text and avoids `!` so history expansion cannot fire.

### 3.5 Windows quoting

`nodeInstall.ts:178-195` and `cliInstall.ts:74-76` document that the Windows
script is wrapped verbatim in `cmd /d /s /c "<script>"`, so it must contain no
double quotes and escapes literal ampersands as `^&`. `RELEASE.md` records the
underlying defect in detail: `cmd.exe` treats CR/LF as a statement separator
before quoting is considered, so a multi-line argument was silently truncated at
its first newline. The fix decodes the npm shim to its interpreter and spawns
with an argv array. This is a genuinely hard-won piece of Windows knowledge.

## 4. Packaging and deployment

`electron-builder.yml` is thorough: macOS hardened runtime with inherited
entitlements so spawned agents share one TCC grant, per-usage privacy strings,
native modules kept out of the asar, `npmRebuild` for `node-pty`, NSIS and
portable Windows targets, and an AppImage for Linux.

The best idea there is at lines 88-101: electron-builder's built-in notarisation
is **disabled** and replaced with a root-level `afterSign` hook that notarises
best-effort. The reason is recorded — the built-in path runs inside `signApp`
where a try/catch cannot guard it, so one bad Apple credential hard-failed the
entire cross-platform release. The replacement ships a signed but un-notarised
build instead of sinking the release.

Not reviewable: CI workflows and the release pipeline, for the reason in §0.

## 5. Practices adopted into Bot Buffet

| #   | Practice                                                                           | Source               | Applied as                                                          |
| --- | ---------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| 1   | Classify the machine before acting; never run a doomed command                     | `cliInstall.ts:36`   | `scripts/preflight.mjs`                                             |
| 2   | Separate blockers from warnings so an optional tool is not a failed install        | `cliInstall.ts:29`   | `evaluateEnvironment`                                               |
| 3   | Keep install decisions pure and platform-parameterised so every branch is testable | `cliInstall.ts:8`    | `tests/preflight.test.ts`                                           |
| 4   | Refuse an artifact with no digest rather than warning                              | `nodeInstall.ts:250` | `planModelImport`                                                   |
| 5   | Verify against a digest published separately from the artifact listing             | `nodeInstall.ts:246` | `verifyArtifact`                                                    |
| 6   | Bound every external probe with a timeout                                          | `nodeInstall.ts:227` | preflight probes, 5s                                                |
| 7   | Enforce a Node floor rather than trusting `engines`                                | `nodeInstall.ts:45`  | preflight blocker                                                   |
| 8   | Sanitise the one user-derived value; keep commands constant                        | `cliInstall.ts:59`   | documented at the shim call site                                    |
| 9   | Record why an unsafe-looking construct is safe, at the call site                   | throughout           | preflight `probe`                                                   |
| 10  | Publish checksums in a format standard tools can verify                            | `release.yml:80`     | `SHA256SUMS.txt` from `npm run provenance`                          |
| 11  | Verify the manifest you generate, in the same run                                  | gap found here       | `npm run provenance:verify`, wired into CI                          |
| 12  | Keep the CSP strict; use the dependency's CSP-safe build instead of relaxing it    | `OfficeFloor.tsx:4`  | Bot Buffet UI already ships `script-src 'self'`                     |
| 13  | Let optional secrets degrade to a working build, so forks stay green               | `release.yml:70`     | Bot Buffet CI needs no secrets; SARIF upload is `continue-on-error` |
| 14  | Scope a workflow trigger so its own commit cannot re-trigger it                    | `blog.yml:12`        | Noted; Bot Buffet CI makes no commits                               |

Practice 11 is not something upstream does — it is the gap its release pipeline
made visible. Upstream publishes checksums a downloader can verify; Bot Buffet
was writing a provenance manifest that nothing verified. Comparing the two is
what surfaced it.

## 6. Deliberately not adopted

- **`shell: true` as a general habit.** Bot Buffet uses it in exactly one place,
  for Windows `.cmd` shims, with constants only, and says so at the call site.
- **Unvalidated `openExternal`.** Both paths must share one allowlist (F1).
- **Bypassing permission checks for agents.** Bot Buffet's premise is that the
  harness decides; adopting F3 would negate it.
- **Elevation from a generated script.** Bot Buffet installs nothing globally
  and needs no `sudo` or `msiexec` path.
- **Committed scratch directories.** The reviewed tree carries `.data`,
  `.data-a11y`, `.data-auth`, `.data-creds`, `.data-observe`, `.data-prod`, and
  `.data-smoke` at its root — though given §0, those are Bot Buffet's own
  leftovers, not Munder Difflin's.

## 7. CI/CD and release pipeline

Four upstream workflows survive: `release.yml`, `blog.yml`, `wall-sync.yml`,
and `contributor-role.yml`. The release pipeline is the substantial one and is
well built.

**Cross-platform matrix with `fail-fast: false`,** so one platform's failure
does not cancel the others — sensible when each runner produces an independent
installer.

**A documented toolchain fix.** `node-gyp` (rebuilding native `node-pty`)
imports `distutils`, removed in Python 3.12, so the workflow pins Python 3.11
and installs `setuptools`. The reason is written in the file rather than left
as a mystery pin.

**OS-gated signing secrets.** `CSC_LINK` and the Apple credentials are set only
on the macOS runner via `${{ matrix.os == 'macos-latest' && secrets.X || '' }}`.
The comment records the failure that motivated it: if the Apple certificate
reaches the Windows or Linux runners, electron-builder tries to sign those
targets with it and the build hard-fails. This is the kind of detail that only
gets written down after it has cost someone a release.

**Secrets are optional and degrade to a working build.** With none set, every
runner builds unsigned and stays green, so a fork can build the product. The
analytics key is injected only for official builds; forks compile with an empty
value and analytics no-op.

**Published checksums.** Each runner emits `SHA256SUMS-<os>.txt` over the
distributable artifacts only — not the blockmaps or `latest*.yml` — and the
publish job merges them into one `SHA256SUMS.txt` attached to the release.

**Pre-release semantics tied to the tag.** A tag with a suffix
(`v0.4.4-rc.1`) publishes as a pre-release. The comment explains why this is
"load-bearing, not cosmetic": the in-app updater polls `/releases/latest`, which
excludes pre-releases, so a release candidate gets a public, shareable download
page without offering itself to every installed copy. That is a genuinely
thoughtful use of a platform behaviour.

`blog.yml` scopes its trigger to `blog/**` so the commit it makes under
`docs/blog` cannot re-trigger it — a small but real infinite-loop guard.
`contributor-role.yml` declares `permissions: contents: read` at the workflow
level, narrowing the default token.

## 8. Renderer UI and accessibility

121 TypeScript/TSX files under `src/renderer`.

**No unsafe HTML sink.** There is no `dangerouslySetInnerHTML`, no `eval`, and
the single `new Function` reference is a comment explaining its absence.

**The CSP was kept strict rather than relaxed.** PixiJS uses `new Function()`
internally, which `script-src 'self'` blocks. Rather than adding
`unsafe-eval` to the policy, the renderer imports `pixi.js/unsafe-eval` — the
vendor's CSP-compatible build, which replaces that code path. The import name
reads like a weakening and is the opposite: the policy stays strict and the
dependency adapts. This is the correct resolution and worth naming, because the
tempting fix is one line in the CSP.

**Accessibility is thin.** Only 19 of 121 renderer files carry any `aria-` or
`role` attribute. For a canvas-rendered office floor that is expected in the
scene layer, but it means the interface leans on the visual representation.
Bot Buffet's own requirement for an accessible list/table alternative to the
Office floor is the right response to the same problem, and is not something to
copy from here.

## 9. Testing surface

38 test files under `test/`, of which 31 use `node:test` — the platform test
runner, no framework dependency. The remainder are self-contained scripts
declaring "no test framework" in their header.

Coverage is concentrated where the hard problems are: `cli-install-ladder`,
`hive-runtime-path`, `hive-roster-injection`, `expand-tilde`, `breaker`, and
`commit-graph`. That matches the install-ladder design in §3 — the riskiest
logic is the most heavily tested, and it is testable because it was kept free of
Electron imports.

## 10. What this review could not establish

Recorded rather than guessed:

Three gaps recorded in the first pass are now closed in §7, §8, and §9 above:
the CI and release pipeline, the renderer UI and accessibility posture, and the
testing surface. What remains genuinely unestablished:

- **Dependency audit and lockfile review.** Still impossible. `package.json`
  and the lockfile were overwritten (§0), and `node_modules/.package-lock.json`
  contains Bot Buffet's install rather than the upstream one — checked, not
  assumed. No dependency claim is made anywhere in this review.
- **Runtime behaviour.** The application was never launched. Nothing here rests
  on observed execution; every finding is from source, configuration, or
  documentation.
- **Accessibility beyond the static signal.** §8 counts `aria`/`role` usage; it
  is not an audit. No screen-reader or keyboard-navigation testing was done.
