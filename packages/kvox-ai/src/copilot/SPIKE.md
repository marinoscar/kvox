# SDK spike: `@github/copilot-sdk` 1.0.22 (issue #630)

Findings for sign-in, the runtime binary, its checksum source, the hosts it contacts and telemetry. Written to be merged into `README.md`.

Method: `npm pack` / `npm i @github/copilot-sdk@1.0.22` (runtime `copilotCliVersion` 1.0.98) into an empty directory, read the `.d.ts`, the compiled JS and the runtime's `schemas/api.schema.json`, and drove the REAL runtime (`@github/copilot-sdk-linux-x64`) on Linux x64 with `mode: 'empty'`, `useLoggedInUser: true` and a fresh `baseDirectory`. Each statement is marked **verified** (observed against the real runtime), **read** (stated by the SDK's code, types or schema, not exercised) or **inferred** (not seen directly). Not done: Windows and macOS (everything about them is **read** from the platform-selection code), and a complete sign-in (no GitHub account was signed in; the final steps of the flow are **read** only).

## 1. Sign-in and sign-out API (experimental)

- The client has only `getAuthStatus()` (**verified**: `{ isAuthenticated: false, statusMessage }` when signed out). There is NO client-level interactive sign-in.
- Interactive sign-in is a **session-scoped, `@experimental`** RPC group: `session.rpc.accounts.login.begin({ kind })`, `.advance({ flowId, input? })`, `.cancel({ flowId })`. A session can be created with no model and no auth (**verified**), so a sign-in opens a short-lived, zero-tool session, uses it, and deletes it.
- Provider kinds offered (**verified**, `session.rpc.accounts.enumerate({ query: { kind: 'providers' } })`): `githubDotCom` ("GitHub.com", available), `proxima` ("GitHub Enterprise Cloud (*.ghe.com)", available, needs a host typed in), `entra` (not available without a broker). KVox uses `githubDotCom` only.
- The flow for `githubDotCom` is a **browser** authorization, not a device-code flow (**verified**): `begin` returns `{ flowId, step: { kind: 'open-url', url } }` where `url` is `https://github.com/login/oauth/authorize?client_id=...&redirect_uri=http://127.0.0.1:<port>/callback&scope=...&state=...&code_challenge=...&code_challenge_method=S256` (OAuth code with PKCE; the runtime opens a loopback listener). The host opens the URL; the runtime receives the redirect itself and exchanges the code, so no token reaches the SDK caller (**read**: the step types carry no token field).
- `advance({ flowId })` BLOCKS until the next step (**verified**: still pending after 3 s). Steps (**read**, `AuthLoginStep`): `open-url`, `input-required`, `awaiting`, `needs-interaction`, `completed { result: { status, host?, login?, accounts? } }`, `error { message }`. `result.status`: `completed`, `needs-plaintext-consent`, `needs-account-selection`, `declined`. The last three are answered by `advance` with the user's decision as `input` (the exact format of a plaintext-consent decision is **not documented**; KVox does not give one).
- `cancel({ flowId })` while an `advance` is pending makes that `advance` reject with `... GenericFailure, Login cancelled` at once (**verified**). Advancing a cancelled flow rejects `Unknown or completed login flow` (**verified**).
- Sign-out: `session.rpc.accounts.set({ command: { kind: 'logout' } })` logs out the ACTIVE account and returns `{ ok, moreUsers }` (**verified** on a signed-out runtime: `{ ok: true, moreUsers: false }`). The client-level `rpc.account.logout({})` is refused without an account selection (**verified**: `Missing required account selection`), so it is not used. The client-level `rpc.account.login({ host, token })` takes a GitHub token and is deliberately NOT used: a token would cross KVox code.
- Implemented in `createSdkCopilotTransport` as `startSignIn` / `waitForSignIn(signal?)` / `signOut`. The transport returns only `{ kind: 'browser', url }` (https on `github.com` only; anything else is refused), the whitelisted `CopilotAuthStatus`, or a typed `AiError`.
- The wait has its own expiry (`signInTimeoutMs`, default 10 minutes): the SDK documents no expiry of the loopback flow, so the transport cancels the flow itself and rejects as `sign_in_expired`.
- Verified end to end with the real runtime and the compiled transport: `getAuthStatus` -> not authenticated; `startSignIn` -> `browser` challenge on `github.com`; abort -> `sign_in_cancelled`; timeout -> `sign_in_expired`; `waitForSignIn` without a flow -> `sign_in_not_started`; `signOut` ok; no session left in `session-state/`.

