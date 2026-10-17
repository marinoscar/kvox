// The slice's internals that a host's integration specs and evaluation scripts reach for. Reached
// through the `internals` namespace of the testing entry; not part of the documented surface.

// The fixtures.
export * from './extraction-fixtures.js';

// The internals.
export { candidateEdge, entityView, existingId, isExclusiveTemporal, placeholderId, proposedRelationRange, relationKnown, resolveEndpoint, ruleForEffectiveRelation } from '../dedup/dedup-core.js';
export type { ProposalEntityView } from '../dedup/dedup-core.js';
export { buildItemAdjudicationOutputSchema } from '../dedup/item-adjudication-prompt.js';
export { RejectionMemoryStage } from '../dedup/rejection-memory.stage.js';
export { TemporalClosingStage } from '../dedup/temporal-closing.stage.js';
export { WorkItemDedupStage } from '../dedup/work-item-dedup.stage.js';
export { buildExtractionContext, normalizeForMatch } from '../extraction/extraction-context.js';
export type { ExtractionContext, ExtractionInput, KnownEntityRow } from '../extraction/extraction-context.js';
export { ExtractionInputLoader } from '../extraction/extraction-input.loader.js';
export { EXTRACTION_SCHEMA_NAME, buildExtractionOutputSchema } from '../extraction/output-schema.js';
export { assembleExtractionPrompt } from '../extraction/prompt.js';
export { ProposalWriter } from '../extraction/proposal-writer.service.js';
export { extractionRowCaps } from '../extraction/row-caps.js';
export { addDeterministicRows, validateExtraction } from '../extraction/validate.js';
export type { EvidenceDraft, ProposedRow } from '../extraction/validate.js';
export { buildAdjudicationOutputSchema } from '../resolution/adjudication-prompt.js';
export { CandidateService } from '../resolution/candidate.service.js';
export { ContextFeatureService, emptyContext } from '../resolution/context-features.service.js';
export { decide } from '../resolution/resolution.service.js';
export { ResolutionStage } from '../resolution/resolution.stage.js';
export { bandFor, rankCandidates, scoreCandidate } from '../resolution/score.js';
