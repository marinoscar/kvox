import type { Prisma } from '@prisma/client';
import type { UserDataModelHint } from '@marinoscar/platform-api/user-data';
import { KG_PURGE_JOB_TYPE } from '@marinoscar/kvox-api/graph';

// =============================================================================
// The graph slice's registrations with the platform's user-data slice (the Danger Zone)
// (issue #80, epic #78; moved next to the slice's configuration by issue #496, epic #491)
// =============================================================================
//
// What the platform's "delete my data" feature needs to know about the knowledge graph: one category
// (`graph`) and a hint per Prisma model saying how its rows go. Every `Kg*` model DELEGATES to ONE
// `kg.purge` job (`{ scope: 'all', userId }`): the platform enqueues it after its own rows commit and
// the handler removes the whole graph in dependency order, re-entrantly, because the graph's
// foreign keys and the deferred `kg_assert_has_evidence` trigger make a row-by-row cascade unsafe.
// All hints share the same delegate object, so the job is enqueued once.
//
// `user-data.manifest.ts` registers these, in the same relative position the entries had before the
// move; the scopes `content` and `everything` list the category id there.
// =============================================================================

/** The whole-graph purge (the permanent job type string). */
export const GRAPH_PURGE_DELEGATE = KG_PURGE_JOB_TYPE;

/** The category the graph owns. */
export const GRAPH_USER_DATA_CATEGORY = {
  id: 'graph',
  label: 'Knowledge graph',
  description:
    'Your knowledge graph. Your recordings and notes are what it was derived from; deleting the graph never changes them.',
  content: true,
  order: 5,
} as const;

/** One delegate for the whole graph: every `Kg*` hint shares it, so it is enqueued once. */
const graphDelegate = {
  jobType: GRAPH_PURGE_DELEGATE,
  payload: (userId: string): Record<string, unknown> => ({ scope: 'all', userId }),
};

const graphModel = (model: Prisma.ModelName): UserDataModelHint<Prisma.ModelName> => ({
  model,
  category: 'graph',
  delegate: graphDelegate,
});

/**
 * The model hints of the graph tables.
 *
 * @returns the hints for every `Kg*` model.
 */
export function graphUserDataModels(): Array<UserDataModelHint<Prisma.ModelName>> {
  return [
    graphModel('KgEntity'),
    graphModel('KgEntityAlias'),
    graphModel('KgRelation'),
    graphModel('KgItem'),
    graphModel('KgEvidence'),
    graphModel('KgMention'),
    graphModel('KgProposal'),
    graphModel('KgMerge'),
    graphModel('KgDistinctPair'),
    graphModel('KgAttributeDef'),
    graphModel('KgEntityDigest'),
    graphModel('KgExport'),
    graphModel('KgGraphLayout'),
    graphModel('KgEntityView'),
  ];
}
