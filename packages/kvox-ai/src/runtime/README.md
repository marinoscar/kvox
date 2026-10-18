# runtime

The interfaces a host supplies: one provider round trip, the task-model state and an optional model catalog.

## Purpose and scope

`KvoxAiRuntime` (`stream`, `create`, optional `embed`, `readiness`), `KvoxAiRuntimeCall`, `KvoxAiRuntimeRequest`, `KvoxAiRuntimeEmbedRequest`, `KvoxAiRuntimeEmbedResult`, `KvoxAiKeyReadiness`; `KvoxTaskModelSource` (`load`, optional `resolve`), `KvoxAiModelState`, `KvoxAiEnabledModel`, `KvoxTaskModelTarget`; `KvoxModelCatalog` and `KvoxModelInfo`. Where they deviate from the sketch in issue #579 (optional `orgId`, `jobId`, `provider` and `model` on the call; a whole-state `load` on the task source) the TSDoc says why: the web runtime must keep doing exactly what it does today. No key crosses any of them.

Status: interfaces (issue #579). `createKvoxAi` (`port` slice) implements `KvoxAiPort` over them; `createDirectRuntime` (`direct` slice) is the runtime of a host with no platform AI service; the web runtime is `PlatformAiRuntime` in `apps/api`.

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

`@marinoscar/platform-ai-providers` (as types: `AiResponseRequest`, `AiResponse`, `AiStreamEvent`). It imports the `types`, `features` and `tasks` slices.

## Configuration

None.

## Extension-point catalog

- `KvoxAiRuntime`: one provider round trip per call, and whether a key exists. Web: over the platform `AiService.forUser(...)` (gates, key resolution, one usage row per round trip, traces). Desktop: over the provider adapters, with a key from the OS keychain.
- `KvoxTaskModelSource`: the policy, the active provider and its enabled models. Web: system settings and the `ai_models` rows. Desktop: a local settings file.
- `KvoxModelCatalog`: optional per-model context window, output ceiling and capability flags.

### Desktop

Desktop implements `KvoxAiRuntime` with `createDirectRuntime` (`direct` slice) and `KvoxTaskModelSource` over its settings file.
