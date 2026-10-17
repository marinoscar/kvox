# @marinoscar/kvox-ai

The host-neutral model mechanics of KVox: strict structured output, the chat and tool-call mapping to and from the provider-adapter events, task-to-model choice, the local token estimate, the embedding catalog, the call and event types, and the small runtime a host supplies. Written once, so the web edition and KVox Desktop never carry two copies of what KVox does with a model. CommonJS.

## Purpose and scope

KVox's AI stack has four layers: orchestration (prompts, pipelines, the Ask loop) in `@marinoscar/kvox-api`, the model port `KvoxAiPort` in `@marinoscar/kvox-api/ports`, the model mechanics in this package, and the provider adapters (`AiProviderAdapter`) in `@marinoscar/platform-api/ai`. This package owns the third layer. A host decides only which provider runs a call and where the key comes from, through `KvoxAiRuntime` and `KvoxTaskModelSource` (see the [runtime slice](src/runtime/README.md)).

It does not own prompts, schemas, caps or pipelines (those are `@marinoscar/kvox-api`'s), the provider adapters (the platform's), key storage, usage rows or traces (the host's runtime: the platform `AiService` on web, the OS keychain on Desktop).

Status: implemented by issue #579 ([ADR-0005](../../docs/decisions/0005-ai-architecture-shared-harness.md)), unreleased like the other packages. The web edition binds `KVOX_AI` to `createKvoxAi` over its platform runtime (`apps/api/src/platform-kvox/ai/web-kvox-ai.ts`); KVox Desktop binds the same function over `createDirectRuntime`. The app's former `KvoxAi` facade, `PlatformKvoxAi` and the second error mapping are deleted.

Entry points:

- `@marinoscar/kvox-ai`: the package root, which re-exports every slice. Slice READMEs: [types](src/types/README.md), [features](src/features/README.md), [tasks](src/tasks/README.md), [structured](src/structured/README.md), [chat](src/chat/README.md), [tokens](src/tokens/README.md), [embedding](src/embedding/README.md), [runtime](src/runtime/README.md), [errors](src/errors/README.md), [port](src/port/README.md), [direct](src/direct/README.md).

- `@marinoscar/kvox-ai/testing`: `createScriptedRuntime` and `describeKvoxAiConformance` (not re-exported by the root). Slice README: [testing](src/testing/README.md).

## Install and peer dependencies

```bash
npm install @marinoscar/kvox-ai@next @marinoscar/kvox-api@next @marinoscar/platform-api@0.1.0-next.5 zod
```

Every slice is universal, so every peer is required:

| Package | Range | Needed by |
|---|---|---|
| `zod` | `^4.4.3` | `tasks`, `structured`, `chat`, `port`, `testing` |
| `@marinoscar/platform-api` | `0.1.0-next.5` (exact, the repository's platform pin) | `chat`, `errors`, `port` (`AiError`, the adapter types), `runtime` (request and event types), `direct` (`AiProviderAdapter`, `AiCallContext`). Only the subpath `@marinoscar/platform-api/ai` is imported. An interim peer: it moves to the lean adapter package of #578. |
| `@marinoscar/kvox-api` | `>=0.0.0-0 \|\| >=0.1.0-0` | `errors`, `port`, `direct` and `testing` (`KvoxAiPort`, `KvoxAiError` from `@marinoscar/kvox-api/ports`). Same range as the contract peer of the other packages ([why](../../docs/PACKAGES.md#the-contract-peer-range)). |

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

## Data

None. The package owns no table and writes no file. Two constants are contracts with data elsewhere: `EMBEDDING_DIMENSIONS` (1536) is the width of the `vector(1536)` columns of `@marinoscar/kvox-db`, and `KVOX_EMBEDDING.model` is recorded on every stored vector (changing either is a migration and a re-index, see [the embedding slice](src/embedding/README.md)).

## Permissions and settings

None of its own. The vocabularies it defines are persisted by hosts and are therefore permanent: the feature ids (`KVOX_AI_FEATURES`, on every usage row), the task keys (`AI_TASK_KEYS`, keys of the stored `ai.taskModels` map) and the readiness reasons (`KvoxAiReason`, the `details.reason` of the 409/400 responses).

## UI

None. The admin task form reads `AI_TASK_DEFINITIONS` through the web API; this package renders nothing.

## Infra

None.

## Observability

None of its own: the package logs nothing, emits no metric and opens no span. Usage rows and spans are the host runtime's (one per provider round trip on web, written by the platform `AiService`).

## Security notes

- A key never crosses the port or a package interface: `KvoxAiRuntimeCall` names a user and a provider, never a key, and `KvoxAiKeyReadiness` says only whether a key exists. `createDirectRuntime` asks the host for a key per call, hands it to the adapter in that call's `AiCallContext` and drops it when the call settles; it caches none.
- Every failure that leaves the port is a `KvoxAiError` of an existing `KvoxAiErrorClass` (`auth`, `refusal`, `rate_limit`, `budget`, `timeout`, `not_configured`, `key_missing`, `capability`, `truncated`, `invalid_output`, `other`); a runtime's raw error never escapes. Every message passes through `scrub`, which replaces key-shaped strings (`sk-...`, `ghp_`, `gho_`, `github_pat_`), as a backstop.
- No prompt, answer, tool argument or reasoning item is logged or persisted. Reasoning items replayed by the chat mapping are opaque provider state, kept in memory per user and job, never written anywhere.
- Tool-call arguments (`argumentsJson`) are untrusted model output: callers parse and validate them before use.
- The source imports no `@nestjs/*`, no Prisma, no `@app/shared`, and of the platform only `@marinoscar/platform-api/ai` (rule `host-neutral` of `npm run check:kvox-slice-peers`, and `apps/api/test/ai/ai-port-boundary.spec.ts`).

## Conformance suite

`@marinoscar/kvox-ai/testing` exports `createScriptedRuntime` (a runtime that replays scripted provider events, responses, errors and hangs, and records each call) and `describeKvoxAiConformance(name, build, harness?, options?)`: the rules of a `KvoxAiPort` (strict structured output validated twice, `truncated`, `invalid_output`, the tool-call event mapping, `rate_limit` with `retryAfterMs` in a job, `auth`, `refusal`, `timeout`, no key-shaped string in any error or event, deterministic `countTokens`). A case a host cannot produce is a reasoned `optOut`, never a silent skip. The package runs it with `createKvoxAi` over the scripted runtime (`test/kvox-ai-conformance.spec.ts`), together with the host-port kit `describeKvoxPortsConformance` and the Ask kit `describeAskConformance` from `@marinoscar/kvox-api` bound to the same port; the web edition runs the same three over its platform binding (`apps/api/test/platform-kvox/`). The moved unit specs (`src/**/*.spec.ts`, `npm run test:run -w @marinoscar/kvox-ai`) pin the structured-schema rules, the chat mapping, the chooser, the token estimate and the embedding contract.

## Upgrade notes

First release. The web edition's second mapping hop is gone: `mapAiError` and the port adapter's `toKvoxAiError` are one function, `toKvoxAiError` of the `errors` slice, proven equal by `test/fixtures/error-parity.v1.json`. For code that imported these files from `apps/api/src/ai-port/` (`strict-json-schema`, `chat-mapping`, `count-tokens`, `embedding-catalog`, `features`, `ai-task-keys`, `task-models`, the type half of `kvox-ai.ts`): import the same names from `@marinoscar/kvox-ai`. `KvoxAiReason` moved from `kvox-ai-errors.ts` with `KvoxAiReadiness`. Nothing was renamed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '@marinoscar/kvox-ai'` in `apps/api` | Build the packages first: `npm run build:kvox-packages`. |
| `[host-neutral] ... may import only '@marinoscar/platform-api/ai'` | A slice imported another platform subpath or a deeper path. Use only the public `@marinoscar/platform-api/ai`; anything host-specific belongs in the host's runtime. |
| `StrictSchemaError` at a JSON path | The caller's schema is outside the strict subset (rules in `src/structured/strict-json-schema.ts`); fix the schema (`.nullable()`, not `.optional()`). |

## Links

- The package standard: [docs/PACKAGES.md](../../docs/PACKAGES.md)
- Release procedure: [docs/runbooks/release-kvox-packages.md](../../docs/runbooks/release-kvox-packages.md)
- Consuming the packages from KVox Desktop (where `createKvoxAi` plus `createDirectRuntime` bind the model port): [docs/guides/kvox-desktop.md](../../docs/guides/kvox-desktop.md)
- The model port this package implements: [packages/kvox-api/src/ports/README.md](../kvox-api/src/ports/README.md)
- Dev commands: `npm run build -w @marinoscar/kvox-ai`, `npm run typecheck -w @marinoscar/kvox-ai`, `npm run test:run -w @marinoscar/kvox-ai`, `npm run docs -w @marinoscar/kvox-ai`
