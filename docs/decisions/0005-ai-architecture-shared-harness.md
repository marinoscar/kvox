# ADR-0005: AI architecture: one shared harness, pluggable providers

- Status: Accepted (implementation #579)
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
| L1 | Transport: provider adapters implementing `AiProviderAdapter` (OpenAI, OpenAI-compatible, Anthropic, Azure, Gemini) from `@marinoscar/platform-api/ai` | Platform; to be split into a lean provider package upstream (#578) | Shared |

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
