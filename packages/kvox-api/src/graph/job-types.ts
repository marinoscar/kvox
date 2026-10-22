// =============================================================================
// Graph job-type and subject constants (#354, epic #344)
// =============================================================================
//
// CONSTANTS ONLY: no handlers here, and no imports of Nest — so a pure module
// (a reducer, a planner, a spec) can name a job type without pulling the DI
// graph in with it.
//
// ⚠ APPEND, NEVER RENAME. A job `type` is a plain string column
// (`jobs.type`) and is PERMANENT once rows of it exist; renaming a constant
// here orphans every queued row of the old spelling. Later issues append the
// types they introduce. A friendly label goes in `job-type-labels.ts` only
// when the handler for that type lands — never ahead of it.
//
// Every `kg.*` job runs server-only on the calling user's own AI provider key
// (docs/specs/ontology.md), exactly like `note.generate`.
// =============================================================================

// `jobs.subject_type` values for graph jobs.
/**
 * The kg subject entity.
 *
 * @stability experimental
 */
export const KG_SUBJECT_ENTITY = 'kg_entity';
/**
 * The kg subject note.
 *
 * @stability experimental
 */
export const KG_SUBJECT_NOTE = 'note';
/**
 * The kg subject transcript.
 *
 * @stability experimental
 */
export const KG_SUBJECT_TRANSCRIPT = 'transcript';
/**
 * The kg subject user.
 *
 * @stability experimental
 */
export const KG_SUBJECT_USER = 'user';

// Job types.
/**
 * The kg speaker link job type.
 *
 * @stability experimental
 */
export const KG_SPEAKER_LINK_JOB_TYPE = 'kg.speaker_link';
/**
 * The kg purge job type.
 *
 * @stability experimental
 */
export const KG_PURGE_JOB_TYPE = 'kg.purge';
/**
 * The kg extract job type.
 *
 * @stability experimental
 */
export const KG_EXTRACT_JOB_TYPE = 'kg.extract';
/**
 * The kg resolve job type.
 *
 * @stability experimental
 */
export const KG_RESOLVE_JOB_TYPE = 'kg.resolve';
/**
 * The kg embed job type.
 *
 * @stability experimental
 */
export const KG_EMBED_JOB_TYPE = 'kg.embed';
/**
 * The kg entity digest job type.
 *
 * @stability experimental
 */
export const KG_ENTITY_DIGEST_JOB_TYPE = 'kg.entity_digest';
/**
 * The kg graph layout job type.
 *
 * @stability experimental
 */
export const KG_GRAPH_LAYOUT_JOB_TYPE = 'kg.graph_layout';
/**
 * The kg migrate job type.
 *
 * @stability experimental
 */
export const KG_MIGRATE_JOB_TYPE = 'kg.migrate';
// #386 — RDF export of one owner's graph (render), and the daily expiry sweep
// (same type, `payload.mode: 'sweep'` — no new job type for housekeeping).
/**
 * The kg export job type.
 *
 * @stability experimental
 */
export const KG_EXPORT_JOB_TYPE = 'kg.export';
/**
 * The kg subject export.
 *
 * @stability experimental
 */
export const KG_SUBJECT_EXPORT = 'kg_export';
/**
 * The kg subject export sweep.
 *
 * @stability experimental
 */
export const KG_SUBJECT_EXPORT_SWEEP = 'kg_export_sweep';

// #387 — validate an uploaded RDF file against the SHACL shapes and turn it
// into an `import` proposal. Subject: the proposal it fills.
/**
 * The kg import job type.
 *
 * @stability experimental
 */
export const KG_IMPORT_JOB_TYPE = 'kg.import';
/**
 * The kg subject proposal.
 *
 * @stability experimental
 */
export const KG_SUBJECT_PROPOSAL = 'kg_proposal';

// #666 (GIC-05, epic #661) — promote the free-text `Meeting.topics[]` strings of
// past meetings to draft Topic proposals. Subject: the user (one run at a time).
/**
 * The kg topics promote job type: turns the topic strings of a user's past meetings into draft Topic proposals.
 *
 * @stability experimental
 */
export const KG_TOPICS_PROMOTE_JOB_TYPE = 'kg.topics_promote';

/** `storage_objects.managed_by` for every file the graph module writes (#386). */
/**
 * GRAPH_MANAGED_BY.
 *
 * @stability experimental
 */
export const GRAPH_MANAGED_BY = 'graph';
