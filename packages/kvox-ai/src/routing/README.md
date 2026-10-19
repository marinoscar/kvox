# routing

Capability-based routing of the KVox tasks to a primary and a fallback provider.

## Purpose and scope

`KVOX_TASK_IDS` and `KvoxTaskId` (the port's feature vocabulary: `notes.generate`, `ask.respond`, `graph.embed`, ...), `KVOX_TASK_REQUIREMENTS` (`ask.respond` needs tool calling, `graph.embed` and `search.embed` need embeddings, every other task needs neither), `KvoxTaskModels`, `ProviderChoice` and `routeKvoxTasks`. A task goes to the primary provider when it can serve the task, else to the fallback when that can, else it is listed in `unavailable` with `needs_tool_calling` or `needs_embeddings`, so a host can hide the feature with a reason. Any provider without tool calling works, not only GitHub Copilot. Pure: no I/O, deterministic order, inputs not mutated.

The ids are not the `AiTaskKey`s of the [tasks](../tasks/README.md) slice (the narrower vocabulary of the stored `ai.taskModels` map); `featureOf` maps each of them to a registered feature id.

Status: new (issue #630).

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice). It never imports the Copilot SDK.

## Peer dependencies

None.

## Configuration

None. The providers are arguments.

## Extension-point catalog

None.

### Desktop

Pure; usable offline. Desktop passes Copilot as `primary` and, when the user saved an OpenAI key, OpenAI as `fallback`, and persists `taskModels`.
