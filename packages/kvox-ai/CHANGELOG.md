# @marinoscar/kvox-ai

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
