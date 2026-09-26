import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { JobsModule } from '../jobs/jobs.module';
import { NotesModule } from '../notes/notes.module';
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
import { KgPurgeService } from './purge/kg-purge.service';
import { GraphEvidenceService } from './read/graph-evidence.service';
import { GraphReadController } from './read/graph-read.controller';
import { GraphReadService } from './read/graph-read.service';
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
// `NotesModule` (#370) supplies `NoteAccessService`, which decides whether a
// citation's note is still readable by the caller. One way, like the others:
// nothing in NotesModule imports this module.
@Module({
  imports: [PrismaModule, JobsModule, TranscriptsModule, AiModule, NotesModule],
  providers: [
    GraphAccessService,
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
    GraphEvidenceService,
  ],
  controllers: [GraphController, GraphEntitiesController, GraphAttributeDefsController, GraphReadController],
  // `GraphWriteService` is the ONLY sanctioned write path for kg_entities,
  // kg_relations and kg_items (#355) — every later writer imports it from here.
  exports: [
    GraphAccessService,
    GraphOntologyService,
    EvidenceValidator,
    GraphWriteService,
    GraphReadService,
    GraphEvidenceService,
  ],
})
export class GraphModule {}
