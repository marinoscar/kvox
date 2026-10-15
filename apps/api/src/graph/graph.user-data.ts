// =============================================================================
// The knowledge graph in the Danger Zone (issue #357, epic #344; declared here
// by issue #460)
// =============================================================================
//
// The `graph` user-data category: what `GET /api/user-data/summary` reports as
// `graph` and what `user.data.purge` hands to `kg.purge` second. It used to be a
// `case 'graph'` in `user-data/job-types.ts`, two counts in `UserDataService` and
// a private method of `UserDataPurgeHandler`; the hooks now live in
// `graph.user-data.hooks.ts`. `kvox.manifest.ts` registers
// `GRAPH_USER_DATA_CATEGORY`.
//
// ⚠ THIS FILE MUST STAY LIGHT (see `ask.user-data.ts`): the hook class is
// referenced by `import type` and provided under the string token below.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { UserDataCategoryDef } from '../user-data/user-data.registries';
import type { GraphUserDataHooks } from './graph.user-data.hooks';

/** The provider token `GraphModule` binds `GraphUserDataHooks` under. */
export const GRAPH_USER_DATA_HOOKS = 'GRAPH_USER_DATA_HOOKS';

/**
 * The caller's knowledge graph (#357, epic #344) — removed by `content` and
 * `everything` through a `kg.purge` job. Row counts only: a graph row has no
 * storage object behind it, so there are no bytes to report.
 */
export const userDataGraphSchema = z.object({
  entities: z
    .number()
    .int()
    .describe(
      "How many entities (people, organizations, projects, meetings) the caller's graph " +
        'holds. Merge tombstones are excluded — a merged entity is the same thing as the ' +
        'one it was merged into.',
    ),
  items: z
    .number()
    .int()
    .describe(
      "How many facts (commitments, decisions, claims, person facts) the caller's graph holds.",
    ),
});

export class UserDataGraphDto extends createZodDto(userDataGraphSchema) {}

export const GRAPH_USER_DATA_CATEGORY: UserDataCategoryDef = {
  id: 'graph',
  label: 'Knowledge graph',
  description:
    "The caller's knowledge graph. Removed by `content` and `everything` only — no narrow " +
    'scope touches it. Your recordings and notes are what the graph was derived from; ' +
    'deleting the graph never changes them.',
  // ⚠ THE KNOWLEDGE GRAPH IS `content`/`everything` ONLY (#357, epic #344).
  //
  // The graph is derived content the user MADE, by reviewing and committing
  // proposals — so it follows `content` ("everything you made"), the same
  // line note templates sit on. None of the narrow scopes takes it: "Delete
  // transcripts" does not silently empty a graph the user curated by hand,
  // and a graph row whose cited transcript is gone keeps its `quote` (every
  // evidence anchor FK is SetNull, by design).
  //
  // A CATEGORY, NOT A SCOPE — like `onboarding`, it is not a requestable
  // scope, whose strings are permanent. The handler enqueues
  // `kg.purge { scope: 'all' }` for it rather than deleting inline. A deleted
  // ACCOUNT loses its graph separately, by the `owner_id` Cascade on every
  // `kg_*` table.
  content: true,
  order: 60,
  summary: {
    key: 'graph',
    schema: userDataGraphSchema.describe(
      "The caller's knowledge graph. Removed by `content` and `everything` only — no narrow " +
        'scope touches it. Your recordings and notes are what the graph was derived from; ' +
        'deleting the graph never changes them.',
    ),
    inject: GRAPH_USER_DATA_HOOKS,
    run: (hooks: GraphUserDataHooks, userId: string) => hooks.summarize(userId),
  },
  purge: {
    order: 20,
    inject: GRAPH_USER_DATA_HOOKS,
    run: (hooks: GraphUserDataHooks, userId: string) => hooks.purge(userId),
  },
};
