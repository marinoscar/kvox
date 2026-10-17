# @marinoscar/kvox-api

The NestJS side of the KVox domain: the host ports a slice needs, their in-memory fakes and the domain slices (transcription, search, transcripts, notes and the three graph slices so far). CommonJS, built with `tsc` and decorator metadata.

## Purpose and scope

The domain's server code in slices, one subpath per slice, so a second host (KVox Desktop) can install it without the web edition. A slice imports only `@marinoscar/kvox-api/ports` and `@marinoscar/kvox-contract`, never `@marinoscar/platform-*`: the web edition binds the platform to the ports in the app (`apps/api/src/platform-kvox/`), which keeps the package host-neutral (rule `host-neutral`, [PACKAGES.md](../../docs/PACKAGES.md#the-host-neutral-rule)).

Status: ports, core and testing are in place (issue 5.4); `transcription` (issue #492, epic #491), `search` (issue #494), `transcripts` (issue #493) and `notes` (issue #495) `graph`, `graph-extraction` and `graph-rdf` (issue #496) and `ask` (issue #497) are the domain slices: all six are in the package. Every declaration is `@stability experimental`.

- `@marinoscar/kvox-api/ports`: the ten host ports (AI, object store, jobs, identity, notify, events, Prisma, settings, secrets, audit) and their injection tokens. [README](src/ports/README.md).
- `@marinoscar/kvox-api/core`: `KvoxPortsModule`, `@KvoxAuth()` and `@KvoxAuthFromOptions()`, and the helpers the domain slices share (throttle key, token budget, stream flusher and SSE helpers, ETags, the `Prisma` SQL helper). [README](src/core/README.md).
- `@marinoscar/kvox-api/testing`: in-memory fakes of the ports and `describeKvoxPortsConformance`. [README](src/testing/README.md).
- `@marinoscar/kvox-api/transcription`: `TranscriptionModule.forRoot`, the provider contract and registry, the AssemblyAI provider, the settings and capability services and controllers. [README](src/transcription/README.md).
- `@marinoscar/kvox-api/transcription/testing`: `describeTranscriptionProviderConformance` and `createFakeTranscriptionProvider`. [README](src/transcription/README.md#conformance-suite).
- `@marinoscar/kvox-api/search`: `SearchModule.forRoot` (`GET /api/search`, the hybrid ranking, the degradation to full text) and `SearchIndexingModule.forRoot` (the `search.index` job, `SearchIndexService`, the two index routes), over the database, AI, jobs and identity ports. [README](src/search/README.md).
- `@marinoscar/kvox-api/search/testing`: `describeSearchConformance`, `seedSearchCorpus` and `sparseVector`. [README](src/search/README.md#conformance-suite).
- `@marinoscar/kvox-api/transcripts`: `TranscriptsModule.forRoot` (the upload, the nine job handlers, the correction, export, name-check and share routes, the pure editing core, the access rules and the sharing extension point) over the database, object store, jobs, notify, events, audit, AI, settings and secrets ports. [README](src/transcripts/README.md).
- `@marinoscar/kvox-api/transcripts/testing`: `describeTranscriptsConformance`, `describeTranscriptExporterConformance` and the export fixtures. [README](src/transcripts/README.md#conformance-suite).
- `@marinoscar/kvox-api/notes`: `NotesModule.forRoot` (the note, template, document-source and generation-stream routes, the six job handlers, the access rules, the three exporters and the ready event) over the database, object store, jobs, notify, events, audit, AI, settings and identity ports, on the transcripts and search slices. [README](src/notes/README.md).
- `@marinoscar/kvox-api/notes/templates`: the built-in note templates and the idempotent `seedNoteTemplates`, with no Nest import, for a seed script. [README](src/notes/README.md#quick-start).
- `@marinoscar/kvox-api/notes/testing`: `describeNotesConformance`, `describeNoteExporterConformance`, `createNotesServiceTestFactory` and the document and export fixtures. [README](src/notes/README.md#conformance-suite).
- `@marinoscar/kvox-api/graph`: `GraphModule.forRoot` (the single graph write path, the read layer, the access rules, the ontology and attribute services, the entity brief, the overview layout, the speaker link, `kg.migrate` and `kg.purge`) over the database, object store, jobs, events, audit, AI, settings and identity ports, on the transcripts, notes and search slices. [README](src/graph/README.md).
- `@marinoscar/kvox-api/graph/testing`: `describeGraphConformance` and the `internals` namespace. [README](src/graph/README.md#conformance-suite).
- `@marinoscar/kvox-api/graph-extraction`: `GraphExtractionModule.forRoot` (`kg.extract`, `kg.resolve`, `kg.embed`, the proposal stages and the review-and-commit routes, the ready-note subscription) on the graph and notes slices. [README](src/graph-extraction/README.md).
- `@marinoscar/kvox-api/graph-extraction/testing`: `describeGraphExtractionConformance` and the `internals` namespace the evaluation scripts import. [README](src/graph-extraction/README.md#conformance-suite).
- `@marinoscar/kvox-api/graph-rdf`: `GraphRdfModule.forRoot` (the OWL and SHACL artefacts, `kg.export`, `kg.import`) on the graph and graph-extraction slices. [README](src/graph-rdf/README.md).
- `@marinoscar/kvox-api/graph-rdf/testing`: `describeGraphRdfConformance` and the `internals` namespace. [README](src/graph-rdf/README.md#conformance-suite).
- `@marinoscar/kvox-api/ask`: `AskModule.forRoot` (saved conversations, the `ask.respond` job on `KVOX_AI.chat` with the seven read-only graph tools, the SSE view over the durable answer) on the graph, notes and search slices. [README](src/ask/README.md#purpose-and-scope).
- `@marinoscar/kvox-api/ask/testing`: `describeAskConformance`, `createScriptedChat`, the in-memory Ask tables, the tool fakes and the `internals` namespace. [README](src/ask/README.md#conformance-suite).

The web edition binds every port to a platform slice in `apps/api/src/platform-kvox/`; the contract in prose, with the Desktop mapping notes, is [docs/specs/kvox-ports.md](../../docs/specs/kvox-ports.md).

## Install and peer dependencies

```bash
npm install @marinoscar/kvox-api@next
```

Install these in the app; the package never bundles its own copy (a second copy of Nest breaks dependency injection). Import slices by their subpath. Which peers you need depends on the slices you import ([the rule](../../docs/PACKAGES.md#peer-dependencies-per-slice)).

Required by every slice (`ports`, `core`, `transcription`, `search`, `transcripts`, `notes`, `graph`, `graph-extraction`, `graph-rdf`, `ask`):

| Package | Range |
|---|---|
| `@marinoscar/kvox-contract` | `>=0.0.0-0 \|\| >=0.1.0-0` (any release; the four packages ship together, see [the contract peer range](../../docs/PACKAGES.md#the-contract-peer-range)) |
| `@nestjs/common` | `^11.1.12` |
| `@nestjs/core` | `^11.1.12` |
| `reflect-metadata` | `^0.2.2` |
| `rxjs` | `^7.8.1` |
| `zod` | `^4.4.3` |

Optional peers, installed for the features that need them. The three marked "loaded on first use" are required lazily, so importing `core` never needs them:

| Package | Range | Needed by |
|---|---|---|
| `@nestjs/swagger` | `^11.2.5` | `core`: the default bearer-auth marker `documentKvoxAuth` applies (loaded on first use); `transcription`, `search`, `transcripts`, `notes` and the graph slices: the controllers' OpenAPI decorators (required by those slices) |
| `@nestjs/event-emitter` | `^3.0.1` | `core`: `KvoxPortsModule` shares Nest's `EventEmitter2` as the default `KVOX_EVENTS` (loaded on first use); listeners |
| `@nestjs/schedule` | `^6.1.0` | `transcripts`, `notes`, `graph` and `graph-rdf`: the housekeeping, `kg.migrate` and export-expiry crons (loaded only when `schedules` is not `false`) |
| `fastify` | `^5.0.0` | `transcripts`, `notes` and `graph-rdf`: the request and reply types of the conditional reads and the upload (types only) |
| `pdfkit` | `>=0.17.0` | `transcripts` and `notes`: the PDF exporter (loaded when a PDF is rendered) |
| `docx` | `>=9.0.0` | `notes`: the Word exporter (loaded when a document is rendered) |
| `unpdf` | `>=1.0.0` | `notes`: reading a PDF source (loaded when one is extracted) |
| `nestjs-zod` | `^5.4.0` | `transcription`, `search`, `transcripts`, `notes` and the graph slices: the DTO classes (required by those slices) |
| `graphology`, `graphology-communities-louvain`, `graphology-layout`, `graphology-layout-forceatlas2` | `>=0.26.0`, `>=2.0.2`, `>=0.6.1`, `>=0.10.1` | `graph`: the overview layout (loaded when a layout is computed) |
| `n3`, `jsonld` | `>=2.7.0`, `>=9.0.0` | `graph-rdf`: parsing and serialising RDF (loaded when a file is parsed or written) |
| `rdf-validate-shacl` | `>=0.6.0` | `graph-rdf`: SHACL validation of an import (ESM-only, run in a child process) |
| `@prisma/client-runtime-utils` | `^7.8.0` | `core`: the `Prisma.sql`, `raw` and `join` helpers (loaded on first use) |
| `@marinoscar/platform-api` | `0.1.0-next.5` | no slice: host wiring only (`apps/api/src/platform-kvox`) |

Host plugin (not a peer, nothing imports it): `@fastify/multipart@^10.0.0` for `transcripts` (transcript import), `notes` (document-source upload) and `graph-rdf` (RDF import), hence also `graph`, `graph-extraction` and `ask`. Install it and `register` it on the Fastify app; without it the upload routes answer 500 naming the plugin. Declared as `$hostPlugins` and checked by `check-slice-peers` rule 8.

The per-slice data is `packages/kvox-slice-peers.json`; `node scripts/kvox-packages/check-slice-peers.mjs --table` prints it.

## Quick start

A host binds the ports once; a slice then injects a token and imports nothing of the host.

```ts
import { KvoxPortsModule } from '@marinoscar/kvox-api/core';

@Module({
  imports: [
    KvoxPortsModule.forRoot({
      ports: {
        ai: { useClass: MyAiAdapter },
        objectStore: { useClass: MyObjectStoreAdapter },
        jobs: { useClass: MyJobsAdapter },
        identity: { useClass: MyIdentityAdapter },
        notify: { useClass: MyNotifyAdapter },
        prisma: { useExisting: PrismaService },
        settings: { useClass: MySettingsAdapter },
        secrets: { useClass: MySecretsAdapter },
      },
    }),
  ],
})
export class AppModule {}
```

A route is protected with `KvoxAuth('transcripts:read')` and reads the caller with `CurrentKvoxPrincipal()`. A test builds a module of fakes with `createKvoxTestingModule` from `@marinoscar/kvox-api/testing`. See the [ports README](src/ports/README.md).

A slice is one more import, configured once:

```ts
import { TranscriptionModule } from '@marinoscar/kvox-api/transcription';

const TranscriptionConfig = TranscriptionModule.forRoot({
  providers: { assemblyai: true },
  permissions: { settingsRead: 'system_settings:read', settingsWrite: 'system_settings:write', configRead: 'transcripts:read' },
});
```

See the [transcription README](src/transcription/README.md#quick-start).

## Configuration

`KvoxPortsModule.forRoot({ ports })` is the one entry for the ports; each slice has its own `forRoot` (`TranscriptionModule.forRoot({ providers, extraProviders, permissions })`, see its [configuration](src/transcription/README.md#configuration)). `KvoxPortsModule.forRoot` takes eight required port bindings (`ai`, `objectStore`, `jobs`, `identity`, `notify`, `prisma`, `settings`, `secrets`), two optional (`events`, `audit`) and the `imports` the bound classes need. A missing required binding is a start-up error naming the port. The package reads no environment variable.

## Extension-point catalog

What a host implements, binds or registers. The per-port table (web adapter path and Desktop mapping) is in the [ports README](src/ports/README.md#extension-point-catalog).

| Symbol | Slice | What it is |
|---|---|---|
| `KVOX_AI`, `KvoxAiPort` | ports | Model calls: streamed text, structured output, tool-calling chat, embeddings, capabilities. |
| `KVOX_OBJECT_STORE`, `KvoxObjectStorePort` | ports | Resumable upload, put, read, signed URL, delete, upload-completed hook. |
| `KVOX_JOBS`, `KvoxJobsPort`, `KvoxJobHandler` | ports | Enqueue with dedup, handler registration; what a slice registers. |
| `KVOX_IDENTITY`, `KvoxIdentityPort` | ports | Authenticate a request into a normalised principal. |
| `KVOX_NOTIFY`, `KvoxNotifyPort` | ports | Declare notification events and raise them, detached. |
| `KVOX_EVENTS`, `KvoxEventsPort` | ports | In-process domain events (optional). |
| `KVOX_PRISMA`, `KvoxPrismaClientLike` | ports | The host's Prisma client, seen structurally. |
| `KVOX_SETTINGS`, `KvoxSettingsPort` | ports | Versioned system namespaces and per-user namespaces. |
| `KVOX_SECRETS`, `KvoxSecretsPort` | ports | Provider keys the domain owns; `status` never returns material. |
| `KVOX_AUDIT`, `KvoxAuditPort` | ports | Audit rows (optional). |
| `KVOX_BRAND` | core | The product name and footer line `KvoxPortsModule.forRoot({ brand })` provides to the PDF exporter. |
| `KvoxPortsModule`, `KvoxPortBindings` | core | The global module a host calls `forRoot` on to bind the ports. |
| `KVOX_AUTH_PERMISSIONS` | core | The token under which a slice module provides its option-name to permission-string map; `KvoxAuthFromOptions` routes resolve through it. |
| `setKvoxAuthDocumenter` | core | The hook a host uses to describe an authenticated route in its API document; `documentKvoxAuth` applies it. |
| `TranscriptionModuleOptions.extraProviders`, `TranscriptionProvider` | transcription | Register another speech-to-text provider; it must pass the conformance kit. |
| `describeTranscriptionProviderConformance`, `TranscriptionConformanceOptions.scenarios` | transcription/testing | The provider conformance kit and the failing upstreams its author wires in. |
| `SearchTranscriptVisibility`, `SEARCH_TRANSCRIPT_VISIBILITY`, `SearchModuleOptions.transcriptVisibility` | search | The host's rule for which transcripts a caller may see (the default is the owner's; the web edition adds shares). |
| `describeSearchConformance`, `seedSearchCorpus` | search/testing | The search conformance kit and the fixture corpus for a real-database spec. |
| `TranscriptsModuleOptions`, `TranscriptSharing`, `OwnerOnlyTranscriptSharing` | transcripts | The options of `TranscriptsModule.forRoot` and the host's sharing system (the default is owner-only; the web edition binds the platform's grants). |
| `TranscriptExporter`, `TRANSCRIPTS_PERMISSIONS`, `TRANSCRIPTS_NOTIFICATION_EVENTS`, `KvoxTranscriptsDb`, `TranscriptsHousekeepingEnqueuer` | transcripts | A new export format, the permission set and the notification events the host registers, the narrowed database client and the housekeeping entry for a host without a scheduler. |
| `describeTranscriptsConformance`, `describeTranscriptExporterConformance` | transcripts/testing | The pipeline-invariant kit and the exporter kit. |
| `NotesModuleOptions`, `NOTE_READY_EVENT` | notes | The options of `NotesModule.forRoot` and the domain event (`kvox.notes.note_ready`) a host subscribes to on `KVOX_EVENTS` to react to a ready note. |
| `NoteExporter`, `NOTES_PERMISSIONS`, `NOTE_TEMPLATES_PERMISSIONS`, `NOTES_NOTIFICATION_EVENTS`, `KvoxNotesDb` | notes | A new note export format, the permission sets and the notification events the host registers, and the narrowed database client. |
| `NOTE_BUILTIN_TEMPLATES`, `seedNoteTemplates` | notes/templates | The built-in templates and their idempotent seed, for a seed script. |
| `NotesUserDataService`, `NotesHousekeepingEnqueuer`, `NoteExportHandler`, `NotePurgeHandler`, `NoteRetitleHandler`, `NotesHousekeepingHandler` | notes | What a deletion would remove and how derived notes are unlinked, the housekeeping entry for a host without a scheduler, and the job handlers a host that composes its own module lists. |
| `describeNotesConformance`, `describeNoteExporterConformance` | notes/testing | The pipeline-invariant kit and the exporter kit. |
| `GraphModuleOptions`, `GRAPH_PERMISSIONS`, `KvoxGraphDb`, `GraphUserDataService` | graph | The options of `GraphModule.forRoot`, the permission set the host registers, the narrowed database client and what a deletion would remove. |
| `KgMigrateEnqueuer`, `KG_MIGRATE_OWNERS_PER_TICK` | graph | The `kg.migrate` scheduler without its timer: a host with `schedules: false` resolves the class from the container and calls `enqueue()` on its own timer. |
| `graphPreferencesSchema`, `mergeGraphPreferences`, `assertGraphPreferenceLimits` | graph | What the host's `graph` per-user settings namespace is built from. |
| `GraphExtractionModuleOptions`, `ProposalStage`, `ProposalStageRegistry` | graph-extraction | The options of `GraphExtractionModule.forRoot` and the proposal-stage extension point. |
| `GraphRdfModuleOptions`, `ShaclEngine` | graph-rdf | The options of `GraphRdfModule.forRoot` and the SHACL engine a test replaces. |
| `AskModuleOptions`, `AskUserDataService`, `KvoxAskDb` | ask | The options of `AskModule.forRoot` (the turn's caps, which a host may only lower, and the stream's pacing), the account-data deletion for a host without a planner and the narrowed database client the host's client must satisfy. |
| `describeAskConformance`, `createScriptedChat` | ask/testing | The turn-invariant kit (run it against your `KVOX_AI` adapter) and the scripted model. |
| `describeGraphConformance`, `describeGraphExtractionConformance`, `describeGraphRdfConformance` | graph/testing, graph-extraction/testing, graph-rdf/testing | The invariant kits of the three graph slices. |

## Data

None declared by the package itself: the schema is `@marinoscar/kvox-db`'s and slices see rows through structural types. The search slice works on `search_chunks`, `search_embeddings` (`vector(1536)`, HNSW) and `search_index_state`, and reads the generated `tsvector` columns of the transcripts and notes tables with raw SQL ([the Data section](src/search/README.md#data)). The transcripts slice works on the seven transcript tables and reads `users`, `organizations` and `notes` ([the Data section](src/transcripts/README.md#data)). The notes slice works on `notes`, `note_templates`, `user_hidden_note_templates`, `note_generations`, `note_versions` and `note_exports` and reads `transcripts` and `transcript_versions` ([the Data section](src/notes/README.md#data)). The graph slices work on the fifteen `kg_*` tables and read the transcript and note tables ([the graph Data section](src/graph/README.md#data)).

## Permissions and settings

The package declares no permission string. `KvoxAuth` checks the strings a route names against the principal the host returns, and `KvoxAuthFromOptions` takes them from the slice's options; the host declares them (`apps/api/src/app-registrations/permissions.ts`, and `kvox-permissions.ts` for a slice's own set). The transcription slice enforces three: `system_settings:read` and `system_settings:write` (the admin settings routes) and `transcripts:read` (the capability probe), the defaults of its `permissions` option. Settings: the `transcription` system namespace (declared by the slice through the settings port) and the `graph` user namespace; the web adapter verifies a namespace is already in the platform registry rather than declaring one late. Secrets: the `transcription` purpose, one secret per provider id. The search slice declares no permission, setting or secret: its three routes are `@KvoxAuth()` with no permission string and the service narrows by `transcripts:read` and `notes:read` from the principal ([why](src/search/README.md#permissions-and-settings)); the job type `search.index` is permanent and server-only. The transcripts slice enforces `transcripts:read` and `transcripts:write` (exported as `TRANSCRIPTS_PERMISSIONS` for the host to register), raises the notification events `transcripts.transcript_ready` and `transcripts.transcript_failed`, and owns nine permanent job types, all server-only except `media.audio.transcode` ([the lists](src/transcripts/README.md#permissions-and-settings)). The notes slice enforces `notes:read`, `notes:write`, `note_templates:read` and `note_templates:write` (exported as `NOTES_PERMISSIONS` and `NOTE_TEMPLATES_PERMISSIONS`), raises the notification events `notes.note_ready` and `notes.note_failed`, publishes `kvox.notes.note_ready`, and owns six permanent job types, all server-only except `note.source.extract` ([the lists](src/notes/README.md#permissions-and-settings)). The graph slices enforce `graph:read` and `graph:write` (exported as `GRAPH_PERMISSIONS`), own the `graph` per-user namespace, and own ten permanent job types, all server-only: `kg.speaker_link`, `kg.purge`, `kg.graph_layout`, `kg.migrate`, `kg.entity_digest`, `kg.extract`, `kg.resolve`, `kg.embed`, `kg.export` and `kg.import` ([the graph lists](src/graph/README.md#permissions-and-settings)).

## UI

None. The pages are in `@marinoscar/kvox-web`.

## Infra

None. The package ships no deployment configuration and reads no environment variable.

## Observability

None in the package: it emits no log line of its own beyond a warning when an event listener fails. The web adapters wrap every promise-returning call in the platform `@Trace()` so spans keep their names (`PlatformKvoxJobsAdapter.enqueue`); the streaming AI methods are not wrapped, because the platform AI slice already traces each round trip. The search slice emits no span of its own and reads no telemetry package: it tells the host why the semantic arm is off through the `semantic.onSemanticOff` option (the web edition records the span attribute `search.semantic_reason`, prefixed with its slug, a label value and never a metric label), and it logs a warning once per model and width when the host's embeddings cannot be stored (`vector(1536)`).

## Security notes

A slice never reads a provider key itself: AI and secrets go through ports the host binds (the transcription slice reads its provider key through `KVOX_SECRETS.get` only at the moment of a provider call and never logs, returns or audits it). **A key never crosses the AI port**: the context carries a user id, and the adapter resolves the key and drops it; the conformance suite asserts no event, error message or capability holds a key-shaped string. `KvoxAuthGuard` takes permissions only from the normalised principal, never from a raw user object, and answers 401 with no principal and 403 for a missing permission; per-resource access stays the service's 404-not-403 rule. `notify` is detached and never throws. `status` of a secret never returns material. The package carries no secret.

## Conformance suite

`describeKvoxPortsConformance(name, factory, { describe, it, expect })` from `@marinoscar/kvox-api/testing` is the executable proof a binding is correct, under Jest or Vitest. It checks, per port: AI errors are `KvoxAiError`s of a known class and carry no key, a text stream or chat step ends with exactly one `done`, no text follows a tool call, embeddings are one vector per input at the reported width; the object store round-trips bytes, takes a 6 MiB stream, signs, deletes idempotently and fires `onUploaded` and `onAborted` once, is idempotent on a key and describes the objects it holds; jobs dedup, honour `skipDedup`, list their active jobs (`findActive`), report a settled job (`onSettled`), hand out distinct temp paths, run a registered handler and report an unknown type unregistered; identity answers `null` without credentials and a `ReadonlySet` of permissions with them; `notify` returns at once; settings and secrets round-trip and `status` never returns material. The in-memory fakes pass it (`test/ports-conformance.spec.ts`) and so do the web adapters (`apps/api/test/platform-kvox/ports-conformance.spec.ts`). A Desktop author runs it against their own adapters. Each slice adds its own suite under its `/testing` entry: `describeSearchConformance` holds a search binding to the contract (`search.index` registered and server-only, the query path never throws for any model failure, a host without 1536-wide embeddings answers full text with `embeddings_unavailable`, a cursor of another caller refused, a one-permission caller answered partially); `describeTranscriptsConformance` holds a transcripts binding to the pipeline invariants (the nine pinned job types, the poll re-enqueue passing `skipDedup`, the name check server-only and tried once, only the transcode node-eligible) and `describeTranscriptExporterConformance` holds an exporter to its contract; `describeGraphConformance`, `describeGraphExtractionConformance` and `describeGraphRdfConformance` hold the graph bindings to their invariants (the ten pinned `kg.*` job types and profiles, only `GraphWriteService` creating a graph row, a sensitive PersonFact never reaching a model or an embedder, no access answering 403, a rate limit on the user's own bucket, an export validating against the generated SHACL and mapping back onto a proposal); `describeTranscriptionProviderConformance` holds a transcription provider to the contract (identity, capabilities, a form without secrets, a context that never serialises its key, and, per failing upstream the author supplies, 401 to `ProviderAuthError`, 429 to `RateLimitError`, a rejected input to `ProviderInputError`). The tests run in two Jest projects, `unit` (`npm run test:run -w @marinoscar/kvox-api`) and `db` against a real PostgreSQL with pgvector (`npm run test:host:prepare -w @marinoscar/kvox-api`, then `npm run test:db -w @marinoscar/kvox-api`); the test host is described in `test/host/README.md`. The host-side proof is `examples/bare-host` (issue #505): a Nest application that installs the packed tarballs of `@marinoscar/kvox-contract`, `-db` and `-api` without `@marinoscar/platform-api`, binds every port to a small local implementation, migrates a PostgreSQL (a pgvector container, then PGlite) and drives the transcription, search, transcripts and notes slices through one recording end to end; CI runs it on both databases ([the example](../../examples/bare-host/README.md)).

## Upgrade notes

This package has not been published yet (see the [release runbook](../../docs/runbooks/release-kvox-packages.md)), so there is nothing to migrate from. Within the repository: `KvoxAuth` and `KvoxAuthFromOptions` no longer attach an OpenAPI marker themselves, the owning module's `forRoot` does (`documentKvoxAuth`), so a controller used outside a slice module is not documented as authenticated until `documentKvoxAuth` is called for it; the settings, secrets and rate-limit ports gained optional members only. The transcripts slice (issue #493) added to the ports, additively: `KVOX_JOBS` gained `onSettled`, `findActive` and `tempPath` and a handler may declare `throttleKey`, `deriveOutputKey` and `nodeOffloadEnabled`; `KVOX_OBJECT_STORE` gained `adopt`, `describe` and `onAborted`, `put` takes a `name` and `metadata` and is idempotent on its key, and `initUpload` returns `uploadId` and `totalParts` and takes `allowedMimeTypes`; `KVOX_PRISMA`'s `$transaction` takes options and an array form; `KVOX_AI.resolveTask` takes `requireKey`; and `KvoxPortsModule.forRoot` takes an optional `brand` (`KVOX_BRAND`) for the PDF footer. The graph slices (issue #496) added, additively: `KVOX_JOBS` gained `findLatest` and `runNow` (a job's latest snapshot and an immediate run); `KVOX_OBJECT_STORE` gained `listManaged` (the ids of an owner's objects under a key prefix); `KVOX_PRISMA`'s transaction options take `maxWait`; `KVOX_AI`'s context takes a `jobId`, `generateStructured` takes a strict `jsonSchema` and `maxOutputTokens`, and `KvoxAiError` gained the classes `truncated` and `invalid_output` and a `usage` field. A host that implements the ports must add the new members ([the spec](../../docs/specs/kvox-ports.md)). In the API the moved helpers keep their old import paths as re-exports (`notes/job-types.ts`, `notes/generation/{stream-flusher,note-stream}.ts`, `ai-port/ai-token-budget.ts`); new code imports `@marinoscar/kvox-api/core`. The bare-host smoke app (issue #505) fixed two things a second host hit: the declaration files of the two PDF exporters named pdfkit's types, so a host that left the optional peer out failed `skipLibCheck: false` (the exported drawing helpers now take `KvoxPdfDocument`, an `object`, from `core`), and resolving a provider registered through `extraProviders` failed because it has no stored settings block (it now gets an empty one, as the connection test already did).

## Troubleshooting

`Nest can't resolve dependencies` with two Nest copies in `node_modules`: run `node scripts/kvox-packages/check-single-instance.mjs` and align the ranges.

`KvoxPortsModule.forRoot: no binding for port KVOX_JOBS (ports.jobs)`: a required port is unbound; add it to `ports`.

`Building raw SQL needs the optional peer dependency @prisma/client-runtime-utils`: install it next to `@prisma/client`.

`No permission is configured for the option "settingsRead"` (a 500 on a `KvoxAuthFromOptions` route): the module that owns the controller does not provide `KVOX_AUTH_PERMISSIONS`; use the slice's `forRoot`.

`Cannot find module './generated/client.js'` in a `*.db.spec.ts`: run `npm run test:host:prepare -w @marinoscar/kvox-api` first; it needs no database.

A job handler refused with "server-only": an AI handler declared `nodeResultSchema`; AI work spends the user's own key and stays on the server.

Search answers `semantic: false` with `embeddings_unavailable` on a host that should have embeddings: `KVOX_AI.capabilities().embeddings` is `null`, or its `dimensions` is not 1536 (the log has one warning naming the model and the width). The index column is `vector(1536)`; a different width is a migration in `@marinoscar/kvox-db`, never a truncation. Search finds nothing for a caller who owns documents: with the default `OwnerOnlyTranscriptVisibility` only the caller's own transcripts are visible, so a host that shares transcripts passes its own `transcriptVisibility`.

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Release runbook](../../docs/runbooks/release-kvox-packages.md): versions, publishing, rollback
- [Bare-host smoke app](../../examples/bare-host/README.md): a host that is not the web edition, and the local port implementations Desktop starts from
- [DEVELOPMENT.md](../../docs/DEVELOPMENT.md): build, test and lint commands

### Desktop

The main process of KVox Desktop installs this package. The guide lists the ten ports to implement, the module wiring (`KvoxPortsModule.forRoot`, one `forRoot` per slice), the Copilot SDK `KVOX_AI` sketch and the offline behaviour of every feature, and names the conformance kits to run against your adapters. See [the KVox Desktop guide](../../docs/guides/kvox-desktop.md#ports-to-implement).
