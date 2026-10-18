# ADR-0005: AI architecture: one shared harness, pluggable providers

- Status: Accepted (implementation #579; lean provider package consumed, #578)
- Date: 2026-10-17
- Related issues: epic #574, #578, #579, #580, #581, #584

## Context

Both hosts must use the same prompts, pipelines and rules ([ADR-0001](0001-packages-first.md)) while reaching models differently: the web edition through the platform `AiService` with a per-user key, usage rows and traces; Desktop directly with a key from the OS keychain. Before #579 the model mechanics sat in `apps/api/src/ai-port` (web only, about 3,000 lines); they now live in `@marinoscar/kvox-ai`.

## Decision

Four layers:

| Layer | What | Where | State |
|---|---|---|---|
| L4 | Orchestration: prompts, note pipeline, `kg.extract` and `kg.resolve`, Ask loop, budgets, sensitivity | `@marinoscar/kvox-api` | Shared today |
| L3 | The `KVOX_AI` port (`KvoxAiPort`) | `@marinoscar/kvox-api` | Shared today |
| L2 | Model mechanics: strict JSON schema, chat and tool mapping, structured-output rules, task-to-model resolution, token counting, error mapping | `@marinoscar/kvox-ai` (`packages/kvox-ai`) | Implemented by #579 |
| L1 | Transport: provider adapters implementing `AiProviderAdapter` (OpenAI, OpenAI-compatible, Anthropic, Azure, Gemini) from `@marinoscar/platform-ai-providers` | Platform; the lean provider package (split out upstream, #578), consumed by `kvox-ai` and `kvox-eval` as a peer, with no NestJS and no database | Shared |

The web edition keeps its platform `AiService`, whose `AiError` is still the class of `@marinoscar/platform-api` (a distinct lookalike of the lean one) until platform-api re-exports the lean package; `isAiError` of `@marinoscar/kvox-ai` classifies both structurally. `npm run check:kvox-lean-install` proves `kvox-ai` installs with no `@marinoscar/platform-api`.

L2 is exposed as `createKvoxAi({ runtime, taskModels, readiness?, requestTimeoutMs, graphEnabled, logger, catalog })` (the one `KvoxAiPort` implementation) and `createDirectRuntime({ adapters, keys })`, both from `@marinoscar/kvox-ai`; `@marinoscar/kvox-ai/testing` carries the scripted runtime and `describeKvoxAiConformance`. Implemented by #579.

- Web runtime: `PlatformAiRuntime` (`apps/api/src/ai-port/platform-ai-runtime.ts`) over the platform `AiService.forUser` (gates, user key, usage rows, traces).
- Desktop runtime: adapters called directly with a key from the OS keychain.

Providers: OpenAI first on both. The GitHub Copilot SDK is a Desktop extension implemented as one more `AiProviderAdapter` (#581) with hard requirements:

1. Our system prompt replaces the SDK's.
2. All built-in agent tools are disabled.
3. One model step per call, so the Ask loop stays in `kvox-api`.

If these cannot be met, there is no Copilot (or Copilot without Ask).

Same harness does not mean same output. Parity is proven by byte-identical provider requests (#580). Model quality is measured per provider and model with the golden set. The hand-written OpenAI client in `apps/api/scripts/kg-eval/direct-structured.ts` is removed (#580).

## Consequences

- One place to change a prompt, a schema rule or an error mapping.
- A new package to version, release and document.
- Provider choice is a runtime concern; the domain never names a vendor.
- Output quality still differs per model and must be measured, not assumed.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep L2 in `apps/api` and copy it to Desktop | Violates [ADR-0001](0001-packages-first.md). |
| Let the Copilot SDK run the agent loop | It would own the prompt, tools and loop, so Ask would differ between hosts. |
| Hand-written provider clients per host | Duplicates request building; parity could not be tested. |

## Enforcement

- AI parity test (#580): both bindings build byte-identical provider requests for the same task.
- Conformance kit for `KVOX_AI` ([../specs/kvox-ports.md](../specs/kvox-ports.md)).
- Golden-set evaluation per provider and model.
- Review item: no model call outside the `KVOX_AI` port; no provider HTTP code outside the provider adapters.

## Related issues

#578, #579, #580, #581, #584.

## Status note (#580)

The hand-written OpenAI client `apps/api/scripts/kg-eval/direct-structured.ts` is deleted. The evaluation moved to the published package `@marinoscar/kvox-eval`; a live run goes through `createKvoxAi` over `createDirectRuntime`, and the golden set lives at `packages/kvox-eval/fixtures/kg-golden/`. The key is `KVOX_EVAL_OPENAI_API_KEY` (`KG_EVAL_OPENAI_API_KEY` and `ASK_EVAL_OPENAI_API_KEY` are deprecated aliases for one release). The request-level web versus direct parity check is the next part of #580.

Status note (#580, part 2): the request-level web versus direct parity proof is delivered. `@marinoscar/kvox-eval/parity` and the snapshots under `packages/kvox-eval/parity/` are compared by `packages/kvox-eval/test/parity.spec.ts` (direct binding) and `apps/api/test/kvox/ai-parity.spec.ts` (web binding); a change to a snapshot is a harness change and is explained in its PR ([TESTING.md](../TESTING.md#harness-parity)).

## Status note (#581)

Phase 2 ("go, without Ask") is implemented: `@marinoscar/kvox-ai/copilot`, an `AiProviderAdapter` over the GitHub Copilot SDK (`@github/copilot-sdk` 1.0.22, runtime 1.0.98, checked 2026-10-17), plugged into `createDirectRuntime`. The Ask loop is never moved into the SDK. The spike answered twelve questions:

| Q | Question | Answer | Consequence |
|---|---|---|---|
| Q1 | Can our system prompt replace the SDK's? | Yes (wire-verified). | `systemMessage.mode: 'replace'`. |
| Q2 | Can every built-in tool be disabled? | Yes: client `mode: 'empty'` and `availableTools: []`. | Zero tools; the adapter also reads the live tool list and aborts if it is not empty. |
| Q3 | Can one model step return tool calls and stop? | Partial. Stop works, but a session takes user messages only, so a tool step cannot be continued statelessly. | Copilot serves notes and graph extraction only. `toolCalling` is `false`. Ask stays on OpenAI. |
| Q4 | Streaming and finish reason? | Yes, with caveats: after `length` the runtime continues on its own; there is no per-call output cap for Copilot-hosted models. | The adapter aborts on `length`. `maxOutputTokens` is not sent. |
| Q5 | Native JSON-schema output? | GPT yes; Claude unverified. | Per-model `native` or `prompted`. The generic prompt, validate and one-repair path lives in kvox-ai and serves every adapter. |
| Q6 | Model list with limits? | Yes, after sign-in. | Live listing wins; a small versioned fallback catalog (`COPILOT_CATALOG_VERSION`) covers the rest. |
| Q7 | Usage per call? | Yes. | Token counts feed the usual usage record. |
| Q8 | Embeddings? | No. | Embeddings come from the OpenAI adapter, or are `null` and search is full text only. |
| Q9 | Sign-in managed by the SDK, no token through our code? | Yes (experimental APIs). | `gitHubToken` is never used. The key is `AI_KEYLESS_API_KEY`. Messages are redacted. |
| Q10 | Runtime binary? | One per platform, about 133 to 174 MB unpacked. | Bundle it in the Desktop packaging (D6); consider an optional download. |
| Q11 | Rate-limit and auth signals? | Partial: the runtime retries 429 and 401 itself; no retry-after on `session.error` in 1.0.22. | The adapter aborts on `model.call_failure`, so kvox-ai owns retries. A rate limit carries no `retryAfterMs`. |
| Q12 | Are the terms of use compatible? | The owner decides. | The adapter ships behind an opt-in: `createCopilotAdapter` throws unless `optIn === true`, and the Desktop setting defaults to off. Users are told notes go to GitHub and are pointed at the GitHub terms of service (section J, training opt-out). |

Also: the runtime persists prompts in its session state, so each call is one session, deleted in a `finally`, in an app-private `baseDirectory` with an empty `workingDirectory`. The SDK is an optional peer, loaded lazily by `createSdkCopilotTransport`, and the package root does not re-export the slice.

Decision: the integration sits at the provider-adapter layer, not the port layer. kvox-ai gains the shared pieces it needs: `structuredOutputMode` per model, the prompted structured path with one repair, per-model `toolCalling` in `capabilities()`, `wrapRecordingAdapter` and `scrub` coverage of `ghu_`, `ghs_` and `ghr_`. Guide: [KVox Desktop](../guides/kvox-desktop.md#the-copilot-provider-adapter).
