import type { AiTaskKey } from '../tasks/index.js';

// =============================================================================
// The AI features this app registers (issue #473, epic #472)
// =============================================================================
//
// One id per AI call site, registered with `registerAiFeature` in
// `apps/api/src/app-registrations/ai.ts`. The id rides on every usage row
// (`GET /api/admin/ai/usage` groups by it), so it is PERMANENT: never rename or
// reuse one. Ids are lower snake case because the platform refuses a dot
// (`INVALID_ID`); the connected-knowledge task keys (`graph.extract`) keep their
// dots, they are a different vocabulary (`ai.taskModels`).
// =============================================================================

/**
 * Every AI feature id, one per call site. Permanent: an id rides on every usage row.
 *
 * @stability experimental
 */
export const KVOX_AI_FEATURES = [
  'note_generate',
  'note_retitle',
  'transcript_name_check',
  'graph_extract',
  'graph_adjudicate',
  'graph_digest',
  'graph_agent',
  'graph_embed',
  'search_embed',
] as const;

/**
 * One AI feature id.
 *
 * @stability experimental
 */
export type KvoxAiFeatureId = (typeof KVOX_AI_FEATURES)[number];

/**
 * The connected-knowledge task a feature runs under, or `null` for a feature
 * the administrator does not route per task. A feature with a task is chosen by
 * `chooseTaskModel`; one without takes the requested model, else the default.
  *
  * @stability experimental
 */
export const KVOX_FEATURE_TASK: Readonly<Record<KvoxAiFeatureId, AiTaskKey | null>> = {
  note_generate: null,
  note_retitle: null,
  transcript_name_check: null,
  graph_extract: 'graph.extract',
  graph_adjudicate: 'graph.adjudicate',
  graph_digest: 'graph.digest',
  graph_agent: 'graph.agent',
  graph_embed: null,
  search_embed: null,
};

/**
 * The features that call an embeddings model, which the catalog (not the policy) picks.
 *
 * @stability experimental
 */
export const KVOX_EMBEDDING_FEATURES: readonly KvoxAiFeatureId[] = ['graph_embed', 'search_embed'];

/**
 * True when `feature` is one this app registered.
 *
 * @stability experimental
 */
export function isKvoxAiFeature(feature: string | undefined): feature is KvoxAiFeatureId {
  return feature !== undefined && (KVOX_AI_FEATURES as readonly string[]).includes(feature);
}
