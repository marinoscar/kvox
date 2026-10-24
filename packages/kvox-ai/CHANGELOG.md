# @marinoscar/kvox-ai

## 0.1.0-next.18

### Patch Changes

- 00e94ec: Dependency and peer ranges on the platform packages move from 0.1.0-next.11 to 0.1.0-next.12, the release whose CLI engine records the deployment's compose project itself. No code in these packages changes.

## 0.1.0-next.17

## 0.1.0-next.16

## 0.1.0-next.15

## 0.1.0-next.14

### Patch Changes

- 5a36b44: Dependency and peer ranges on the platform packages move from 0.1.0-next.10 to 0.1.0-next.11, the release that hands deploy checks the deployment's recorded compose project. No code in these packages changes.

## 0.1.0-next.13

### Patch Changes

- b2d260a: Dependency and peer ranges on the platform packages move from 0.1.0-next.9 to 0.1.0-next.10, the release that fixes the deploy update retry after a failed run. No code in these packages changes.

## 0.1.0-next.12

## 0.1.0-next.11

### Minor Changes

- c66c19d: The embedding model is a catalog entry the host chooses. `@marinoscar/kvox-ai` adds `KvoxEmbeddingModel` and `KVOX_LOCAL_EMBEDDING` (bge-small-en-v1.5-int8, 384 wide, keyless), `createKvoxAi({ embedding })` (default unchanged: OpenAI text-embedding-3-small, 1536), zero-padding of a narrower model to the 1536-wide column, and a `purpose` on embed requests that selects the query or document prefix. `EmbeddingShapeError` (unused) is removed. `@marinoscar/kvox-api` adds optional `nativeDimensions` and `minSimilarity` to `KvoxEmbeddingsInfo` and `purpose` to the port's `embed` request.
- c66c19d: New entry point `@marinoscar/kvox-ai/local-embeddings`: the on-device embedding model for `KVOX_LOCAL_EMBEDDING` (bge-small-en-v1.5, int8, MIT). `downloadLocalEmbeddingModel`, `localEmbeddingModelStatus` and `removeLocalEmbeddingModel` install the three pinned files (revision-pinned Hugging Face URLs, exact size and SHA-256, https and exact-host allowlist checked on every redirect hop); `createLocalEmbedder` runs the model on `onnxruntime-web` and `@huggingface/tokenizers` (optional peers, loaded lazily; it blocks the event loop, so run it off the event loop); `createLocalEmbeddingRuntime` wraps a host's embed transport as a `KvoxAiRuntime`. The verified download that `prepareCopilotRuntime` used is now shared (`download` slice) with identical behaviour.

## 0.1.0-next.10

### Minor Changes

