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
export const KG_SUBJECT_ENTITY = 'kg_entity';
export const KG_SUBJECT_NOTE = 'note';
export const KG_SUBJECT_TRANSCRIPT = 'transcript';
export const KG_SUBJECT_USER = 'user';

// Job types.
export const KG_SPEAKER_LINK_JOB_TYPE = 'kg.speaker_link';
export const KG_PURGE_JOB_TYPE = 'kg.purge';
export const KG_EXTRACT_JOB_TYPE = 'kg.extract';
export const KG_RESOLVE_JOB_TYPE = 'kg.resolve';
export const KG_EMBED_JOB_TYPE = 'kg.embed';
export const KG_ENTITY_DIGEST_JOB_TYPE = 'kg.entity_digest';
export const KG_GRAPH_LAYOUT_JOB_TYPE = 'kg.graph_layout';
