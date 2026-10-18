# port

`createKvoxAi`: the one implementation of `KvoxAiPort`, over a host-supplied runtime and task-model source.

## Purpose and scope

`createKvoxAi(options)` returns the `KvoxAiPort` of `@marinoscar/kvox-api/ports`: `capabilities`, `resolveTask`, `generateText`, `generateStructured`, `chat`, `embed`, `countTokens`. It keeps every rule of the web edition's former `PlatformKvoxAi` and port adapter: the strict JSON Schema round trip through `z.fromJSONSchema` with the caller's Zod schema re-validating, the truncation heuristic for a structured answer the platform could not parse, the reasoning-effort clamp (`xhigh` to `high`, `none` omits it), the request timeout combined with the caller's signal, the chat step rule (text after a tool call dropped, `step_end` then `done`), the embeddings batch and shape checks, one reasoning-replay cache per instance. Also `createKvoxAiReadiness` (the reader the port resolves targets through), `deriveReadiness` and `reasoningEffortFor` (pure), `featureOf` (port feature names to registered ids), `DEFAULT_REQUEST_TIMEOUT_MS`, `FLOOR_CONTEXT_WINDOW_TOKENS` and `FLOOR_MAX_OUTPUT_TOKENS`.

Status: issue #579. The readiness logic lives here rather than in `tasks` because it reads `features` and `embedding`, and `features` already imports `tasks`.

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

`@marinoscar/kvox-api` (`KvoxAiPort`, `KvoxAiError`), `@marinoscar/platform-ai-providers` (`AiError` and the adapter types) and `zod`. It imports the `types`, `features`, `tasks`, `chat`, `tokens`, `embedding`, `runtime` and `errors` slices.

## Configuration

`CreateKvoxAiOptions`: `runtime` and `taskModels` (required); `catalog`, `readiness` (a shared reader), `requestTimeoutMs` (a number or a per-call reader), `graphEnabled`, `logger` (optional).

## Extension-point catalog

None of its own: a host supplies the `runtime` slice's `KvoxAiRuntime`, `KvoxTaskModelSource` and `KvoxModelCatalog`.
