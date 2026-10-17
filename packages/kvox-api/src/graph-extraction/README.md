# graph-extraction

The pipeline that turns a ready note into reviewed knowledge: extraction (`kg.extract`), entity resolution and merges (`kg.resolve`, `kg.embed`), work-item dedup, temporal closing and rejection memory, and the proposal review-and-commit routes, as one Nest module a host configures with `GraphExtractionModule.forRoot`.

## Purpose and scope

What the slice owns: `POST /api/graph/notes/:noteId/extract` and its estimate; the `kg.extract` handler (prompt assembly, the strict output schema, the truncation retry, validation, the pre-check); the proposal stage registry and its three stage families (resolution, work-item dedup, temporal closing, rejection memory); `kg.resolve` and `kg.embed`; merges and their reversal, distinct pairs and alias learning; the proposal queue, decisions, the commit (the general write path into the graph, through `GraphWriteService`) and the revert; the hand-off from a ready note (it subscribes to `kvox.notes.note_ready` on `KVOX_EVENTS`; the notes slice does not know the graph exists). What it does not own: the core graph services (the `graph` slice), RDF export and import (`graph-rdf`), the tables, and the AI provider keys. Nothing enters the graph except through a reviewed proposal's commit.

Status: experimental (issue #496). Every export carries `@stability experimental`.

### Quick start

```ts
import { GraphModule } from '@marinoscar/kvox-api/graph';
import { GraphExtractionModule } from '@marinoscar/kvox-api/graph-extraction';

const graph = GraphModule.forRoot({ peers: { transcripts, notes, search } });

@Module({
  imports: [graph, GraphExtractionModule.forRoot({ peers: { graph, notes }, embedding: { batchSize: 128 } })],
})
export class DomainModule {}
```

### Data

Works on `kg_proposals`, `kg_proposal_items`, `kg_mentions`, `kg_merges`, `kg_distinct_pairs` and the embedding columns of `kg_entities` and `kg_items` (`vector(1536)`), and reads the core graph tables. The `kg_proposals` partial unique indexes and the vector indexes exist only in `migration.sql`; the slice never declares them.

### Permissions and settings

- Permissions: `graph:read` and `graph:write` from the `graph` slice; the owner's `graph:write` is checked through the identity port before an automatic extraction is queued.
- Settings: none of its own. The `graph` per-user namespace holds the owner's `extraction.autoExtract`, `resolution` and `domains` preferences; the deployment's `ai` namespace holds the graph switch and the spend caps.
- Job types (permanent, all server-only, all spend the owner's own AI key): `kg.extract` (twenty minutes, ONE attempt), `kg.resolve` (twenty minutes, ONE attempt) and `kg.embed` (five minutes, three attempts). A provider rate limit throws a `KvoxRateLimitError` on the user's own bucket. Embeddings are optional: when the host has no 1536-dimension embeddings model the resolution works by name only.

### Security notes

A `sensitive` PersonFact is never embedded, never sent to an adjudication prompt, and a stale vector on one is cleared. The automatic extraction only enqueues, after the gate (the graph switch, `graph:write`, the owner's preference, a resolvable model); a failure is logged and swallowed because the note is already ready. Every row the pipeline proposes carries evidence, and the commit refuses a row whose evidence the owner can no longer read. No log line or error carries a provider key.

### Conformance suite

`describeGraphExtractionConformance(name, build, { describe, it, expect })` from `@marinoscar/kvox-api/graph-extraction/testing` holds a binding to the pipeline's invariants: the three job types are registered, server-only, flagged as AI and carry their pinned profile, a rate limit lands on the user's own bucket, a sensitive PersonFact is never embedded, the ready-note subscriber only enqueues, and the proposal stages run in their declared order. The package runs it (`test/graph-module.spec.ts`); the web application runs it over its own binding.

## Entry point

`@marinoscar/kvox-api/graph-extraction` and `@marinoscar/kvox-api/graph-extraction/testing` for tests and evaluation scripts (the conformance suite and an `internals` namespace tagged `@internal`: the pure functions the `kg-eval` scripts import). The slice depends on `ports`, `core`, `testing`, `graph`, `notes`, `search` and `transcripts` (`packages/kvox-slices.json`).

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common`, `@nestjs/core` and `zod`, which every slice needs, plus `@nestjs/swagger` and `nestjs-zod` (the controllers' OpenAPI decorators and DTO classes). The per-slice data is `packages/kvox-slice-peers.json`.

## Configuration

`GraphExtractionModule.forRoot(options)` returns a non-global dynamic module. The package reads no environment variable.

| Option | Default | What it does |
|---|---|---|
| `autoExtract` | `true` | Subscribe to `kvox.notes.note_ready` and extract a note that just became ready. False leaves extraction to the explicit route. |
| `embedding.batchSize` | `128` | The most texts one embeddings request carries (the host passes its model's limit). |
| `imports` | none | Extra modules the slice's providers need. |
| `peers` | fresh `GraphModule` and `NotesModule` | The very module objects the host imports. |

## Extension-point catalog

| Symbol | What a host does with it |
|---|---|
| `GraphExtractionModuleOptions` | The options of `GraphExtractionModule.forRoot`. |
| `ProposalStage`, `ProposalStageRegistry` | A new proposal stage is one class registered on the registry in `onModuleInit`; the handler runs stages in `order`. |
| `describeGraphExtractionConformance` | The conformance kit and the binding it is run against. |
