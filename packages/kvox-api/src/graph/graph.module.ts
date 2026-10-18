import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';

import { documentKvoxAuth } from '../core/index.js';
import { KVOX_SETTINGS, type KvoxSettingsPort } from '../ports/index.js';
import { NotesModule } from '../notes/index.js';
import { SearchModule } from '../search/index.js';
import { TranscriptsModule } from '../transcripts/index.js';
import { GraphAccessService } from './access/graph-access.service.js';
import { GraphAttributeDefsController } from './attribute-defs/graph-attribute-defs.controller.js';
import { GraphAttributeDefsService } from './attribute-defs/graph-attribute-defs.service.js';
import { EntityBriefController } from './brief/entity-brief.controller.js';
import { EntityBriefService } from './brief/entity-brief.service.js';
import { EntityDigestEnqueuer } from './brief/entity-digest.enqueuer.js';
import { EntityDigestHandler } from './brief/entity-digest.handler.js';
import { EntityViewService } from './brief/entity-view.service.js';
import { GraphAiRunResolver } from './graph-ai-run.service.js';
import { GraphEntitiesController } from './graph-entities.controller.js';
import { GraphEntitiesService } from './graph-entities.service.js';
import { GraphRelationEditsService } from './graph-relation-edits.service.js';
import { GraphObjectsService } from './graph-objects.service.js';
import {
  GRAPH_MODULE_OPTIONS,
  resolveGraphOptions,
  type GraphModuleOptions,
} from './graph.options.js';
import { GraphController } from './graph.controller.js';
import { KgPurgeHandler } from './handlers/kg-purge.handler.js';
import { KgSpeakerLinkHandler } from './handlers/kg-speaker-link.handler.js';
import { GraphLayoutEnqueuer } from './layout/graph-layout.enqueuer.js';
import { KgGraphLayoutHandler } from './layout/graph-layout.handler.js';
import { GraphLayoutListener } from './layout/graph-layout.listener.js';
import { GraphOverviewController } from './layout/graph-overview.controller.js';
import { GraphOverviewService } from './layout/graph-overview.service.js';
import { SpeakerIdentifiedListener } from './listeners/speaker-identified.listener.js';
import { KgMigrateEnqueuer } from './migrate/kg-migrate.enqueuer.js';
import { KgMigrateHandler } from './migrate/kg-migrate.handler.js';
import { KgMigrateRepository } from './migrate/kg-migrate.repository.js';
import { GraphOntologyService } from './ontology/graph-ontology.service.js';
import { GraphPreferencesService } from './preferences/graph-preferences.service.js';
import { graphPreferencesSchema } from './preferences/graph-preferences.schema.js';
import { KgPurgeService } from './purge/kg-purge.service.js';
import { GraphEvidenceService } from './read/graph-evidence.service.js';
import { GraphNeighborhoodService } from './read/graph-neighborhood.service.js';
import { GraphReadController } from './read/graph-read.controller.js';
import { GraphReadService } from './read/graph-read.service.js';
import { SpeakerLinkReconciler } from './speaker-link/speaker-link.reconciler.js';
import { GraphUserDataService } from './user-data/graph-user-data.service.js';
import { EvidenceValidator } from './write/evidence-validator.service.js';
import { GraphWriteService } from './write/graph-write.service.js';

// =============================================================================
// GraphModule (#354, epic #344, docs/specs/ontology.md; the package slice of issue #496, epic #491)
// =============================================================================
//
// The one module every connected-knowledge feature hangs its services, handlers and
// controllers on. It is the CORE of the graph: write, read, access, ontology, preferences,
// attribute definitions, the entity brief, the whole-graph layout, `kg.migrate`, `kg.purge`
// and the speaker link. Extraction, resolution, dedup and the review-and-commit proposals
// are `GraphExtractionModule`; RDF export and import are `GraphRdfModule`.
//
// It is built over ports only. The host's database, object store, job queue, events,
// audit, AI and settings arrive through the `KVOX_*` tokens of `KvoxPortsModule` (global);
// the peer slices' modules are options of `forRoot`.
//
// WHAT IT IMPORTS, AND WHY EACH ONE:
//
//   • the transcripts slice - `TranscriptAccessService`: whether a citation's transcript is
//     still viewable by the caller, and the speaker event the speaker link listens to.
//   • the notes slice - `NoteAccessService` and `NoteOriginService`: whether a citation's note
//     is still readable, and which transcript a note came from. ⚠ THIS MODULE NEVER PROVIDES A
//     NOTES CLASS: before #496 it provided `NoteAccessService` itself to avoid a cycle, which
//     is impossible now that the notes slice does not know the graph exists (it publishes
//     `kvox.notes.note_ready`; whoever extracts subscribes).
//   • the search slice - `SearchService` (the brief's text arm, spec §9.4: a brief is never
//     graph-only) and the host's transcript-visibility rule.
//
// ⚠ ALL THREE ARE IMPORTED, NEVER PROVIDED AGAIN: a peer slice's providers are reached
// through its module, so a handler registers once however many slices import it.
//
// `GraphWriteService` is the ONLY sanctioned write path for kg_entities, kg_relations and
// kg_items (#355) - every writer imports it from here (plus `kg.migrate`, by design). The
// conformance suite scans the slice's sources for any other.
//
// A host that omits `GraphExtractionModule` still boots this one: the proposal stage registry
// is filled by the stages' own `onModuleInit`, and nothing here needs it.
//
// THE `kg.migrate` CRON IS A SEPARATE FILE, LOADED ONLY WHEN `schedules` IS NOT FALSE
// (`@nestjs/schedule` registers its metadata at import). The enqueuer (`enqueue()`) is always
// provided.
// =============================================================================

