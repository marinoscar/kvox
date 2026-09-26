import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { JobsModule } from '../jobs/jobs.module';
import { NoteAccessService } from '../notes/access/note-access.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TranscriptsModule } from '../transcripts/transcripts.module';
import { GraphAccessService } from './access/graph-access.service';
import { GraphAttributeDefsController } from './attribute-defs/graph-attribute-defs.controller';
import { GraphAttributeDefsService } from './attribute-defs/graph-attribute-defs.service';
import { GraphEntitiesController } from './graph-entities.controller';
import { GraphEntitiesService } from './graph-entities.service';
import { GraphController } from './graph.controller';
import { KgPurgeHandler } from './handlers/kg-purge.handler';
import { GraphOntologyService } from './ontology/graph-ontology.service';
import { GraphPreferencesService } from './preferences/graph-preferences.service';
import { KgPurgeService } from './purge/kg-purge.service';
import { GraphEvidenceService } from './read/graph-evidence.service';
import { GraphNeighborhoodService } from './read/graph-neighborhood.service';
import { GraphReadController } from './read/graph-read.controller';
import { GraphReadService } from './read/graph-read.service';
import { KgSpeakerLinkHandler } from './handlers/kg-speaker-link.handler';
import { SpeakerIdentifiedListener } from './listeners/speaker-identified.listener';
import { SpeakerLinkReconciler } from './speaker-link/speaker-link.reconciler';
import { EvidenceValidator } from './write/evidence-validator.service';
import { GraphWriteService } from './write/graph-write.service';

// =============================================================================
// GraphModule (#354, epic #344, docs/specs/ontology.md)
// =============================================================================
//
// The one module every connected-knowledge feature hangs its services,
// handlers and controllers on. Later issues add providers and controllers HERE
// and nowhere else, unless a sub-module is clearly warranted (e.g. #363 may add
// `graph/extraction/extraction.module.ts`, imported here).
//
// `TranscriptsModule` is imported now even though nothing here uses it yet:
// #355's evidence validation needs `TranscriptAccessService`, and settling the
// import list in the scaffold keeps parallel issues from each editing it.
// The dependency runs one way — nothing in TranscriptsModule imports this
// module — so no `forwardRef` is needed.
// =============================================================================

// `AiModule` (#355) supplies `AiSettingsService`, read for `ai.graphEnabled`
// before a guarded `kg.entity_digest` enqueue after a manual entity edit.
//
// `NoteAccessService` (#370) decides whether a citation's note is still
// readable by the caller. It is provided here rather than imported through
// `NotesModule`: NotesModule imports GraphExtractionModule (#363), which
// imports this module, so importing NotesModule back would be a cycle. The
// service needs only PrismaService — the same choice GraphExtractionModule makes.
@Module({
  imports: [PrismaModule, JobsModule, TranscriptsModule, AiModule],
  providers: [
    GraphAccessService,
    NoteAccessService,
    // #369 — the `graph` user-settings namespace, resolved with defaults.
    GraphPreferencesService,
    GraphOntologyService,
    EvidenceValidator,
    GraphWriteService,
    GraphEntitiesService,
    GraphAttributeDefsService,
    // #357 — `kg.purge`: forget-a-person and the Danger Zone's `graph` category.
    KgPurgeService,
    KgPurgeHandler,
    // #370 — the read layer (exported for the brief #372 and the Ask agent #377).
    GraphReadService,
    GraphNeighborhoodService,
    GraphEvidenceService,
    // #356: speaker naming → Person + IDENTIFIED_AS, via `kg.speaker_link`.
    SpeakerLinkReconciler,
    KgSpeakerLinkHandler,
    SpeakerIdentifiedListener,
  ],
  controllers: [GraphController, GraphEntitiesController, GraphAttributeDefsController, GraphReadController],
  // `GraphWriteService` is the ONLY sanctioned write path for kg_entities,
  // kg_relations and kg_items (#355) — every later writer imports it from here.
  exports: [
    GraphAccessService,
    GraphOntologyService,
    GraphPreferencesService,
    EvidenceValidator,
    GraphWriteService,
    GraphReadService,
    GraphNeighborhoodService,
    GraphEvidenceService,
  ],
})
export class GraphModule {}
