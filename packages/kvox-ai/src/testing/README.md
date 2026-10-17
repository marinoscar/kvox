# testing

`@marinoscar/kvox-ai/testing`: a scripted `KvoxAiRuntime` and `describeKvoxAiConformance`, the executable rules of a `KvoxAiPort`.

## Purpose and scope

`createScriptedRuntime(script)` is a runtime that replays scripted provider round trips (streamed events, complete responses, embeddings, a thrown error, or a hang that settles only when the call's signal aborts), answers a working default when its queue is empty, records every round trip (`calls`: the `KvoxAiRuntimeCall` and the request, never a key) and answers key readiness from a flag. The event builders (`textDeltaEvent`, `functionCallEvent`, `completedEvent`, `errorEvent`, `textAnswer`, `eventStream`, `collect`) write what a provider says in the provider-adapter types, for the runtime and for a host that drives its own platform client.

`describeKvoxAiConformance(name, build, harness?, options?)` registers the rules any `KvoxAiPort` must keep, whatever host it is bound for: structured output is held to a strict vendor schema and re-validated against the caller's Zod schema (a parsed value that fails it is `invalid_output`); a structured answer cut off at the ceiling is `truncated`; a chat step maps to `delta | tool_call | step_end | done` with one `step_end` per step and no `delta` after a `tool_call`; a 429 is `rate_limit` (with `retryAfterMs` inside a job, without it on a route); a rejected key inside a job is `auth`; a content filter is `refusal`; a round trip that outlives `requestTimeoutMs` is `timeout`; no failure or event carries a key-shaped string; `countTokens` is deterministic. `build` returns the port and a `KvoxAiConformanceProvider` (how to make the provider under it answer, fail or hang).

Job or route: the same platform code lands on a different class inside a queue job (the context carries a `jobId`) than on a route. The cases that depend on it say which context they use; the table is in `src/errors/kvox-ai-errors.ts`.

A case a host cannot produce is named in `options.optOut` with a reason. It is never skipped silently: the case runs as a test that prints the reason, and a case that is neither run nor opted out fails.

Status: issue #579, PR 2.

## Entry point

`@marinoscar/kvox-ai/testing`. It is not re-exported by the package root.

## Peer dependencies

`@marinoscar/kvox-api` (`KvoxAiError`, the port types), `@marinoscar/platform-api` (only `@marinoscar/platform-api/ai`) and `zod`. It imports the `types`, `features`, `tasks`, `structured`, `chat`, `tokens`, `embedding`, `runtime` and `errors` slices. It uses no test runner import: pass `{ describe, it, expect }` (Jest or Vitest) or let the globals be used.

## Configuration

`describeKvoxAiConformance` takes `build({ requestTimeoutMs? })`, which must return a fresh port and provider handle per test, and `options.optOut`. `createScriptedRuntime` takes an optional starting script (`streams`, `creates`, `embeds`, `hasKey`, `embeddings`).

## Extension-point catalog

None. The `KvoxAiConformanceProvider` interface is what a host implements to put a provider under the suite.