- 4c5b970: Ask runs on GitHub Copilot through native tool calling (#654). `@marinoscar/kvox-ai/copilot`: when a request carries function tools, the adapter declares them as the session's custom tools (an allowlist of exactly their names; no built-in Copilot tool is ever available; every own tool is declared with `overridesBuiltInTool: true` so Ask's names (`search`, `timeline`, ...) cannot clash with a runtime built-in; a tool the session lists beyond the request's own is only logged once as a `warn` (names only, redacted) because the live list is unverified, while a call of any other tool still aborts the call with `AI_CAPABILITY_UNSUPPORTED` and `details.tools`), ends a step in which the model calls tools with those calls (`finishReason: 'tool_calls'`) and keeps the session open. The loop's next request, the full history plus the tool outputs as before, continues the same session as the next step; when no session matches (idle timeout, restart, an edited request, the forced `toolChoice: 'none'` answer) a fresh session is given the transcript as text, so a step never fails for lack of state. The loop, its prompts and its tools stay in the API package. A held session is deleted when its turn ends, on abort or error, after an idle timeout (`bridge.idleTimeoutMs`, 120 s) and when the registry (`bridge.maxHeldSessions`, 8) overflows; the new `adapter.bridge.closeAll()` is for the Desktop host's shutdown. `adapter.kvox.toolCalling` is now `true`, and the model catalog and `classifyModel` honour an explicit "no tool calling" in the live model listing, so `routeKvoxTasks` sends Ask to Copilot. `CopilotSessionConfig` gains `tools` (each `CopilotToolDefinition` carries `overridesBuiltInTool: true`), `CopilotModelInfo` gains `capabilities.supports`, and the mock transport can script tool calls (`toolCalls` replies, `emit`) and name `builtInTools` that reject a clashing custom tool.

## 0.1.0-next.9

## 0.1.0-next.8

## 0.1.0-next.7

### Patch Changes

- c74733f: Copilot fixes found in the Desktop host (#646). `@marinoscar/kvox-ai/copilot`: `prepareCopilotRuntime` takes `installed` (the pin of an earlier download) and reuses that install with no network, so a host that starts without `download` no longer reports a downloaded runtime as missing; `COPILOT_EGRESS_HOSTS` adds the per-plan API hosts the runtime reads from the account's `endpoints.api` (`api.individual`, `api.business`, `api.enterprise` `.githubcopilot.com`), without which the model listing and every call were refused. `@marinoscar/kvox-contract/copilot`: `CopilotSettingsPatchSchema` (strict, every field optional, no defaults), because `CopilotSettingsSchema.partial()` still applies the defaults under Zod 4 and turned a `{ model }` patch into "Copilot off, no consent".

## 0.1.0-next.6

## 0.1.0-next.5

## 0.1.0-next.4

## 0.1.0-next.3

## 0.1.0-next.2

### Minor Changes

- 3ac74b3: Copilot sign-in, runtime lifecycle and capability-based routing, so hosts carry no Copilot mechanics (#630). `@marinoscar/kvox-ai/copilot`: `adapter.signIn.start()/wait()` and `adapter.signOut()` over new `CopilotTransport.startSignIn/waitForSignIn/signOut` (the SDK's experimental account RPCs; no token crosses KVox code; the scriptable mock gains `scriptSignIn`), `prepareCopilotRuntime` (app-private directories, empty working directory, bundled runtime preferred, opt-in download only from allowed hosts with a SHA-256 check) and `COPILOT_EGRESS_HOSTS`. Package root: `routeKvoxTasks`, which sends tasks that need tool calling (`ask.respond`) or embeddings to a fallback provider and reports the rest as unavailable.

## 0.1.0-next.1

### Minor Changes

- 38bf270: `@marinoscar/kvox-ai` and `@marinoscar/kvox-eval` no longer require `@marinoscar/platform-api`: they depend on the lean `@marinoscar/platform-ai-providers` (provider adapters and the provider-agnostic AI core, no Nest runtime) as an exact-version peer, and `kvox-eval` gains an `openai` peer for its live runs (#578). `kvox-ai` exports `isAiError()`, which recognises the lean `AiError` and the web host's distinct `AiError` class, so error classification is unchanged in both editions.

## 0.1.0-next.0

### Minor Changes

- 2bae221: GitHub Copilot provider adapter for KVox Desktop (#581, Phase 2). New entry `@marinoscar/kvox-ai/copilot`: `createCopilotAdapter` (an `AiProviderAdapter`, opt-in: it throws unless `optIn === true`; notes and graph extraction only, `toolCalling` false, no embeddings), `createSdkCopilotTransport`, `createCopilotMockTransport` and the fallback model catalog. The entry is not re-exported by the root. New optional peer `@github/copilot-sdk` (`^1.0.22`), loaded lazily by the real transport only. Shared by every adapter: a prompted structured-output path (`structuredOutputMode: 'prompted'` per model puts the schema in the prompt and makes one repair), per-model `toolCalling` in `capabilities()`, and `wrapRecordingAdapter` in `@marinoscar/kvox-ai/testing`. `scrub` also covers `ghu_`, `ghs_` and `ghr_` tokens.
- df5ed39: `createKvoxAi(options)` implements `KvoxAiPort` over a host-supplied `KvoxAiRuntime` (#579): strict structured output with Zod re-validation, the truncation rule, the reasoning-effort clamp, the request timeout, the tool-call chat mapping, readiness and capabilities, and one translation of every failure to a `KvoxAiError`. `createDirectRuntime({ adapters, keys })` runs it over provider adapters with a key fetched per call (KVox Desktop). New entry `@marinoscar/kvox-ai/testing`: `createScriptedRuntime` and `describeKvoxAiConformance`.
- 6487b33: New package `@marinoscar/kvox-ai`: the host-neutral model mechanics of KVox (#579). The pure files of the web app's AI port move in unchanged (strict JSON-schema checks, the chat and tool-call mapping, the task vocabulary and `chooseTaskModel`, the local token estimate, the embedding catalog, the call and event types), and the interfaces a host supplies are declared (`KvoxAiRuntime`, `KvoxTaskModelSource`, `KvoxModelCatalog`). `createKvoxAi`, the direct runtime and the `./testing` entry follow in the next release.
- 8dfebb9: Harness parity (#580). `@marinoscar/kvox-ai/testing` gains request recorders: `createRecordingRuntime` (every runtime round trip, without user, org, job or signal), `createRecordingAdapter` (a scripted provider adapter for `createDirectRuntime` that records what it receives) and `normalizeRecordedValue` (ids, timestamps and request ids numbered by first appearance, nothing dropped). `@marinoscar/kvox-eval/parity` drives notes generation, `kg.extract`, adjudication and three Ask questions through the real package code over any `KvoxAiPort` and ships the request snapshots (`parity/requests.*.json`) every host binding must reproduce; `kg` also exports `runExtraction` and `fixtureToInput`. `@marinoscar/kvox-api/notes` exports `budgetFromTarget` and the `AiTokenCaps` type.