/**
 * Declares the `graph` user-settings namespace with the host when the module starts. The
 * web edition's platform registry already holds it (it composes the settings request bodies
 * and the API document before the application is created) and the settings port verifies
 * that; a host without a registry records it.
 */
@Injectable()
class GraphSettingsRegistrar implements OnModuleInit {
  constructor(@Inject(KVOX_SETTINGS) private readonly settings: KvoxSettingsPort) {}

  onModuleInit(): void {
    // ABSENT MEANS "DEFAULTS": the stored namespace is sparse, so there is no stored default.
    this.settings.registerNamespace({
      scope: 'user',
      name: 'graph',
      schema: graphPreferencesSchema,
      defaults: undefined,
    });
  }
}

/**
 * The connected-knowledge core: entities, relations, facts and the evidence that anchors
 * every claim, with the write, read, access, ontology, brief, overview and purge services
 * and their routes.
 *
 * @stability experimental
 */
@Module({})
export class GraphModule {
  /**
   * Builds the module over the host's ports.
   *
   * @param options - schedules, layout tuning, the `kg.migrate` switch and the peer modules.
   * @returns the dynamic module; it exports the write, access, read, ontology, preferences,
   *   brief and attribute services the extraction and RDF slices use, plus
   *   {@link GraphUserDataService}.
   */
  static forRoot(options: GraphModuleOptions = {}): DynamicModule {
    const resolved = resolveGraphOptions(options);
    const controllers = [
      GraphController,
      GraphEntitiesController,
      GraphAttributeDefsController,
      GraphReadController,
      GraphOverviewController,
      EntityBriefController,
    ];

    const providers: Provider[] = [
      { provide: GRAPH_MODULE_OPTIONS, useValue: resolved },
      GraphAccessService,
      // The graph's one question to the AI port (model, limits, graph switch).
      GraphAiRunResolver,
      // The `graph` user-settings namespace, resolved with defaults (#369).
      GraphPreferencesService,
      GraphSettingsRegistrar,
      GraphOntologyService,
      EvidenceValidator,
      GraphWriteService,
      GraphEntitiesService,
      GraphRelationEditsService,
      GraphAttributeDefsService,
      // `kg.purge`: forget-a-person and the Danger Zone's `graph` category (#357).
      KgPurgeService,
      KgPurgeHandler,
      GraphUserDataService,
      // The read layer (exported for the brief and the Ask agent).
      GraphReadService,
      GraphNeighborhoodService,
      GraphEvidenceService,
      // Speaker naming -> Person + IDENTIFIED_AS, via `kg.speaker_link` (#356).
      SpeakerLinkReconciler,
      KgSpeakerLinkHandler,
      SpeakerIdentifiedListener,
      // `kg.graph_layout`: the whole-graph overview snapshot, its three enqueue triggers
      // (refresh, bootstrap, material change) and the read (#371).
      GraphLayoutEnqueuer,
      KgGraphLayoutHandler,
      GraphLayoutListener,
      GraphOverviewService,
      // The entity brief, and `kg.entity_digest` (the only producer of brief prose) (#372).
      EntityViewService,
      EntityDigestEnqueuer,
      EntityDigestHandler,
      EntityBriefService,
      // `kg.migrate`: per-user reshaping of rows on an ontology bump (#384).
      // `KG_MIGRATE_DEFINITION` is deliberately NOT provided: the handler falls back to the
      // shipped definition, and only a test injects a fixture one.
      KgMigrateRepository,
      KgMigrateHandler,
      KgMigrateEnqueuer,
      // The graph's managed storage (`managed_by: 'graph'`) (#386).
      GraphObjectsService,
    ];

    if (resolved.schedules) {
      const { KgMigrateSchedulerTask } =
        require('./migrate/kg-migrate-scheduler.task.js') as typeof import('./migrate/kg-migrate-scheduler.task.js');
      providers.push(KgMigrateSchedulerTask);
    }

    // Now that the routes are known, describe them in the API document the way the host chose.
    documentKvoxAuth(controllers);

    return {
      module: GraphModule,
      global: false,
      imports: [
        ...(options.imports ?? []),
        // The peer slices. The application imports each itself; pass the very same objects
        // here (a dynamic module built twice with the same options is one module, but a
        // different configuration would register a handler twice).
        options.peers?.transcripts ?? TranscriptsModule.forRoot(),
        options.peers?.notes ?? NotesModule.forRoot(),
        options.peers?.search ?? SearchModule.forRoot(),
      ],
      controllers,
      providers,
      exports: [
        GRAPH_MODULE_OPTIONS,
        GraphAccessService,
        GraphAiRunResolver,
        GraphOntologyService,
        GraphPreferencesService,
        EvidenceValidator,
        GraphWriteService,
        // `MergeService` reuses its guarded kg.embed / kg.entity_digest enqueue.
        GraphEntitiesService,
        GraphReadService,
        GraphNeighborhoodService,
        GraphEvidenceService,
        EntityBriefService,
        EntityDigestEnqueuer,
        // `kg.import` stores the upload, offers attribute definitions and refuses an import
        // while the owner's rows await `kg.migrate`.
        GraphObjectsService,
        GraphAttributeDefsService,
        KgMigrateRepository,
        // A host with `schedules: false` calls `enqueue()` on its own timer.
        KgMigrateEnqueuer,
        GraphUserDataService,
        KgPurgeService,
      ],
    };
  }
}
