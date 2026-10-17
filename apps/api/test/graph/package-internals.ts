// =============================================================================
// The slices' internals the application's specs and evaluation scripts reach for (issue #496, epic #491)
// =============================================================================
//
// `@marinoscar/kvox-api/graph/testing`, `/graph-extraction/testing` and `/graph-rdf/testing` expose
// functions and fixtures the slices keep internal (the extraction prompt and schema builders, the
// resolution scorer, the temporal engine's helpers, the RDF generators) in an `internals` namespace
// tagged `@internal`: no stability promise. This file is the ONE place the application spells that
// out, so a spec or a `kg-eval` script imports a name from here instead of from the package's
// internal paths (which the package no longer exposes).
// =============================================================================

import { internals as graphInternals } from '@marinoscar/kvox-api/graph/testing';
import { internals as extractionInternals } from '@marinoscar/kvox-api/graph-extraction/testing';
import { internals as rdfInternals } from '@marinoscar/kvox-api/graph-rdf/testing';



export const {
  DIGEST_RESPONSE_SCHEMA,
  EntityDigestHandler,
  EntityViewService,
  EvidenceValidator,
  GraphLayoutListener,
  GraphOverviewService,
  KgGraphLayoutHandler,
  KgMigrateHandler,
  KgMigrateSchedulerTask,
  KgPurgeHandler,
  KgPurgeService,
  KgSpeakerLinkHandler,
  SPEAKER_LINKED_ACTION,
  SPEAKER_UNLINKED_ACTION,
  SpeakerLinkReconciler,
  TEST_TARGET_VERSION,
  buildMigrationTestDefinition,
  computeLayout,
  encodeGraphCursor,
  isKgInvariantViolation,
  isValidAt,
  itemValidAt,
  itemValidAtSql,
  mulberry32,
  relationValidAtSql,
} = graphInternals;

export type LayoutInput = graphInternals.LayoutInput;
export type MigrationTestDefinition = graphInternals.MigrationTestDefinition;
export type EntityDigestHandler = graphInternals.EntityDigestHandler;
export type EntityViewService = graphInternals.EntityViewService;
export type EvidenceValidator = graphInternals.EvidenceValidator;
export type GraphLayoutListener = graphInternals.GraphLayoutListener;
export type GraphOverviewService = graphInternals.GraphOverviewService;
export type KgGraphLayoutHandler = graphInternals.KgGraphLayoutHandler;
export type KgMigrateHandler = graphInternals.KgMigrateHandler;
export type KgMigrateSchedulerTask = graphInternals.KgMigrateSchedulerTask;
export type KgPurgeHandler = graphInternals.KgPurgeHandler;
export type KgPurgeService = graphInternals.KgPurgeService;
export type KgSpeakerLinkHandler = graphInternals.KgSpeakerLinkHandler;
export type SpeakerLinkReconciler = graphInternals.SpeakerLinkReconciler;

export const {
  CandidateService,
  ContextFeatureService,
  EXTRACTION_SCHEMA_NAME,
  ExtractionInputLoader,
  IDS,
  NOTE_BODY,
  ProposalWriter,
  RejectionMemoryStage,
  ResolutionStage,
  SEGMENT_TEXT,
  TemporalClosingStage,
  WorkItemDedupStage,
  addDeterministicRows,
  assembleExtractionPrompt,
  bandFor,
  buildAdjudicationOutputSchema,
  buildExtractionContext,
  buildExtractionOutputSchema,
  buildItemAdjudicationOutputSchema,
  candidateEdge,
  decide,
  emptyContext,
  entityView,
  existingId,
  extractionRowCaps,
  goodAnswer,
  isExclusiveTemporal,
  known,
  makeContext,
  makeInput,
  normalizeForMatch,
  placeholderId,
  proposedRelationRange,
  rankCandidates,
  relationKnown,
  resolveEndpoint,
  ruleForEffectiveRelation,
  schemaFor,
  scoreCandidate,
  validateExtraction,
} = extractionInternals;

export type EvidenceDraft = extractionInternals.EvidenceDraft;
export type ExtractionContext = extractionInternals.ExtractionContext;
export type ExtractionInput = extractionInternals.ExtractionInput;
export type KnownEntityRow = extractionInternals.KnownEntityRow;
export type ProposalEntityView = extractionInternals.ProposalEntityView;
export type ProposedRow = extractionInternals.ProposedRow;
export type RawAnswer = extractionInternals.RawAnswer;
export type CandidateService = extractionInternals.CandidateService;
export type ContextFeatureService = extractionInternals.ContextFeatureService;
export type ExtractionInputLoader = extractionInternals.ExtractionInputLoader;
export type ProposalWriter = extractionInternals.ProposalWriter;
export type RejectionMemoryStage = extractionInternals.RejectionMemoryStage;
export type ResolutionStage = extractionInternals.ResolutionStage;
export type TemporalClosingStage = extractionInternals.TemporalClosingStage;
export type WorkItemDedupStage = extractionInternals.WorkItemDedupStage;

export const {
  APP_NS,
  ChildProcessShaclEngine,
  FIXTURE_NS,
  FIXTURE_TIER_DEF,
  IMPORT_FIXTURE_TEXT,
  OWL,
  PROV,
  RDF,
  RDFS,
  SCHEMA,
  SH,
  XSD,
  asAsync,
  assertionShapeIri,
  buildImportVocabulary,
  fixtureBatches,
  fixtureId,
  generateShacl,
  importFixture,
  importFixtureStream,
  listMembers,
  objectsOf,
  parseTurtle,
  parseTurtleText,
  propertyShape,
  renderFixtureExport,
  shaclModuleUrl,
  shapeIri,
  shapePaths,
  subjectsOfType,
  userDef,
  validateShacl,
} = rdfInternals;

export type ImportFixture = rdfInternals.ImportFixture;
export type ChildProcessShaclEngine = rdfInternals.ChildProcessShaclEngine;
