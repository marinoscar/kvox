// =============================================================================
// The slices' internals the kg evaluation runs (issue #580; #496 before it)
// =============================================================================
//
// `@marinoscar/kvox-api/graph/testing` and `/graph-extraction/testing` expose the
// functions the slices keep internal (the extraction prompt and schema builders,
// the resolution scorer, the temporal engine's helpers) in an `internals`
// namespace tagged `@internal`: no stability promise. This file is the ONE place
// the package spells that out, so the runners name a function from here and
// never from the package's internal paths. NOT EXPORTED from the package: a host
// that needs these names reads them from kvox-api itself.
// =============================================================================

import { internals as extractionInternals } from '@marinoscar/kvox-api/graph-extraction/testing';

export const {
  EXTRACTION_SCHEMA_NAME,
  addDeterministicRows,
  assembleExtractionPrompt,
  bandFor,
  buildExtractionContext,
  buildExtractionOutputSchema,
  candidateEdge,
  decide,
  entityView,
  existingId,
  extractionRowCaps,
  isExclusiveTemporal,
  normalizeForMatch,
  placeholderId,
  proposedRelationRange,
  rankCandidates,
  relationKnown,
  resolveEndpoint,
  ruleForEffectiveRelation,
  scoreCandidate,
  validateExtraction,
} = extractionInternals;

export type EvidenceDraft = extractionInternals.EvidenceDraft;
export type ExtractionInput = extractionInternals.ExtractionInput;
export type KnownEntityRow = extractionInternals.KnownEntityRow;
export type ProposalEntityView = extractionInternals.ProposalEntityView;
export type ProposedRow = extractionInternals.ProposedRow;
