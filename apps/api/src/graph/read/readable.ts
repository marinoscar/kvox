// =============================================================================
// What the graph read layer may show (#370, epic #347; docs/specs/ontology.md §5.5)
// =============================================================================
//
// ONE DEFINITION of "readable", imported by every read surface — the entity
// index and page (#370), the overview (#371), the brief (#372) and the Ask
// agent's tools (#377) — so none of them can drift into showing an
// `unreviewed` row, a `rejected` one, or a merge tombstone.
//
//   - `unreviewed` exists only inside a proposal; `rejected` is kept only so a
//     re-extraction remembers the "no". Neither is ever read here.
//   - `merged` is a tombstone (and entities additionally carry
//     `merged_into_id`); it is excluded from every read path.
//   - `superseded` is history. It is shown where history is the point: the
//     timeline (items) and every as-of evaluation (relations) — see below.
// =============================================================================

import type { KgMentionStatus, KgReviewStatus } from '@prisma/client';

import { AS_OF_STATUSES } from '../temporal';

/** Entities: also require `merged_into_id IS NULL`. */
export const READABLE_ENTITY_STATUSES = ['accepted', 'edited'] as const satisfies readonly KgReviewStatus[];

/** Relations as the CURRENT graph sees them (counts on the entity page). */
export const READABLE_RELATION_STATUSES = ['accepted', 'edited'] as const satisfies readonly KgReviewStatus[];

/**
 * Relations as an `as_of` question sees them: the readable set PLUS
 * `superseded`, exactly #353's `AS_OF_STATUSES`.
 *
 * The closing rule (§5.4) marks the REPORTS_TO edge it replaces `superseded`
 * and closes its range; an "as of January 2024" query must still read it. The
 * range predicate is what decides validity at an instant, so a superseded edge
 * whose range is closed never appears "now". Derived from the engine's own set
 * so the SQL and `edgesAsOf()` cannot disagree.
 */
export const AS_OF_RELATION_STATUSES: readonly KgReviewStatus[] = Object.freeze(
  (['accepted', 'edited', 'merged', 'superseded', 'rejected', 'unreviewed'] as const).filter((s) =>
    AS_OF_STATUSES.has(s),
  ),
);

/** Items everywhere except the timeline. */
export const READABLE_ITEM_STATUSES = ['accepted', 'edited'] as const satisfies readonly KgReviewStatus[];

/** The timeline also shows `superseded` items, flagged — history is the point. */
export const TIMELINE_ITEM_STATUSES = ['accepted', 'edited', 'superseded'] as const satisfies readonly KgReviewStatus[];

/** A mention the owner confirmed (or that created its entity). `suggested`/`ignored` are not shown. */
export const READABLE_MENTION_STATUSES = ['linked', 'new'] as const satisfies readonly KgMentionStatus[];