### Risks found (unverified, need a real account)

1. **Plaintext consent.** `mode: 'empty'` sets `COPILOT_DISABLE_KEYTAR=1` (**read**, `client.js` `buildRuntimeEnv`), so the runtime may not use the OS keychain, and the SDK documents `needs-plaintext-consent` ("Persistence needs explicit consent to store the token in plaintext"). If a completed sign-in answers that, KVox rejects it with `sign_in_needs_plaintext_consent` and cancels the flow. If that is what real sign-ins return, sign-in cannot complete in `empty` mode and the client options need a decision from the owner (allow the file store in the app-private `baseDirectory`, or leave `mode: 'empty'`). THIS IS THE ONE THING TO TRY FIRST WITH A REAL ACCOUNT.
2. **Broad OAuth scopes.** The authorize URL asks for `read:user read:org repo gist codespace write:plugin_gateway_connections` (**verified**), far more than Copilot inference needs. The runtime owns the scopes; the consent screen will show them to the user. Worth telling the user (Q12, terms).
3. **Ambient credentials.** `useLoggedInUser: true` also picks up the GitHub CLI login (`gh auth`) and token environment variables (**verified** in part: on an unauthenticated runtime `account.getCurrentAuth` tried "GitHub CLI user login" and called GitHub; `authType` can be `user | env | gh-cli | hmac | api-key | token`). A user who is signed in to `gh` appears signed in to KVox without ever signing in, and `signOut` cannot remove a `gh` or environment credential (it only logs out the runtime's own accounts). `authStatus()` after `signOut()` is the truth. A follow-up could strip `GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN` through the client's `env` option; not done here.
4. After a completed sign-in the transport reports `isAuthenticated: true` from the flow's own `completed` result and enriches it from `getAuthStatus()`. Whether the already-started runtime's `getAuthStatus()` reflects a fresh login at once was not observed.

## 2. Runtime binary location

- The SDK downloads nothing (**read**, README: "starting the SDK performs no runtime download"). The runtime ships as an npm **optional dependency** of the SDK, one package per platform: `@github/copilot-sdk-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,linuxmusl-arm64,linuxmusl-x64,win32-arm64,win32-x64}`, same version as the SDK (**verified**: `npm install` pulled `@github/copilot-sdk-linux-x64`, 154 MB on disk).
- Resolution (**read**, `runtimeArtifacts.js` `ensureRuntimeBundle`): `getRuntimePlatform()` (glibc vs musl detected from `process.report`), then `require.resolve.paths('@github/copilot-sdk-<platform>')`, then `<package>/prebuilds/<platform>/copilot-runtime[.exe]` plus `runtime.node` beside it. Verified layout on linux-x64: `copilot-runtime` (519,888 bytes, the launcher) and `runtime.node` (136,594,544 bytes), plus `builtin/`, `schemas/`, `ripgrep/`, ... in the package root. The launcher is made executable if it is not.
- Override (**read**): the connection `path` (`RuntimeConnection.forStdio({ path })`) or the `COPILOT_CLI_PATH` environment variable of the runtime process wins over the bundled package. The runtime runs as a child process over stdio by default.
- `baseDirectory` sets `COPILOT_HOME` for the child (**read**; **verified** that `session-state/` and `installed-plugins/` appear in it). Default `~/.copilot`.
- Consequence for `prepareCopilotRuntime`: "bundled" means the host ships the platform package (asar-unpacked) and passes the launcher path; "download" means fetching the platform package tarball, not a file the SDK fetches.

## 3. Checksum source

- The SDK has no runtime checksum check at run time: `validateFile` only tests that the files exist and are non-empty (**read**).
- Integrity data that exists and can be pinned:
  - the npm registry's `dist.integrity` (sha512 of the tarball) of each platform package at 1.0.22 (**verified** with `npm view`):

| platform | sha512 (base64) of the tarball |
|---|---|
| darwin-arm64 | `qmCCCrPXZzspZgKEitQ5HGlVGHd5kxZPlNUk7AfFcPmhvhfF4p8ROoH2OER5fGMsQwIiuAfz2XyXqkUVCupWKw==` |
| darwin-x64 | `oh0LlHEVTcC6r6rzxEhNPhUgoFRvnP85x4HwF5tEkzldegw6qVYCpB4zwgcy47o51ML4jHlP/jkzq5SOC2z89A==` |
| linux-arm64 | `E1MLsrO6bXTTqXFb+IZwdkSm3W1j7KOoGvX3aZdIrMPpjLneMeokZNec4716AYwdeWDF1t+mLYWU1ipfkRkhxA==` |
| linux-x64 | `9O0RBsP8Eyf5TOp99ISWDjWQwlUbgMSzdvGii4l6LazmWesukglwxLGBmPEVXa8wEpug+LDGifzeJ74+663YsA==` |
| linuxmusl-arm64 | `wG79J/hMtj1i5xyntIp/vmyAzt7u4BVQQnUaCxnPlWxexmwiuZ5zYwlqrEqIEhl+uXirz90RmOPg3IxiDLfJIA==` |
| linuxmusl-x64 | `aV4Rw/NN+VABR7+Wq9+S22SvyHeJqANejjiiHLJPSxsdpQz7rK+HUkUNLjISiFmBCB4XqZMUwLUbTpsvMLAgHw==` |
| win32-arm64 | `3fqjYt0LUofLpQoIqEeWukA/WnmwbqsyYjqimaKw+onVealtLXCdXwqMy5vcT0raY/f4D3+glvjWFchR5qZq7w==` |
| win32-x64 | `yUapm2AapONBj+ty3A/+C5ZjDcGi72CgAggeoEqmD6oQqUnA8+A71fR8avmCV7Rhmwwzb1mh2AZd9wAjrHuwig==` |

  - sha256 of the extracted linux-x64 files (**verified**, for a table keyed by file): `copilot-runtime` `7ee92b5694b6356da1d426e1c0b6afd51cb848493659a3c5abb8a1f80b896959`, `runtime.node` `247651acd33b17d2a8d051c9d422561b9d67c301957382693708d62c3ae6c6ef`.
  - the SDK's own build downloads `github-copilot-<version>-<platform>.tgz` from `github/copilot-cli` at tag `v<runtime-version>` and checks it against a checksum file at that release (**read**, SDK README; not fetched). There is no manifest inside the SDK package to read at run time, so "the SDK's release manifest" of the issue does not exist as a file: the pinnable sources are the npm integrity values above (or the `github/copilot-cli` release checksums), pinned per SDK version in KVox.

## 4. Hosts contacted

Only what the Linux x64 runtime was seen doing, plus static strings in `runtime.node`; nothing was captured on the wire, so the list is **inferred** except where marked.

| host | why | basis |
|---|---|---|
| `github.com` | OAuth authorize page; token exchange (`/login/oauth/...`) | authorize URL **verified**; exchange **inferred** |
| `api.github.com` | the signed-in user, Copilot token and entitlement lookups, runtime release lookups (`/repos/github/copilot-cli/releases/...`) | **verified** that the runtime called GitHub for the `gh` login; the rest **inferred** from strings |
| `api.githubcopilot.com` | model listing and inference | **inferred** (string); needs a signed-in account to exercise |
| `127.0.0.1:<random>` | the OAuth redirect listener | **verified** in the authorize URL |

Also present as static strings, not expected to be contacted by KVox's zero-tool use: `api.mcp.github.com`, `agentfinder.github.com`, `*.ghe.com` (Enterprise Cloud sign-in), `login.microsoftonline.com` and several Microsoft 365 hosts (Entra sign-in), `api.openai.com` / `api.anthropic.com` (bring-your-own-model providers), `vscode.dev`, `aka.ms`, `gh.io`, `docs.github.com`. An allowlist of `github.com`, `api.github.com`, `api.githubcopilot.com` is the starting point; the exact set must be confirmed with a proxy capture on a signed-in machine, and GitHub may add hosts in later runtime releases.

## 5. Telemetry

- SDK-level OpenTelemetry is opt-in and OFF by default: it is turned on only by passing `telemetry` to the client (**read**, `buildRuntimeEnv`: `COPILOT_OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`). KVox passes none. `onGitHubTelemetry` (events the runtime forwards to the host) is also opt-in and unset.
- The runtime itself contains a GitHub product-telemetry service (`telemetry_service.rs`, many `telemetry` strings, **read**) and an engagement id (`session.telemetry.getEngagementId`). The SDK exposes **no documented switch** to turn it off (searched types, schema and runtime strings; **not verified** whether any environment variable does). `clientInfo` only changes attribution. So SDK telemetry cannot be switched off from KVox; the control that works is the egress allowlist (a host not on the list cannot receive telemetry), and the user-facing statement must not claim "no telemetry" for Copilot.
- `logLevel: 'none'` (already set) stops the runtime's own log output; in `mode: 'empty'` the runtime's process file logging is not enabled (**read**).
