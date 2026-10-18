# @marinoscar/kvox-ai

The host-neutral model mechanics of KVox: strict structured output, the chat and tool-call mapping to and from the provider-adapter events, task-to-model choice, the local token estimate, the embedding catalog, the call and event types, and the small runtime a host supplies. Written once, so the web edition and KVox Desktop never carry two copies of what KVox does with a model. CommonJS.

## Purpose and scope

KVox's AI stack has four layers: orchestration (prompts, pipelines, the Ask loop) in `@marinoscar/kvox-api`, the model port `KvoxAiPort` in `@marinoscar/kvox-api/ports`, the model mechanics in this package, and the provider adapters (`AiProviderAdapter`) in the lean `@marinoscar/platform-ai-providers`, which needs no NestJS and no database. This package owns the third layer. A host decides only which provider runs a call and where the key comes from, through `KvoxAiRuntime` and `KvoxTaskModelSource` (see the [runtime slice](src/runtime/README.md)).

It does not own prompts, schemas, caps or pipelines (those are `@marinoscar/kvox-api`'s), the provider adapters (the platform's), key storage, usage rows or traces (the host's runtime: the platform `AiService` on web, the OS keychain on Desktop).

Status: implemented by issue #579 ([ADR-0005](../../docs/decisions/0005-ai-architecture-shared-harness.md)), unreleased like the other packages. The web edition binds `KVOX_AI` to `createKvoxAi` over its platform runtime (`apps/api/src/platform-kvox/ai/web-kvox-ai.ts`); KVox Desktop binds the same function over `createDirectRuntime`. The app's former `KvoxAi` facade, `PlatformKvoxAi` and the second error mapping are deleted.

Entry points:

- `@marinoscar/kvox-ai`: the package root, which re-exports every slice. Slice READMEs: [types](src/types/README.md), [features](src/features/README.md), [tasks](src/tasks/README.md), [structured](src/structured/README.md), [chat](src/chat/README.md), [tokens](src/tokens/README.md), [embedding](src/embedding/README.md), [runtime](src/runtime/README.md), [errors](src/errors/README.md), [port](src/port/README.md), [direct](src/direct/README.md).

- `@marinoscar/kvox-ai/testing`: `createScriptedRuntime` and `describeKvoxAiConformance` (not re-exported by the root). Slice README: [testing](src/testing/README.md).

- `@marinoscar/kvox-ai/copilot`: the GitHub Copilot provider adapter (`createCopilotAdapter`, `createSdkCopilotTransport`, `createCopilotMockTransport`), issue #581. Not re-exported by the root: it is the only entry that loads the optional peer `@github/copilot-sdk`. Slice README: [copilot](src/copilot/README.md).

## Install and peer dependencies

```bash
npm install @marinoscar/kvox-ai@next @marinoscar/kvox-api@next @marinoscar/platform-ai-providers@0.1.0-next.6 zod
```

Every slice except `copilot` is universal, so every peer in this table is required (the one optional peer, the Copilot SDK, is [below](#optional-the-github-copilot-adapter)):

| Package | Range | Needed by |
|---|---|---|
| `zod` | `^4.4.3` | `tasks`, `structured`, `chat`, `port`, `testing` |
| `@marinoscar/platform-ai-providers` | `0.1.0-next.6` (exact) | `chat`, `errors`, `port` (`AiError`, the adapter types), `runtime` (request and event types), `direct` (`AiProviderAdapter`, `AiCallContext`). Only the package root is imported (the OpenAI factories under `/openai` belong to `@marinoscar/kvox-eval`). Its `AiError` extends `Error`, not a Nest `HttpException`, and has no `toRateLimitError()`; `@marinoscar/platform-api` is not a peer and importing it is a violation. |
| `@marinoscar/kvox-api` | `>=0.0.0-0 \|\| >=0.1.0-0` | `errors`, `port`, `direct` and `testing` (`KvoxAiPort`, `KvoxAiError` from `@marinoscar/kvox-api/ports`). Same range as the contract peer of the other packages ([why](../../docs/PACKAGES.md#the-contract-peer-range)). |

### Optional: the GitHub Copilot adapter

Only a host that offers the Copilot provider (KVox Desktop) installs the SDK:

```bash
npm install @github/copilot-sdk
```

`@github/copilot-sdk` (`^1.0.22`) is an OPTIONAL peer (`peerDependenciesMeta`), needed only by `@marinoscar/kvox-ai/copilot`, and only by `createSdkCopilotTransport`, which `require`s it lazily on its first call. The package root never imports it, so the web edition never installs it. Without the SDK the adapter, the catalog, the error mapping and the mock transport still work; the real transport answers `AI_PROVIDER_UNAVAILABLE` ("The GitHub Copilot SDK is not installed"). The SDK downloads or bundles a per-platform Copilot runtime (about 133 to 174 MB unpacked): a Desktop host packages it with the app ([KVox Desktop guide](../../docs/guides/kvox-desktop.md#the-copilot-provider-adapter)).

The per-slice data is `packages/kvox-slice-peers.json`; `node scripts/kvox-packages/check-slice-peers.mjs --table` prints it.

## Quick start

A web-like host (a runtime that already owns keys, usage and traces):

```ts
import { createKvoxAi } from '@marinoscar/kvox-ai';

const kvoxAi = createKvoxAi({
  runtime,                    // KvoxAiRuntime: one provider round trip, plus key readiness
  taskModels,                 // KvoxTaskModelSource: load(userId) returns the whole model state
  requestTimeoutMs: () => 600_000, // a number or a per-call reader; optional
  graphEnabled: () => true,   // optional; default is the policy's graphEnabled
});
// kvoxAi is a KvoxAiPort: bind it as KVOX_AI (capabilities, resolveTask, generateText,
// generateStructured, chat, embed, countTokens).
```

KVox Desktop, or any host without a platform AI service, over the provider adapters with a key from the OS keychain:

```ts
import { createDirectRuntime, createKvoxAi } from '@marinoscar/kvox-ai';

const runtime = createDirectRuntime({
  adapters: { openai: openAiAdapter },            // provider id to AiProviderAdapter
  keys: async (provider) => {                     // asked on every call; nothing is cached
    const apiKey = await keychain.get(`ai:${provider}`);
    return apiKey ? { apiKey } : null;            // null becomes KvoxAiError('key_missing')
  },
});
const kvoxAi = createKvoxAi({ runtime, taskModels: localTaskModelSource });
```

### GitHub Copilot on KVox Desktop (opt-in)

The Copilot adapter plugs into the same `createDirectRuntime` as OpenAI. Copilot serves the notes and graph-extraction tasks; Ask and embeddings stay on OpenAI.

```ts
import { AI_KEYLESS_API_KEY } from '@marinoscar/platform-ai-providers';
import { createDirectRuntime, createKvoxAi } from '@marinoscar/kvox-ai';
import { createCopilotAdapter, createSdkCopilotTransport } from '@marinoscar/kvox-ai/copilot';

const copilot = createCopilotAdapter({
  optIn: settings.copilotEnabled,             // the user's own opt-in, default OFF; anything but true throws
  transport: createSdkCopilotTransport({
    baseDirectory: join(app.getPath('userData'), 'copilot'),   // app-private, never the user's Copilot CLI dir
    workingDirectory: emptyTempDir,                            // EMPTY: no AGENTS.md, CLAUDE.md, skills or MCP found
  }),
  logger,                                     // optional: provider, model, duration, tokens, finish reason
});
const runtime = createDirectRuntime({
  adapters: { openai: openAiAdapter, copilot },
  keys: async (provider) =>
    provider === 'copilot'
      ? { apiKey: AI_KEYLESS_API_KEY }        // the runtime uses the user's own sign-in; the adapter ignores this
      : (await keychain.get(`ai:${provider}`).then((apiKey) => (apiKey ? { apiKey } : null))),
});
const kvoxAi = createKvoxAi({
  runtime,
  taskModels: localTaskModelSource,
  catalog: copilot.kvox.catalog,              // per-model limits, toolCalling false, structuredOutputMode
});
```

Sign-in is the SDK's: `copilot.authStatus()` returns `{ signedIn, login }` (never a token), and a call while signed out is `AI_KEY_REQUIRED`, which `createKvoxAi` reports as `key_missing`.

Limits of the Copilot provider, by design:

- **No Ask.** Copilot models are never offered a tool: `capabilities().toolCalling` is `false` for them, so Ask stays on OpenAI. A Copilot session takes user messages only, so the harness cannot continue a tool step statelessly, and the Ask loop is never moved into the SDK.
- **No embeddings.** The adapter has no `embeddings` port. Embeddings come from the OpenAI adapter, or are `null` and search is full text only.
- **One system prompt and one user message per call.** Assistant turns, tool items, images and files are refused with `AI_CAPABILITY_UNSUPPORTED`.
- **No output cap and no temperature.** The SDK has no per-call setting for either on Copilot-hosted models, so `maxOutputTokens` is not sent. A `length` finish aborts the call at once (the runtime would otherwise continue by itself) and kvox-ai reports `truncated`.
- **Prompted structured output for some models.** GPT models hold the answer to a JSON Schema natively. Claude models are not verified for it, so the catalog marks them `prompted`: `createKvoxAi` puts the schema in the system prompt and makes one repair attempt (see the [structured slice](src/structured/README.md)). The same path serves any adapter whose model is `prompted`.
- **Sign-in needed.** Listing models and every call need a signed-in GitHub account with Copilot.
- **Opt-in until the owner decides the terms question.** Prompts and notes go to GitHub. A host must say so and point the user at the GitHub terms of service (section J, the training opt-out) before it turns the setting on. The setting defaults to off.

The pure helpers are usable on their own:

```ts
import {
  assertStrictJsonSchema,
  chooseTaskModel,
  countTokens,
  zodToStrictJsonSchema,
} from '@marinoscar/kvox-ai';
import { z } from 'zod';

const schema = zodToStrictJsonSchema(z.object({ title: z.string() }));
assertStrictJsonSchema(schema); // throws StrictSchemaError naming the JSON path of a violation

countTokens('A short prompt.'); // the local, round-up estimate every budget is checked against

const choice = chooseTaskModel({
  task: 'graph.extract',
  requested: null,
  models: [{ id: 'gpt-5-mini', structuredOutput: true, toolCalling: true }],
  policy: {
    provider: 'openai',
    defaultModel: 'gpt-5-mini',
    graphEnabled: true,
    taskModels: {},
    reasoningEffort: 'medium',
  },
});
// choice.model === 'gpt-5-mini', choice.source === 'default', choice.problem === null
```

## Configuration

None today: the package reads no environment variable and no settings key. The task-model policy, the enabled models and the request timeout reach it as data from the host (`KvoxTaskModelSource`, and the `createKvoxAi` options `requestTimeoutMs`, `graphEnabled` and `catalog`).

## Extension-point catalog

What a host implements (see [the runtime slice](src/runtime/README.md#extension-point-catalog)):

- `KvoxAiRuntime`: one provider round trip (`stream`, `create`, optional `embed`) and the key-presence answer (`readiness`). Web: `PlatformAiRuntime` over the platform `AiService.forUser(...)`. Desktop: `createDirectRuntime` over the provider adapters with a key from the OS keychain.
- `AiProviderAdapter` (platform type) entries of `createDirectRuntime({ adapters })`: how a provider such as OpenAI or the Copilot SDK (#581) plugs in.
- `KvoxTaskModelSource`: loads the task-model state (policy, active provider, enabled models). Web: system settings and the `ai_models` rows. Desktop: a local settings file.
- `KvoxModelCatalog`: optional per-model limits and capability flags.
- `CopilotTransport` (`@marinoscar/kvox-ai/copilot`): the GitHub Copilot adapter's view of the Copilot runtime. `createSdkCopilotTransport` binds it to the optional `@github/copilot-sdk`; `createCopilotMockTransport` is the test one (see [the copilot slice](src/copilot/README.md#extension-point-catalog)).

## Data

None. The package owns no table and writes no file. Two constants are contracts with data elsewhere: `EMBEDDING_DIMENSIONS` (1536) is the width of the `vector(1536)` columns of `@marinoscar/kvox-db`, and `KVOX_EMBEDDING.model` is recorded on every stored vector (changing either is a migration and a re-index, see [the embedding slice](src/embedding/README.md)).

## Permissions and settings

None of its own. The vocabularies it defines are persisted by hosts and are therefore permanent: the feature ids (`KVOX_AI_FEATURES`, on every usage row), the task keys (`AI_TASK_KEYS`, keys of the stored `ai.taskModels` map) and the readiness reasons (`KvoxAiReason`, the `details.reason` of the 409/400 responses).

## UI

None. The admin task form reads `AI_TASK_DEFINITIONS` through the web API; this package renders nothing.

## Infra

None.

## Observability

None of its own: the package logs nothing (the Copilot adapter takes an optional `logger` and writes one metadata-only `info` per call, never content), emits no metric and opens no span. Usage rows and spans are the host runtime's (one per provider round trip on web, written by the platform `AiService`).

## Security notes

- A key never crosses the port or a package interface: `KvoxAiRuntimeCall` names a user and a provider, never a key, and `KvoxAiKeyReadiness` says only whether a key exists. `createDirectRuntime` asks the host for a key per call, hands it to the adapter in that call's `AiCallContext` and drops it when the call settles; it caches none.
- Every failure that leaves the port is a `KvoxAiError` of an existing `KvoxAiErrorClass` (`auth`, `refusal`, `rate_limit`, `budget`, `timeout`, `not_configured`, `key_missing`, `capability`, `truncated`, `invalid_output`, `other`); a runtime's raw error never escapes. Every message passes through `scrub`, which replaces key-shaped strings (`sk-...`, `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), as a backstop.
- No prompt, answer, tool argument or reasoning item is logged or persisted. Reasoning items replayed by the chat mapping are opaque provider state, kept in memory per user and job, never written anywhere.
- Tool-call arguments (`argumentsJson`) are untrusted model output: callers parse and validate them before use.
- **The Copilot adapter** (`@marinoscar/kvox-ai/copilot`) is a translator with several guards:
  - Zero tools. `availableTools: []`, client `mode: 'empty'`, every permission request rejected. After `createSession` the adapter reads the session's live tool list; any tool, or any tool event during the call, aborts it with `AI_CAPABILITY_UNSUPPORTED`.
  - Our system prompt replaces the SDK's (`systemMessage.mode: 'replace'`), and the runtime's `<current_datetime>` prefix is suppressed.
  - One session per call, always disconnected and deleted in a `finally` (the runtime would otherwise keep the prompt in its session state on disk), in an app-private `baseDirectory` with an empty `workingDirectory`.
  - No GitHub token crosses our code: `gitHubToken` is never set, `ctx.apiKey` (`AI_KEYLESS_API_KEY`) is ignored, and the SDK uses the user's own sign-in. Every message that leaves the adapter (error message and details, log entry, stream error) passes through `redactTokens` (`gh[opusr]_`, `github_pat_`, `sk-`, `Bearer`) and is truncated. The logger never gets a prompt, an answer or a schema.
  - Opt-in. `createCopilotAdapter` throws unless `optIn === true`; the host's setting defaults to off.
- The source imports no `@nestjs/*`, no Prisma, no `@app/shared`, and of the platform only `@marinoscar/platform-ai-providers` (rule `host-neutral` of `npm run check:kvox-slice-peers`, and `apps/api/test/ai/ai-port-boundary.spec.ts`).

## Conformance suite

`@marinoscar/kvox-ai/testing` exports `createScriptedRuntime` (a runtime that replays scripted provider events, responses, errors and hangs, and records each call) and `describeKvoxAiConformance(name, build, harness?, options?)`: the rules of a `KvoxAiPort` (strict structured output validated twice, `truncated`, `invalid_output`, the tool-call event mapping, `rate_limit` with `retryAfterMs` in a job, `auth`, `refusal`, `timeout`, no key-shaped string in any error or event, deterministic `countTokens`). A case a host cannot produce is a reasoned `optOut`, never a silent skip. The package runs it with `createKvoxAi` over the scripted runtime (`test/kvox-ai-conformance.spec.ts`), together with the host-port kit `describeKvoxPortsConformance` and the Ask kit `describeAskConformance` from `@marinoscar/kvox-api` bound to the same port; the web edition runs the same three over its platform binding (`apps/api/test/platform-kvox/`). The moved unit specs (`src/**/*.spec.ts`, `npm run test:run -w @marinoscar/kvox-ai`) pin the structured-schema rules, the chat mapping, the chooser, the token estimate and the embedding contract.

### Copilot adapter

The Copilot adapter is proven on two levels. Its own unit specs (`src/copilot/*.spec.ts`) pin the session template (zero built-in tools, replace mode), the tripwire, token redaction, the single model request after a `length` or a call failure, the datetime suppression, session deletion on success, failure and abort, the request refusals and the error mapping. The `describeKvoxAiConformance` suite then runs over `createKvoxAi`, `createDirectRuntime` and the adapter on `createCopilotMockTransport()` (asynchronous SDK-shaped events, abort, model-request counting, live tools for the tripwire). Two cases are named `optOut`s with their reason (`test/kvox-ai-copilot-conformance.spec.ts`): the tool-call mapping (`chat_tool_calls`), because `toolCalling` is `false`, and the retry hint in a job (`rate_limit_job`), because SDK 1.0.22 puts no retry-after on `session.error` or `model.call_failure`. Every other case runs. The real SDK is not part of CI, and `createSdkCopilotTransport` has not yet run against a signed-in Copilot runtime: that live check, with the `kvox-eval` runs, is an owner step on #581.

### Lean install and the foreign `AiError`

`npm run check:kvox-lean-install` (in the repository) packs `@marinoscar/kvox-ai`, installs it alone in a scratch project with no `@marinoscar/platform-api`, asserts that package is absent from the install tree and builds an OpenAI adapter through `createDirectRuntime`. One honest limit: the peer `@marinoscar/kvox-api` is installed with its `@marinoscar/platform-api` peer left out, because that peer is optional there.

`isAiError(value)` (root export, `errors` slice) answers whether a thrown value is a provider `AiError` by class (`AiError.isAiError`, `instanceof`) or by shape (an `Error` named `AiError` with a known AI error code and a `getResponse` function). The web host's `AiService` still throws the `AiError` class of its own `@marinoscar/platform-api` copy, a distinct lookalike, until platform-api re-exports the lean class. `toKvoxAiError` and `createDirectRuntime` classify through `isAiError`, so both classes map to the same `KvoxAiError`; only `code`, `message` and `retryAfterMs` are read. A host that catches errors itself should use `isAiError`, not `instanceof`.

## Upgrade notes

First release. The provider types and the `AiError` class come from `@marinoscar/platform-ai-providers` (issue #578), no longer from `@marinoscar/platform-api/ai`. The web edition's second mapping hop is gone: `mapAiError` and the port adapter's `toKvoxAiError` are one function, `toKvoxAiError` of the `errors` slice, proven equal by `test/fixtures/error-parity.v1.json`. For code that imported these files from `apps/api/src/ai-port/` (`strict-json-schema`, `chat-mapping`, `count-tokens`, `embedding-catalog`, `features`, `ai-task-keys`, `task-models`, the type half of `kvox-ai.ts`): import the same names from `@marinoscar/kvox-ai`. `KvoxAiReason` moved from `kvox-ai-errors.ts` with `KvoxAiReadiness`. Nothing was renamed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '@marinoscar/kvox-ai'` in `apps/api` | Build the packages first: `npm run build:kvox-packages`. |
| `[host-neutral] ... may import only '@marinoscar/platform-ai-providers'` | A slice imported `@marinoscar/platform-api` or another platform package. Use only the lean `@marinoscar/platform-ai-providers`; anything host-specific belongs in the host's runtime. |
| `createCopilotAdapter` throws "GitHub Copilot is switched off" | The host did not pass `optIn: true`. Pass the user's own Copilot setting (default off). |
| `AI_PROVIDER_UNAVAILABLE`: "The GitHub Copilot SDK is not installed" | Install the optional peer: `npm install @github/copilot-sdk`. |
| `AI_KEY_REQUIRED`: "Sign in to GitHub Copilot to use it in KVox." | The user is not signed in. Start the SDK's sign-in, then check `copilot.authStatus()`. |
| `AI_CAPABILITY_UNSUPPORTED` from the Copilot adapter | A request carried tools, history, images or a structured schema for a `prompted` model. Route tool calling to OpenAI; pass `catalog: copilot.kvox.catalog` to `createKvoxAi` so kvox-ai takes its prompted path. |
| `StrictSchemaError` at a JSON path | The caller's schema is outside the strict subset (rules in `src/structured/strict-json-schema.ts`); fix the schema (`.nullable()`, not `.optional()`). |

## Links

- The package standard: [docs/PACKAGES.md](../../docs/PACKAGES.md)
- Release procedure: [docs/runbooks/release-kvox-packages.md](../../docs/runbooks/release-kvox-packages.md)
- Consuming the packages from KVox Desktop (where `createKvoxAi` plus `createDirectRuntime` bind the model port): [docs/guides/kvox-desktop.md](../../docs/guides/kvox-desktop.md)
- The model port this package implements: [packages/kvox-api/src/ports/README.md](../kvox-api/src/ports/README.md)
- Dev commands: `npm run build -w @marinoscar/kvox-ai`, `npm run typecheck -w @marinoscar/kvox-ai`, `npm run test:run -w @marinoscar/kvox-ai`, `npm run docs -w @marinoscar/kvox-ai`
