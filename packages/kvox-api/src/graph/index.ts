// The graph slice of @marinoscar/kvox-api (issue #496, epic #491).
//
// Depends on `ports`, `core`, `transcripts`, `notes` and `search`. The one way in is
// `GraphModule.forRoot(options)`; the rest of this file is what a host or a sibling slice
// (`graph-extraction`, `graph-rdf`, Ask) imports. Most classes are internal wiring (tagged
// `@internal`): a host configures them through `forRoot` and never instantiates them. The
// exception is `KgMigrateEnqueuer`, which a host with `schedules: false` calls on its own timer.

export { GraphModule } from './graph.module.js';
export {
  DEFAULT_LAYOUT_COALESCE_MS,
  DEFAULT_LAYOUT_MATERIAL_CHANGE,
  GRAPH_MODULE_OPTIONS,
  resolveGraphOptions,
  type GraphLayoutOptions,
  type GraphModuleOptions,
  type ResolvedGraphOptions,
} from './graph.options.js';
export { GRAPH_PERMISSIONS, GRAPH_READ_PERMISSION, GRAPH_WRITE_PERMISSION } from './graph.permissions.js';
export { CurrentGraphActor, graphActorOf, type GraphActor } from './graph-actor.js';
export { ApiDataResponse } from './api-data-response.js';
export { GRAPH_CHANGED_EVENT, type GraphChangedEvent, type GraphChangedReason } from './graph-events.js';
export {
  GRAPH_MANAGED_BY,
  KG_EMBED_JOB_TYPE,
  KG_ENTITY_DIGEST_JOB_TYPE,
  KG_EXPORT_JOB_TYPE,
  KG_EXTRACT_JOB_TYPE,
  KG_GRAPH_LAYOUT_JOB_TYPE,
  KG_IMPORT_JOB_TYPE,
  KG_MIGRATE_JOB_TYPE,
  KG_PURGE_JOB_TYPE,
  KG_RESOLVE_JOB_TYPE,
  KG_SPEAKER_LINK_JOB_TYPE,
  KG_SUBJECT_ENTITY,
  KG_SUBJECT_EXPORT,
  KG_SUBJECT_EXPORT_SWEEP,
  KG_SUBJECT_NOTE,
  KG_SUBJECT_PROPOSAL,
  KG_SUBJECT_TRANSCRIPT,
  KG_SUBJECT_USER,
  KG_TOPICS_PROMOTE_JOB_TYPE,
} from './job-types.js';
export { GRAPH_CONFLICT_REASONS, type GraphConflictReason } from './graph-conflict-reasons.js';
export { graphImportStoragePrefix } from './graph-storage-keys.js';
export {
  GRAPH_AI_TASK_LABELS,
  GraphAiConflict,
  graphDisabledConflict,
  keyMissingConflict,
  lacksCapabilityConflict,
  notConfiguredConflict,
  refusalForResolution,
  rethrowRateLimit,
  type GraphAiConflictReason,
  type GraphAiTask,
} from './graph-ai-support.js';
export type { GraphAiRun } from './graph-ai-run.js';
export { GraphAiRunResolver, type ResolveGraphAiOptions } from './graph-ai-run.service.js';

// The data layer: row types and the narrowed database client the slice injects.
export type {
  KvoxGraphDb,
  KvoxGraphDelegates,
  KvoxGraphTx,
  KgAliasSourceValue,
  KgAttributeDefRow,
  KgAttributeKindValue,
  KgDistinctPairRow,
  KgEntityAliasRow,
  KgEntityDigestRow,
  KgEntityRow,
  KgEntityViewRow,
  KgEvidenceRow,
  KgEvidenceSubjectKindValue,
  KgExportFormatValue,
  KgExportRow,
  KgExportStatusValue,
  KgGraphLayoutRow,
  KgItemKindValue,
  KgItemRow,
  KgMentionRow,
  KgMentionStatusValue,
  KgMergeRow,
  KgProposalItemDecisionValue,
  KgProposalItemKindValue,
  KgProposalItemOriginValue,
  KgProposalItemRow,
  KgProposalKindValue,
  KgProposalRow,
  KgProposalStatusValue,
  KgRelationRow,
  KgReviewStatusValue,
  KgSensitivityValue,
  KgValidPrecisionValue,
} from './data/graph-db.js';
export { isUniqueViolation, type InputJsonObject, type InputJsonValue, type JsonValue } from './data/prisma.js';

// Preferences: the rules the web edition's platform registration reuses.
export {
  assertGraphPreferenceLimits,
  mergeGraphPreferences,
} from './preferences/graph-preferences.merge.js';
export {
  changedGraphSections,
  enabledDomainKeys,
  resolveGraphPreferences,
  type GraphPreferenceSection,
} from './preferences/graph-preferences.defaults.js';
export {
  graphPreferencesPatchSchema,
  graphPreferencesSchema,
  type GraphPreferencesPatchValue,
  type GraphPreferencesValue,
} from './preferences/graph-preferences.schema.js';
export { GraphUserDataService } from './user-data/graph-user-data.service.js';

