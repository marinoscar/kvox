# copilot

`@marinoscar/kvox-ai/copilot`: the GitHub Copilot provider adapter, so KVox Desktop can run its AI features on the user's own Copilot subscription through `createDirectRuntime`.

## Purpose and scope

`createCopilotAdapter({ optIn, transport, logger?, catalog? })` returns an `AiProviderAdapter` (`id: 'copilot'`, `displayName: 'GitHub Copilot'`) with a `responses` port, plus `kvox` (what kvox-ai reads: `toolCalling: false`, `embeddings: false`, and a `KvoxModelCatalog`-shaped `catalog`) and `authStatus()`. It is a translator and nothing more: one `responses.create` or `responses.stream` call is ONE Copilot session with ONE user message, deleted when the call settles. It holds no prompt text, no retry loop, no tool loop and no KVox rule.

- **Request.** The system prompt is `instructions` then any `system`/`developer` messages, joined by a blank line, and it REPLACES the SDK's own (`systemMessage.mode: 'replace'`). The user prompt is the `input` string, or the text of exactly one `user` message. Tools, `previousResponseId`, assistant or tool items, reasoning items, more than one user message and image or file parts are refused with `AI_CAPABILITY_UNSUPPORTED` before a session is created. `maxOutputTokens` and `temperature` are not sent (the SDK has no per-call setting for either on Copilot-hosted models); `providerOptions` is ignored. Effort `minimal` is sent as `low`.
- **Structured output.** For a `native` model (`copilotStructuredOutputMode`: the catalog's mode, else `native` for `gpt-*`/`o<n>*`, else `prompted`) the schema is sent as `responseSchema` and the answer is parsed and validated with the platform's `parseStructured` (`AI_STRUCTURED_OUTPUT_INVALID` with `details.issues`). A `length` or `content_filter` finish is returned as such, unparsed, so kvox-ai reports `truncated` or a refusal. A structured request for a `prompted` model is refused: kvox-ai never sends one, because for those models it takes its own prompted path (the schema in the prompt, one repair; see the `structured` slice).
- **Events.** `assistant.message_delta` becomes `output_text.delta`; `assistant.usage` gives the usage (`cacheReadTokens` as `cachedInputTokens`) and the finish reason; `session.idle` ends the turn with `output_item.done` and `response.completed`. `model.call_failure` and `session.error` become an `AiError` (`copilot-errors.ts`).
- **Suppressions** of SDK behaviour (not policy): the runtime's `<current_datetime>` prompt prefix (an `onUserPromptTransformed` hook hands the prompt back as written), its "please continue" turn after `length` (the session is aborted at once), and its own retries after a `model.call_failure` (aborted; kvox-ai owns retries).
- **Zero tools, enforced.** `availableTools: []`, client `mode: 'empty'`, every permission request rejected, skills, custom instructions, embedding retrieval, config discovery, the session store, extensions, canvases and MCP apps off. After `createSession` the adapter reads the session's live tool list; any tool there, or a tool event during the call (`external_tool.requested`, `permission.requested`, `tool.execution_start`, an assistant message with tool requests), aborts the call with `AI_CAPABILITY_UNSUPPORTED`.
- **Sign-in.** Every call first asks `getAuthStatus()`; not signed in is `AI_KEY_REQUIRED` ("Sign in to GitHub Copilot to use it in KVox."). `verifyKey` answers the same question without throwing; `listModels` drops models whose policy is `disabled`. Signing in and out is [below](#sign-in-and-sign-out).

`createSdkCopilotTransport({ baseDirectory, workingDirectory, logLevel? })` is the real transport: on its first call it `require`s `@github/copilot-sdk` and builds one `CopilotClient` (`mode: 'empty'`, `useLoggedInUser: true`, `logLevel: 'none'` by default). `createCopilotMockTransport()` is a transport for tests (asynchronous SDK-shaped events, abort, model-request counting, the datetime hook, live tools for the tripwire). `redactTokens`, `copilotErrorFromData` and `copilotErrorFromThrown` are the error half; `COPILOT_CATALOG` (version `COPILOT_CATALOG_VERSION`) is a small fallback list whose numbers the live listing overrides.

Status: implemented by issue #581 (the adapter) and issue #630 (sign-in and sign-out, `prepareCopilotRuntime`, `COPILOT_EGRESS_HOSTS`, and `routeKvoxTasks` in the package root), published on the `next` dist-tag. Ask is not offered on Copilot: `toolCalling` is `false`. Opt-in only: `createCopilotAdapter` throws unless `optIn === true`; the host passes the user's own opt-in setting, which defaults to OFF. The SDK findings behind sign-in, the runtime, the egress hosts and telemetry, each marked verified, read or inferred, are in [SPIKE.md](SPIKE.md). Not yet done: a complete sign-in against a real GitHub account, and a wire capture of the hosts the runtime contacts.

### Sign-in and sign-out

The Copilot runtime runs the sign-in; no token reaches KVox code. The SDK's account RPCs are experimental and live on a SESSION, so the real transport opens a short-lived, zero-tool session for each sign-in or sign-out and deletes it afterwards. Check them when you bump the SDK.

```ts
const challenge = await copilot.signIn.start();             // what the user must do
if (challenge.kind === 'browser') openExternal(challenge.url);
else showCode(challenge.userCode, challenge.verificationUri, challenge.expiresAt);
const { login } = await copilot.signIn.wait(abort.signal);  // resolves once the user has finished
await copilot.signOut();                                    // later
```

- `signIn.start()` returns a `CopilotSignInChallenge`. A second `start()` replaces a flow still in progress. It throws an `AiError` when the runtime cannot start one (including an authorize address that is not `https` on `github.com`, which is never handed out).
- `signIn.wait(signal?)` resolves to `{ signedIn: true, login }` (`login` is `null` when the runtime reports none; never a token). Aborting `signal` cancels the runtime's flow and rejects as `sign_in_cancelled`. The wait expires after `signInTimeoutMs` (a `createSdkCopilotTransport` option, default 10 minutes, because the SDK documents no expiry of its loopback flow) and rejects as `sign_in_expired`.
- `signOut()` logs out the runtime's stored accounts and resolves also when nobody was signed in. It removes only what the runtime stored: see the ambient-credentials risk below, and read `authStatus()` afterwards for the truth.

**Challenge kinds.** `{ kind: 'browser', url }`: open the address; the runtime receives the OAuth redirect itself (authorization code with PKCE, a loopback listener on `127.0.0.1`). `{ kind: 'device', userCode, verificationUri, expiresAt }`: the user types the code on the page. `browser` is the only kind the real transport returns: it is the only flow SDK 1.0.22 offers. `device` is part of the type so a host that handles both keeps working if a later runtime switches flows. A host switches on `kind` and never assumes one.

**`signInReason`.** A sign-in that does not end signed in rejects with `AiError` `AI_KEY_REQUIRED` and `details.signInReason` (`CopilotSignInFailureReason`). Switch on it, not on the text. The strings are permanent.

| `signInReason` | Meaning |
|---|---|
| `sign_in_expired` | The wait ran past `signInTimeoutMs`; the flow was cancelled. |
| `sign_in_cancelled` | `signal` aborted, or the runtime reported the flow cancelled. |
| `sign_in_failed` | The flow ended without a signed-in account (also a `declined` outcome). |
| `sign_in_not_started` | `wait` was called with no flow in progress. |
| `sign_in_needs_plaintext_consent` | The runtime would only keep the token in a plain file and asked for consent. KVox never agrees on the user's behalf; the flow is cancelled. |
| `sign_in_needs_account_selection` | The runtime asked which account to use and there was not exactly one. With exactly one, the transport picks it. |
| `sign_in_needs_input` | The runtime asked for input KVox cannot give. |

A runtime `error` step maps like any other failure (`copilot-errors.ts`) and carries no `signInReason`.

**Risks (from the spike; the first and third could not be settled without a real account).**

1. Plaintext consent. `mode: 'empty'` sets `COPILOT_DISABLE_KEYTAR=1` (read from the SDK), so the runtime may not use the OS keychain and may answer `needs-plaintext-consent`. If real sign-ins do, sign-in cannot complete in `empty` mode and the client options need an owner decision (allow the file store in the app-private `baseDirectory`, or leave `mode: 'empty'`). Try this first with a real account.
2. Broad OAuth scopes. The authorize URL asks for `read:user read:org repo gist codespace write:plugin_gateway_connections` (verified), far more than Copilot inference needs. The runtime owns the scopes and the consent screen shows them, so tell the user before they sign in.
3. Ambient credentials. `useLoggedInUser: true` also picks up a GitHub CLI login (`gh auth`) and token environment variables (`GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`). A user signed in to `gh` appears signed in to KVox without signing in, and `signOut()` cannot remove such a credential. The transport does not strip those variables (a follow-up could, through the client's `env` option).

### The runtime

`@github/copilot-sdk` drives a per-platform runtime of about 133 to 174 MB. The SDK downloads nothing: the runtime ships as the optional npm dependency `@github/copilot-sdk-<platform>` (eight platforms), whose `prebuilds/<platform>/` holds a small launcher (`copilot-runtime`, `copilot-runtime.exe` on Windows) beside a large `runtime.node`; the launcher needs its sibling. The SDK ships no checksum or release manifest for it (SPIKE.md section 3).

`prepareCopilotRuntime(options)` creates Copilot's private directories, resolves the runtime and returns `{ runtimePath, baseDirectory, workingDirectory, version, source, verified }`.

```ts
const rt = await prepareCopilotRuntime({
  dataDirectory: join(app.getPath('userData'), 'copilot'),
  bundledRuntimePath: join(process.resourcesPath, 'copilot', 'copilot-runtime'),
});
const transport = createSdkCopilotTransport({ baseDirectory: rt.baseDirectory, workingDirectory: rt.workingDirectory });
```

The runtime is found in this order: `bundledRuntimePath`, then `download`, then `installed`. A host starts WITHOUT `download` most of the time (the download is opt-in), so it passes `installed` too, and the runtime the user already downloaded is found with no network. The same pin object serves both starts:

```ts
const pin = { allowedHosts: ['downloads.example.com'], url, sha256, version, extract }; // pinned at build time

// Ordinary start: no download. `installed` reuses what an earlier opt-in left on disk.
const rt = await prepareCopilotRuntime({ dataDirectory, installed: pin });

// Opt-in start (the user pressed Download): fetches, verifies, installs.
const fetched = await prepareCopilotRuntime({ dataDirectory, download: pin, onProgress });
```

- **Directories** under `dataDirectory` (absolute): `home/` is `baseDirectory`; `work/` is `workingDirectory` and is emptied on EVERY call, so nothing is ever discovered from it; `runtime/<version>/` holds a downloaded runtime and its `installed.json` record.
- **Bundled is preferred.** With `bundledRuntimePath` (the launcher the host ships, unpacked from the asar) the app's own signature covers it. `bundledSha256`, else a sibling `<path>.sha256` file, is checked when present; `verified` is `false` only when a bundled file had no expected value. A bundled runtime that is missing, empty or fails its checksum is an error, never a silent fall back to a download. `bundledVersion` defaults to `COPILOT_RUNTIME_VERSION` (`1.0.98`, what SDK 1.0.22 pins).
- **Download is opt-in.** It happens only when `download` is passed (its presence is the user's opt-in), no bundled path is given, and only from `download.allowedHosts`: `https`, no credentials in the URL, the default port, an exact hostname match (no wildcard), and every redirect hop checked the same way. A refused host throws before any network call; an empty list refuses everything.
- **Checksum.** There is none to trust by default, so the host supplies the SHA-256: `download.url` with `download.sha256` (a pin the host controls, the strong form), or `download.manifestUrl` (JSON `{ version, url, sha256 }`, `CopilotRuntimeManifest`, same host rules). Exactly one of the two forms. A manifest on the same origin as the file proves the transfer was intact, not that the host serving both is honest. The npm registry's `dist.integrity` is a sha512 of a different artifact and does not fit.
- **`download.extract(archivePath, destinationDirectory)`** unpacks a downloaded archive (the official artifact is a `.tgz`, and node has no tar) and returns the launcher's path, absolute or relative to that directory. Without it the downloaded file IS the runtime.
- **Installed (offline reuse).** `installed` is the pin of an earlier download: `sha256`, `version` and `extract` (whether it was an archive). A host may pass the same object it passes as `download`; the other `download` members are ignored. It is consulted only when there is no `bundledRuntimePath` and no `download`, and it NEVER fetches: a hit under `runtime/<version>/` with that SHA-256 recorded returns `source: 'cached'`, `verified: true`. A miss, or an `installed` without `sha256` (nothing to match), is `runtime_missing`, which the host answers by offering the download. When `download` is also passed, `download` wins (it reuses a matching install before it fetches).
- **Install.** The file is written beside its destination, hashed as it is written, compared, and only then renamed into place; a mismatch or an interrupted download deletes the partial file. `maxBytes` (default 768 MiB), `onProgress` and `signal` apply. An install with the same SHA-256 recorded is reused (`source: 'cached'`) without the network; a single downloaded file is re-hashed on reuse.
- **Errors** are `AiError`s. `AI_INVALID_REQUEST` for wrong options or a host that is not allowed (`details.check`: `download_host_refused` and others). `AI_PROVIDER_UNAVAILABLE` with `details.check` `runtime_missing`, `checksum_mismatch`, `download_failed` or `download_too_large`. No message carries a token or a URL's query string.

`createSdkCopilotTransport` has no option that takes `runtimePath`. The spike read that the SDK lets the connection `path` or the `COPILOT_CLI_PATH` environment variable of the runtime process override the bundled package (not exercised); pointing the SDK at `runtimePath` is the host's step.

### Egress hosts

`COPILOT_EGRESS_HOSTS` is the one list for a host that allowlists outbound traffic (a desktop egress allowlist, a proxy rule, a firewall). Plain hostnames, no scheme, no wildcard:

| Host | For |
|---|---|
| `api.githubcopilot.com` | The DEFAULT Copilot API base, used before an account is known. |
| `api.individual.githubcopilot.com` | Model traffic of an individual plan (Free, Pro, Pro+): chat completions and the model listing. |
| `api.business.githubcopilot.com` | The same, for a Copilot Business account. |
| `api.enterprise.githubcopilot.com` | The same, for a Copilot Enterprise account. |
| `github.com` | Sign-in (`/login/oauth/...`, and `github.com/login/device` for a device flow). |
| `api.github.com` | Account and entitlement calls, the Copilot token exchange. |

**Why three plan hosts.** A signed-in runtime does not use `api.githubcopilot.com`. It reads its API base from `endpoints.api` in the account's answer from `api.github.com/copilot_internal/user`, so the host depends on the plan. Without the plan host the model listing and every call are refused (seen in KVox Desktop, issue #646). The runtime's `endpoints.proxy` hosts (inline completions, which KVox never uses) and `endpoints.telemetry` hosts (KVox sends no telemetry) are deliberately NOT listed. All entries are exact hostnames; there is no wildcard.

It is INFERRED, not measured: no traffic was captured against a signed-in runtime. The other entries come from static strings in the Linux x64 runtime of SDK 1.0.22 (runtime 1.0.98); the three plan hosts follow from the `endpoints.api` mechanism and the hostnames come from the issue, not from strings read in the runtime. A string proves the runtime can contact a host, not that it does for the calls KVox makes. Treat it as the list to start from and confirm it with a capture on each platform you ship before you tighten a firewall to it; the Windows and macOS runtimes were not inspected. Left off on purpose: a GitHub Enterprise Cloud tenant's `*.ghe.com` hosts (a host that serves such tenants adds its own) and any OpenTelemetry endpoint the host configures. The OAuth redirect listener is `127.0.0.1` on a random port, local to the machine.

**Telemetry.** No dedicated telemetry host was found. SDK-level OpenTelemetry is off unless the client is given `telemetry`, and KVox passes none. The runtime itself carries a GitHub product-telemetry service, and the spike found no documented switch to turn it off; `copilotSessionConfig` sets none. Do not tell users that Copilot sends no telemetry. A host not on the allowlist cannot receive it, so the allowlist is the control that works. Where session telemetry goes is not stated in the SDK; it is inferred to be one of the hosts above.

### Routing the tasks

Copilot has no tool calling and no embeddings, so a host with Copilot as its primary provider routes Ask and the two embedding tasks elsewhere. That is `routeKvoxTasks`, in the package ROOT (`@marinoscar/kvox-ai`), not in this entry, and it is pure and provider-agnostic: see [src/routing/README.md](../routing/README.md). Pass the adapter's `kvox.toolCalling` and `kvox.embeddings` in the `ProviderChoice`.

## Entry point

`@marinoscar/kvox-ai/copilot`. Deliberately NOT re-exported by the package root, so a host that never imports this entry never loads (or needs) the SDK.

## Peer dependencies

`@github/copilot-sdk` `^1.0.22`, an OPTIONAL peer (`peerDependenciesMeta`): only `createSdkCopilotTransport` loads it, lazily, and the adapter, the catalog, the error mapping and the mock run without it. `@marinoscar/platform-ai-providers` (`AiError`, the adapter types, `toJsonSchema`, `parseStructured`) and `zod` (types). It imports no other slice. The web edition never installs the SDK.

## Configuration

No environment variable and no settings key of its own. The host passes:

- `optIn`: the user's own opt-in to GitHub Copilot (a host setting, default off). Anything but `true` refuses to build the adapter.
- `transport`: `createSdkCopilotTransport` with `baseDirectory` (an app-private Copilot data directory, so KVox's sessions never mix with the user's Copilot CLI) and `workingDirectory` (an EMPTY directory, so no AGENTS.md, CLAUDE.md, skill or MCP configuration is discovered).
- `logger` (optional): one `info` per call (`provider`, `model`, `durationMs`, token counts, `finishReason`) and a `warn` when a cleanup step fails. Never a prompt, an answer, a schema or a token.
- `catalog` (optional): a replacement fallback catalog.

There is no key: the Copilot runtime uses the user's own sign-in. `createDirectRuntime` still asks `keys('copilot')`; answer `{ apiKey: AI_KEYLESS_API_KEY }`, which the adapter ignores. No GitHub token ever crosses this code (`gitHubToken` is never set), and every message that leaves is passed through `redactTokens` (`gh[opusr]_`, `github_pat_`, `sk-`, `Bearer`).

## Extension-point catalog

- `CopilotTransport`: the adapter's whole view of the Copilot runtime (sign-in status, `startSignIn`, `waitForSignIn`, `signOut`, model listing, session create and delete, an optional `stop`, and on a session `on`, `send`, `abort`, `disconnect`, `currentToolNames`). Typed here structurally, so TypeScript never needs the SDK's types; the real SDK satisfies it through `createSdkCopilotTransport`, and a test passes `createCopilotMockTransport`.
- `CopilotAdapterLogger`: where the per-call `info` and the cleanup `warn` go.
- `CopilotRuntimeDownload.extract`: the host's archive extractor for a downloaded runtime. `CopilotRuntimeDownload.onProgress` and `signal`: progress and cancellation of the download.
- `CopilotRuntimeOptions.fetch` and `CopilotRuntimeOptions.fs` (`CopilotRuntimeFs`): replace the global `fetch` and the file-system calls of `prepareCopilotRuntime` (a proxy-aware client, a test).
- `CopilotRuntimeManifest`: the JSON a host publishes at `download.manifestUrl`.
- `COPILOT_EGRESS_HOSTS`: a frozen list a host reads, not a registry; it is not extended at run time.
