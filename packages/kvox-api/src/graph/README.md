# graph

The connected-knowledge core: entities, relations, facts and the evidence that anchors every claim, with the single write path, the read layer, the access rules, the ontology and attribute services, the entity brief, the whole-graph overview, the speaker link, `kg.migrate`, `kg.purge` and the routes in front of them, as one Nest module a host configures with `GraphModule.forRoot`.

## Purpose and scope

What the slice owns: `GraphWriteService`, the only sanctioned way to create a `kg_entities`, `kg_relations` or `kg_items` row (`kg.migrate` is the one named exception and reshapes rows it already owns); `EvidenceValidator` (every claim carries evidence the caller may still read); the read layer (`GraphReadService`, `GraphNeighborhoodService`, `GraphEvidenceService`, as-of reads); `GraphAccessService` (no access answers 404, never 403); the effective ontology and the user's attribute definitions; the `graph` per-user preferences (`GraphPreferencesService`, the merge and the limits); the entity brief and its `kg.entity_digest` job (the only producer of brief prose); the whole-graph overview (`kg.graph_layout`, computed by ForceAtlas2 and Louvain in a job); the speaker link (`kg.speaker_link`: naming a speaker creates a Person and an `IDENTIFIED_AS` edge); `kg.migrate` (reshaping rows on an ontology bump) and its cron; `kg.purge` and `GraphUserDataService` (forget a person, the Danger Zone's `graph` category); the structural database types (`data/graph-db.ts`) and the permission strings as data (`GRAPH_PERMISSIONS`). What it does not own: the tables themselves (installed by `@marinoscar/kvox-db`), the extraction, resolution and proposal pipeline (the `graph-extraction` slice), RDF export and import (`graph-rdf`), anything that needs the platform (the permission registry, the user-data registry, the settings manifest, the notification layer), and the AI provider keys (the host's AI adapter resolves them per call, per user).

Status: experimental (issue #496). Every export carries `@stability experimental`.

### Quick start

```ts
import { GraphModule } from '@marinoscar/kvox-api/graph';
import { NotesModule } from '@marinoscar/kvox-api/notes';
import { SearchModule } from '@marinoscar/kvox-api/search';
import { TranscriptsModule } from '@marinoscar/kvox-api/transcripts';

const transcripts = TranscriptsModule.forRoot();
const notes = NotesModule.forRoot({ peers: { transcripts } });
const search = SearchModule.forRoot();

@Module({
  imports: [
    transcripts,
    notes,
    search,
    GraphModule.forRoot({
      peers: { transcripts, notes, search },
      migrate: { scheduleEnabled: () => process.env.KG_MIGRATE_SCHEDULE_ENABLED !== 'false' },
    }),
  ],
})
export class DomainModule {}
```

The host binds `KVOX_PRISMA`, `KVOX_OBJECT_STORE`, `KVOX_JOBS`, `KVOX_EVENTS`, `KVOX_AUDIT`, `KVOX_AI`, `KVOX_SETTINGS`, `KVOX_IDENTITY` and `KVOX_BRAND` first (`KvoxPortsModule.forRoot`) and registers `GRAPH_PERMISSIONS`. The `graph` per-user settings namespace is declared through the settings port when the module starts. The module never provides a notes class: it reads `NoteAccessService` from the notes slice's own exports.

### Data

Fifteen tables, installed by `@marinoscar/kvox-db`: `kg_entities`, `kg_entity_aliases`, `kg_relations`, `kg_items`, `kg_evidence`, `kg_mentions`, `kg_proposals`, `kg_proposal_items`, `kg_merges`, `kg_distinct_pairs`, `kg_attribute_defs`, `kg_entity_digests`, `kg_entity_views`, `kg_exports` and `kg_graph_layouts`. It reads, and never writes, `transcripts`, `transcript_segments`, `transcript_speakers`, `notes` and `note_versions`. The `valid` (`tstzrange`) and `embedding` (`vector`) columns are not in the structural row types and are reached with raw SQL. The slice sees rows through `KvoxGraphDb` and imports no generated client; the host proves its client satisfies it with one compile-time assignment (`apps/api/test/kvox/prisma-shape.typecheck.ts`). The deferred `kg_assert_has_evidence` trigger refuses an accepted or edited row with no evidence at `COMMIT`.

### Permissions and settings

- Permissions: `graph:read` and `graph:write` (`GRAPH_PERMISSIONS`, org scope). The slice exports them as data and declares nothing to the host, which registers the set. Every route carries `@KvoxAuth` with one of them. There is no `graph:read_any`; a caller with no access gets a 404.
- Settings: the `graph` per-user namespace (`graphPreferencesSchema`; absent means defaults). The deployment's `ai` namespace (the graph switch, the spend caps) is read through the settings port.
- Job types (permanent, all server-only): `kg.speaker_link` (two minutes, three attempts), `kg.purge` (thirty minutes, ONE attempt, never retried automatically), `kg.graph_layout` (fifteen minutes, two attempts), `kg.migrate` (an hour, three attempts) and `kg.entity_digest` (five minutes, one attempt; it spends the owner's own AI key). A provider rate limit throws a `KvoxRateLimitError` on the user's own throttle bucket (`ai-provider:<userId>`).
- Domain events: `graph.changed` and `graph.preferences_changed` are published on `KVOX_EVENTS`; the slice itself subscribes to the first (to refresh the overview) and to the transcripts slice's speaker event.

### Security notes

A `sensitive` PersonFact never leaves the deployment: it is dropped from the brief's fact list before a prompt is built. No access answers 404, never 403, and a malformed id is the same answer. Every graph write goes through `GraphWriteService`; the conformance suite scans the slice for any other creator. A cron only enqueues. `notify()`-style side effects run after the write commits. No log line or error carries a provider key. Every enqueue states its organization through the jobs port.

### Conformance suite

`describeGraphConformance(name, build, { describe, it, expect })` from `@marinoscar/kvox-api/graph/testing` holds a binding to the core's invariants: the five job types are registered, server-only and carry their pinned profile, only the entity digest spends the owner's key, only `GraphWriteService` creates a graph row, a sensitive PersonFact never reaches a model call, and no access answers 404. The package runs it (`test/graph-module.spec.ts`); the web application runs it over its own binding (`apps/api/test/conformance.spec.ts`).

## Entry point

`@marinoscar/kvox-api/graph` and, for tests and evaluation scripts, `@marinoscar/kvox-api/graph/testing` (the conformance suite and an `internals` namespace tagged `@internal`). The slice depends on `ports`, `core`, `testing`, `transcripts`, `notes` and `search` (`packages/kvox-slices.json`), and imports `@marinoscar/kvox-contract/graph` and `/ontology` for the wire schemas and the registry.

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common`, `@nestjs/core` and `zod`, which every slice needs, plus `@nestjs/swagger` and `nestjs-zod` (the controllers' OpenAPI decorators and DTO classes), `@nestjs/schedule` (the `kg.migrate` cron; loaded only when `schedules` is not `false`), and the optional layout libraries `graphology`, `graphology-communities-louvain`, `graphology-layout` and `graphology-layout-forceatlas2` (loaded when an overview layout is computed). The per-slice data is `packages/kvox-slice-peers.json`.

## Configuration

`GraphModule.forRoot(options)` returns a non-global dynamic module. It exports the write, access, read, ontology, preferences, brief and attribute services the other graph slices use, plus `GraphUserDataService`. The package reads no environment variable.

| Option | Default | What it does |
|---|---|---|
| `schedules` | `true` | `false` registers no `@nestjs/schedule` task; the host calls `KgMigrateEnqueuer.enqueue()` on its own timer. |
| `layout` | `{ coalesceMs: 120000, materialChange: 0.2 }` | How the overview layout is scheduled after a change. |
| `migrate.scheduleEnabled` | always | Read at every tick; false queues no migration. |
| `imports` | none | Extra modules the slice's providers need. |
| `peers` | fresh `TranscriptsModule`, `NotesModule`, `SearchModule` | The very module objects the host imports, so the container sees one module and registers each handler once. |

## Extension-point catalog

| Symbol | What a host does with it |
|---|---|
| `GraphModuleOptions` | The options of `GraphModule.forRoot`. |
| `GRAPH_PERMISSIONS` | The two permission strings and their default grants, for the host to register with its permission catalog. |
| `KvoxGraphDb` | The narrowed client the slice casts `KVOX_PRISMA` to; the host proves its client satisfies it with a compile-time assignment. |
| `GraphUserDataService` | What a deletion would remove and the enqueue of `kg.purge`; the host's user-data registry delegates to it. |
| `graphPreferencesSchema`, `mergeGraphPreferences`, `assertGraphPreferenceLimits` | What the host's `graph` user-settings namespace is built from. |
| `describeGraphConformance` | The conformance kit and the binding it is run against. |

### Desktop

Desktop must declare `graphEnabled` in the system `ai` settings namespace for the graph to run, and installs the graph layout peers from the full set. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#install).
