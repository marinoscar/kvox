// FIRST: sets how the routes are documented before `forRoot` documents them.
import '../auth-documenter';

import { Module } from '@nestjs/common';
import { GraphModule } from '@marinoscar/kvox-api/graph';
import { GraphExtractionModule } from '@marinoscar/kvox-api/graph-extraction';
import { GraphRdfModule } from '@marinoscar/kvox-api/graph-rdf';

import { KVOX_EMBEDDING } from '@marinoscar/kvox-ai';
import { GraphPreferencesChangeForwarder } from './graph-preferences-change.forwarder';
import { NotesConfig } from '../notes/notes.config';
import { SearchConfig } from '../search/search.config';
import { TranscriptsConfig } from '../transcripts/transcripts.config';

// =============================================================================
// The web edition's configuration of the graph slices (issue #496, epic #491)
// =============================================================================
//
// The only place this application configures `@marinoscar/kvox-api/graph`, `/graph-extraction` and
// `/graph-rdf`. Everything else the slices need comes from the ports `PlatformKvoxModule` binds
// (database, object store, jobs, events, audit, AI, settings, identity, brand).
//
//   peers        the transcripts, notes and search modules the graph reads through: the SAME objects
//                `KvoxModule` imports, so each is one module and its handlers register once. The graph
//                never provides a notes class (it reads `NoteAccessService` from the notes slice's own
//                exports) and the notes slice does not know the graph exists: a ready note reaches
//                `GraphExtractionModule` as the notes slice's ready event (`NOTE_READY_EVENT`) on the event port.
//   migrate      the `kg.migrate` hourly tick is on unless `KG_MIGRATE_SCHEDULE_ENABLED` is the literal
//                `false`, read at every tick (a deployment runs the tick on one process only).
//   embedding    the embeddings provider's batch ceiling, 128 (`embedding-catalog.ts`, `@marinoscar/kvox-ai`).
//   RDF          export and import are on, the upload ceiling and the schedules are the slice's defaults.
//
// What stays out of the slices and lives beside this file, because it uses the platform: the `graph`
// user-settings namespace and the forwarder that turns the platform's change announcement into the
// slice's event (`graph.user-settings.ts`, `graph-preferences-change.forwarder.ts`), and the Danger
// Zone's `graph` category and model hints (`user-data.ts`). The permissions the slice exports as data
// are registered in `app-registrations/kvox-permissions.ts`.
//
// Exported as constants because other modules (Ask, until it moves into the package) import them: a
// dynamic module built twice with the same options is one module, but one constant is the unmistakable
// way to say so.
// =============================================================================

export const GraphConfig = GraphModule.forRoot({
  peers: { transcripts: TranscriptsConfig, notes: NotesConfig, search: SearchConfig },
  migrate: { scheduleEnabled: () => process.env.KG_MIGRATE_SCHEDULE_ENABLED !== 'false' },
});

export const GraphExtractionConfig = GraphExtractionModule.forRoot({
  peers: { graph: GraphConfig, notes: NotesConfig },
  embedding: { batchSize: KVOX_EMBEDDING.maxBatchSize },
});

export const GraphRdfConfig = GraphRdfModule.forRoot({
  peers: { graph: GraphConfig, extraction: GraphExtractionConfig, transcripts: TranscriptsConfig, notes: NotesConfig },
});

/** The parts of the graph configuration that use the platform and so stay in the application. */
@Module({
  providers: [GraphPreferencesChangeForwarder],
})
export class GraphBindingModule {}
