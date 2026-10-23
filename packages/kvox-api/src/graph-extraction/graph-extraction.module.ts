import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import { documentKvoxAuth } from '../core/index.js';
import { GraphModule } from '../graph/index.js';
import { NotesModule } from '../notes/index.js';
import { ItemCandidateService } from './dedup/item-candidates.service.js';
import { RejectionMemoryStage } from './dedup/rejection-memory.stage.js';
import { TemporalClosingStage } from './dedup/temporal-closing.stage.js';
import { WorkItemDedupStage } from './dedup/work-item-dedup.stage.js';
import { ExtractionInputLoader } from './extraction/extraction-input.loader.js';
import { GraphExtractionController } from './extraction/graph-extraction.controller.js';
import { GraphExtractionService } from './extraction/graph-extraction.service.js';
import { NoteReadyExtractionSubscriber } from './extraction/note-ready-extraction.subscriber.js';
import { ProposalStageRegistry } from './extraction/proposal-stage.js';
import { ProposalWriter } from './extraction/proposal-writer.service.js';
import {
  GRAPH_EXTRACTION_OPTIONS,
  resolveGraphExtractionOptions,
  type GraphExtractionModuleOptions,
} from './graph-extraction.options.js';
import { KgEmbedHandler } from './handlers/kg-embed.handler.js';
import { KgExtractHandler } from './handlers/kg-extract.handler.js';
import { KgResolveHandler } from './handlers/kg-resolve.handler.js';
import { KgTopicsPromoteHandler } from './handlers/kg-topics-promote.handler.js';
import { GraphProposalsController } from './proposals/graph-proposals.controller.js';
import { GraphTopicsPromoteController } from './topics/graph-topics-promote.controller.js';
import { TopicsPromoteService } from './topics/topics-promote.service.js';
import { GraphReviewQueueController } from './proposals/graph-review-queue.controller.js';
import { ProposalBatchCommitService } from './proposals/proposal-batch-commit.service.js';
import { ProposalCommitService } from './proposals/proposal-commit.service.js';
import { ProposalRevertService } from './proposals/proposal-revert.service.js';
import { ProposalsService } from './proposals/proposals.service.js';
import { SpanValidator } from './proposals/span-validator.js';
import { AdjudicationService } from './resolution/adjudication.service.js';
import { AliasLearningService } from './resolution/alias-learning.service.js';
import { CandidateService } from './resolution/candidate.service.js';
import { ContextFeatureService } from './resolution/context-features.service.js';
import { DistinctPairService } from './resolution/distinct-pair.service.js';
import { GraphEmbedder } from './resolution/graph-embedder.service.js';
import { GraphResolutionController } from './resolution/graph-resolution.controller.js';
import { GraphPreferencesListener } from './resolution/listeners/graph-preferences.listener.js';
import { MergeService } from './resolution/merge.service.js';
import { ResolutionActionsService } from './resolution/resolution-actions.service.js';
import { ResolutionService } from './resolution/resolution.service.js';
import { ResolutionStage } from './resolution/resolution.stage.js';

// =============================================================================
// GraphExtractionModule (#363 to #367, epic #346; the package slice of issue #496, epic #491)
// =============================================================================
//
// The review-and-commit pipeline: extraction (`kg.extract`), entity resolution (`kg.resolve`,
// `kg.embed`, merges, distinct pairs, adjudication), the work-item dedup and temporal-closing
// stages, and the proposals a person reviews, commits and reverts.
//
// It is built over ports only, on top of `GraphModule`: the write, access, read, ontology and
// preference services come from the core slice's module (a peer option of `forRoot`) and the
// note access services from the notes slice's. This module NEVER provides those again.
//
// ONE MODULE WHERE THE APPLICATION HAD FOUR. Extraction, resolution, dedup and proposals were
// separate Nest modules in the application, importing one another in that order to keep the
// providers acyclic. Behind `forRoot` they are one: the provider graph is unchanged, and a
// single module cannot be configured half-way. The stages self-register with the proposal
// stage registry in their own `onModuleInit`, so a host that omits this slice still boots
// `GraphModule`.
//
// ⚠ THIS SLICE SUBSCRIBES TO `kvox.notes.note_ready` (unless `autoExtract` is false) and so
// replaces the application's temporary listener. Everything it does on that event is enqueue.
// =============================================================================

/**
 * The extraction, resolution, dedup and proposal pipeline over the core graph.
 *
 * @stability experimental
 */
@Module({})
export class GraphExtractionModule {
  /**
   * Builds the module over the host's ports.
   *
   * @param options - the auto-extract switch, the embeddings batch size and the peer modules.
   * @returns the dynamic module; it exports the extraction, proposal and resolution services
   *   the RDF slice and the Ask agent use.
   */
  static forRoot(options: GraphExtractionModuleOptions = {}): DynamicModule {
    const resolved = resolveGraphExtractionOptions(options);
    const controllers = [GraphExtractionController, GraphResolutionController, GraphProposalsController, GraphReviewQueueController, GraphTopicsPromoteController];

    const providers: Provider[] = [
      { provide: GRAPH_EXTRACTION_OPTIONS, useValue: resolved },
      // Extraction (#363).
      ExtractionInputLoader,
      ProposalWriter,
      ProposalStageRegistry,
      GraphExtractionService,
      KgExtractHandler,
      // Resolution (#364).
      GraphEmbedder,
      CandidateService,
      ContextFeatureService,
      AdjudicationService,
      ResolutionService,
      ResolutionStage,
      DistinctPairService,
      AliasLearningService,
      MergeService,
      ResolutionActionsService,
      GraphPreferencesListener,
      KgResolveHandler,
      KgEmbedHandler,
      // Topics promotion (#666).
      KgTopicsPromoteHandler,
      TopicsPromoteService,
      // Dedup and closing stages (#365).
      ItemCandidateService,
      WorkItemDedupStage,
      TemporalClosingStage,
      RejectionMemoryStage,
      // Review, commit and revert (#366).
      SpanValidator,
      ProposalsService,
      ProposalCommitService,
      ProposalRevertService,
      ProposalBatchCommitService,
    ];

    if (resolved.autoExtract) providers.push(NoteReadyExtractionSubscriber);

    // Now that the routes are known, describe them in the API document the way the host chose.
    documentKvoxAuth(controllers);

    return {
      module: GraphExtractionModule,
      global: false,
      imports: [
        ...(options.imports ?? []),
        // The peer slices. The application imports each itself; pass the very same objects
        // here (a dynamic module built twice with the same options is one module, but a
        // different configuration would register a handler twice).
        options.peers?.graph ?? GraphModule.forRoot(),
        options.peers?.notes ?? NotesModule.forRoot(),
      ],
      controllers,
      providers,
      exports: [
        GRAPH_EXTRACTION_OPTIONS,
        GraphExtractionService,
        ProposalStageRegistry,
        ProposalsService,
        ProposalCommitService,
        ProposalRevertService,
        ProposalBatchCommitService,
        ResolutionService,
        MergeService,
        DistinctPairService,
        AliasLearningService,
        GraphEmbedder,
        AdjudicationService,
        ItemCandidateService,
      ],
    };
  }
}