// Services other slices and hosts use.
export { GRAPH_NOT_FOUND_MESSAGES, GraphAccessService } from './access/graph-access.service.js';
export { GraphAttributeDefsService } from './attribute-defs/graph-attribute-defs.service.js';
export { GraphEntitiesService } from './graph-entities.service.js';
export { GraphObjectsService } from './graph-objects.service.js';
export { subjectHousekeeping } from './housekeeping-subject.enqueue.js';
export { DEFAULT_KG_MIGRATE_DEFINITION, KG_MIGRATE_DEFINITION, KG_MIGRATE_TABLES, candidatePredicate, kgMigrateEnqueueFields, migrationsUpTo } from './migrate/kg-migrate.plan.js';
export type { KgMigrateDefinition, KgMigrateTable } from './migrate/kg-migrate.plan.js';
export { KG_MIGRATE_OWNERS_PER_TICK, KgMigrateEnqueuer } from './migrate/kg-migrate.enqueuer.js';
export { KgMigrateRepository } from './migrate/kg-migrate.repository.js';
export { GraphOntologyService } from './ontology/graph-ontology.service.js';
export { GRAPH_PREFERENCE_DEFAULTS } from './preferences/graph-preferences.defaults.js';
export type { GraphPreferences } from './preferences/graph-preferences.defaults.js';
export { GRAPH_PREFERENCES_CHANGED_EVENT } from './preferences/graph-preferences.events.js';
export type { GraphPreferencesChangedEvent } from './preferences/graph-preferences.events.js';
export { GraphPreferencesService } from './preferences/graph-preferences.service.js';
export { TemporalInputError, commitmentsToReview, fromPgRange, identityKey, isExclusiveTemporal, planTemporalInsert, rangeFromPrecision, ruleForEffectiveRelation, sameIdentityProps, stableStringify, temporalRuleFor, toPgRange } from './temporal/index.js';
export type { CandidateEdge, TemporalEdge, TemporalPlan, TemporalReviewStatus, TemporalRule, ValidPrecision, ValidRange } from './temporal/index.js';
export { GraphDuplicateError, GraphInvariantError, GraphValidationError, toGraphHttpException } from './write/graph-write.errors.js';
export { GraphWriteService } from './write/graph-write.service.js';
export type { EvidenceAccess } from './write/evidence-validator.service.js';
export { loadLiveTemporalEdges } from './write/live-edges.js';
export { ManualEvidence, MANUAL_EVIDENCE_LABEL, isManualEvidenceRow } from './write/manual-evidence.js';
export type { GraphEvidenceInput } from './write/manual-evidence.js';
export { normalizeAlias, statementHash } from './write/normalize.js';

// The read-side services and constants the Ask agent and the host's wiring use.
export { EntityBriefService } from './brief/entity-brief.service.js';
export { EntityDigestEnqueuer } from './brief/entity-digest.enqueuer.js';
export { GraphLayoutEnqueuer } from './layout/graph-layout.enqueuer.js';
export { parseAsOf } from './read/as-of.js';
export { GraphEvidenceService } from './read/graph-evidence.service.js';
export { GraphNeighborhoodService } from './read/graph-neighborhood.service.js';
export { GraphPathsService } from './read/graph-paths.service.js';
export { GraphReadService } from './read/graph-read.service.js';
export { readableEntitySql } from './read/read-sql.js';
export { AS_OF_RELATION_STATUSES, READABLE_ENTITY_STATUSES, READABLE_ITEM_STATUSES, TIMELINE_ITEM_STATUSES } from './read/readable.js';

// Types the public signatures above mention.
export type { GraphSubjectKind } from './access/graph-access.service.js';
export type { GraphCreateManyAndReturn, GraphGroupBy, GraphUpsert } from './data/graph-db.js';
export type { UniqueViolation } from './data/prisma.js';
export type { GraphInvariantCode } from './write/graph-write.errors.js';
export type { TemporalFlag } from './temporal/types.js';
export type { RangeFromPrecisionOptions } from './temporal/valid-range.js';
export { GRAPH_PREFERENCE_SECTIONS } from './preferences/graph-preferences.defaults.js';
export type { SubjectHousekeepingEnqueueOptions } from './housekeeping-subject.enqueue.js';
export type { GraphAdjudication, GraphResolutionMode } from './preferences/graph-preferences.defaults.js';
export type { TemporalAttachPlan, TemporalClosing, TemporalCreatePlan } from './temporal/types.js';
export type { RangeFromPrecisionResult } from './temporal/valid-range.js';
export type { GraphAiModelLimits, GraphAiPolicy } from './graph-ai-run.js';
export type { GraphExtractionPreferences } from './preferences/graph-preferences.defaults.js';
export type { KgMigrateEnqueueFields } from './migrate/kg-migrate.plan.js';
export type { ApiDataResponseOptions } from './api-data-response.js';
export type { HousekeepingJobRef } from './housekeeping-subject.enqueue.js';
