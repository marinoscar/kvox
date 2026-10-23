// The graph-extraction slice of @marinoscar/kvox-api (issue #496, epic #491).
//
// Depends on `ports`, `core`, `graph`, `notes`, `transcripts` and `search`. The one way in is
// `GraphExtractionModule.forRoot(options)`; the rest of this file is what a host or a sibling
// slice (`graph-rdf`, Ask) imports. The classes are internal wiring (tagged `@internal`): a
// host configures them through `forRoot` and never instantiates them.

export { GraphExtractionModule } from './graph-extraction.module.js';
export {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  GRAPH_EXTRACTION_OPTIONS,
  resolveGraphExtractionOptions,
  type GraphExtractionModuleOptions,
  type ResolvedGraphExtractionOptions,
} from './graph-extraction.options.js';

// Extraction.
export { GraphExtractionService } from './extraction/graph-extraction.service.js';
export { ProposalStageRegistry } from './extraction/proposal-stage.js';
export type { ProposalStage, ProposalStageContext } from './extraction/proposal-stage.js';
export { NoteReadyExtractionSubscriber } from './extraction/note-ready-extraction.subscriber.js';
export { applyPrecheck, reviewOnlyTypes } from './extraction/precheck.js';
export type { PrecheckItem } from './extraction/precheck.js';
export { KgExtractHandler } from './handlers/kg-extract.handler.js';
export { KgLibraryReconcileHandler } from './handlers/kg-library-reconcile.handler.js';
export { KgAutocommitHandler, GRAPH_AUTOCOMMIT_ACTION } from './handlers/kg-autocommit.handler.js';
export { KG_EXTRACT_BULK_PRIORITY, type EnqueueForReadyNoteOptions } from './extraction/graph-extraction.service.js';
export { ProposalDraftedHook } from './extraction/proposal-drafted.hook.js';
export { ProposalDraftedSubscriber } from './extraction/proposal-drafted.subscriber.js';
export { GraphReconcileEnqueuer, type KgLibraryReconcilePayload } from './library/graph-reconcile.enqueuer.js';
export { ImportBatchSettledSubscriber } from './library/import-batch-settled.subscriber.js';
export { ExtractionRetryService } from './library/extraction-retry.service.js';
export { GraphImportBatchesController } from './library/graph-import-batches.controller.js';
export {
  extractionStateOf,
  selectReconcileNotes,
  type ExtractionProposalFact,
  type ExtractionState,
  type ReconcileFile,
  type ReconcileSelection,
} from './library/extraction-state.js';

// Resolution and dedup.
export { ResolutionService } from './resolution/resolution.service.js';
export { MergeService } from './resolution/merge.service.js';
export { DistinctPairService } from './resolution/distinct-pair.service.js';
export { AliasLearningService } from './resolution/alias-learning.service.js';
export { AdjudicationService } from './resolution/adjudication.service.js';
export { GraphEmbedder } from './resolution/graph-embedder.service.js';
export { ItemCandidateService } from './dedup/item-candidates.service.js';
export { KgEmbedHandler } from './handlers/kg-embed.handler.js';
export { KgResolveHandler } from './handlers/kg-resolve.handler.js';
export { KgTopicsPromoteHandler } from './handlers/kg-topics-promote.handler.js';

// Proposals.
export { ProposalsService, lockProposal, notDraft } from './proposals/proposals.service.js';
export { ProposalCommitService } from './proposals/proposal-commit.service.js';
export { ProposalBatchCommitService } from './proposals/proposal-batch-commit.service.js';
export {
  applySafePolicy,
  isSensitivePersonFact, type SafePolicyAdjudication,
  type SafePolicyItem,
  type SafePolicyOptions,
  type SafePolicyResolution,
  type SafePolicyResult,
  type SafePolicyWaitReason,
  type SafePolicyWaiting,
} from './proposals/safe-policy.js';
export { ProposalRevertService } from './proposals/proposal-revert.service.js';
export { SpanValidator } from './proposals/span-validator.js';
export { entityPayloadSchema, itemPayloadSchema, relationPayloadSchema } from './proposals/proposal-payload.schema.js';
export type {
  EntityPayload,
  ItemPayload,
  ItemPayloadKind,
  RelationPayload,
} from './proposals/proposal-payload.schema.js';

// Controllers (a host that composes its own module lists them).
export { GraphExtractionController } from './extraction/graph-extraction.controller.js';
export { GraphResolutionController } from './resolution/graph-resolution.controller.js';
export { GraphReviewQueueController } from './proposals/graph-review-queue.controller.js';
export { GraphProposalsController } from './proposals/graph-proposals.controller.js';
export { GraphTopicsPromoteController } from './topics/graph-topics-promote.controller.js';

export type { PrecheckOptions } from './extraction/precheck.js';
