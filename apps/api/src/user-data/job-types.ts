// =============================================================================
// The user-data module's queue vocabulary (issue #80)
// =============================================================================
//
// One job type, one subject type, and the five scopes a user may ask this
// application to forget. They live in their own file — rather than beside the
// handler that registers them, or beside the controller that enqueues them —
// for the reason `notes/job-types.ts` and `transcripts/job-types.ts` already
// state: the controller, the handler, the module and (later) a test all name
// the same strings, and a string spelled in four places is a string that will
// eventually be spelled two ways. `Job.type` is a plain text column precisely
// so a new type costs no migration, which also means nothing but agreement
// between these call sites keeps them in step.
// =============================================================================

import { userDataScopeIds, userDataScopeReaches } from './user-data.registries';

/**
 * Delete, in bulk, the data one user owns.
 *
 * ⚠ SERVER-ONLY PERMANENTLY, and `maxAttempts: 1`. Both decisions are argued
 * in full in `handlers/user-data-purge.handler.ts`'s header; neither is a
 * default that happened to be left alone.
 */
export const USER_DATA_PURGE_JOB_TYPE = 'user.data.purge';

/**
 * `Job.subject_type` for the one type above.
 *
 * The subject is the USER whose data is going, not a transcript or a note —
 * which is exactly what makes the queue's own active-dedup index
 * (`jobs_active_dedup_uniq_idx` over `(type, subject_type, subject_id)` while
 * `pending`/`running`) the real enforcement of "one deletion at a time per
 * user". See `UserDataService.requestDeletion` for why that index, rather than
 * a `findFirst` before the insert, is what the 409 is built on.
 *
 * Plain text with no enum and no foreign key, matching the column: a fork's
 * own subjects cannot be enumerated in a schema this repository ships.
 */
export const USER_DATA_SUBJECT_TYPE = 'user';

/**
 * One of the registered scope ids (see {@link USER_DATA_SCOPES}).
 *
 * A plain `string` since issue #460: the scope set is composed from the scope
 * registry (`user-data.registries.ts`) rather than closed over a literal union,
 * because two of its members (`transcripts`, `notes`) are declared by their
 * domains. The ids themselves are unchanged and still permanent.
 */
export type UserDataScope = string;

/**
 * What a deletion request may ask for.
 *
 * ORDERED NARROWEST-FIRST, and the order is the one the UI renders: three
 * single-category scopes, then the two composites. Each narrow scope deletes
 * EXACTLY the category its row names and nothing else — see `scopeIncludes`,
 * where `noteTemplates` is the case that rule had to be defended on. `content`
 * is everything the user MADE: transcripts, notes, their own note templates and
 * their plain uploads. `everything` is that plus the two things that are NOT
 * content — their CREDENTIALS and their first-run ONBOARDING state — and that
 * is the only line the two composites differ on: "delete my content" and
 * "delete my content, revoke my keys and start me over" are two decisions a
 * person makes separately.
 *
 * COMPOSED FROM THE SCOPE REGISTRY (issue #460): `transcripts` and `notes` are
 * declared by their domains, `files`, `content` and `everything` by
 * `user-data.base.ts`, and `kvox.manifest.ts` registers them. Like the settings
 * composers, reading this before the manifest has run is a wiring bug, so it
 * throws instead of yielding an empty list that would make every scope
 * "unknown".
 *
 * ⚠ THESE STRINGS ARE PERMANENT ONCE A JOB CARRIES ONE. A `user.data.purge`
 * row's payload records the scope it was queued for, and a handler that ran
 * days later against a renamed member would silently widen or narrow what it
 * destroys — the one kind of drift this feature cannot afford.
 */
export const USER_DATA_SCOPES: readonly UserDataScope[] = composeScopes();

function composeScopes(): readonly UserDataScope[] {
  const ids = userDataScopeIds();

  if (ids.length === 0) {
    throw new Error(
      'User-data scopes are not registered: import apps/api/src/kvox.manifest before anything ' +
        'that reads USER_DATA_SCOPES.',
    );
  }

  return Object.freeze(ids);
}

/**
 * Whether `scope` includes the given category.
 *
 * ⚠ ONE DEFINITION OF WHAT EACH SCOPE MEANS, shared by the controller (which
 * validates nothing with it) and the handler (which decides every destructive
 * step with it). A second, independently-written `scope === 'content' ||
 * scope === 'everything'` somewhere else is how a composite scope comes to mean
 * one thing at request time and another at run time — and because the two are
 * separated by a queue and by minutes, nothing would report the disagreement.
 *
 * REGISTRY-DRIVEN since issue #460: the matrix is no longer a `switch` naming
 * every domain. Each narrow scope lists the category it maps to; the two
 * composites are resolved from each category's `content` flag (`content` = the
 * categories with `content: true`, `everything` = all of them). The matrix is
 * unchanged, and `registrations.characterization.spec.ts` pins it.
 *
 * ⚠ EVERY NARROW SCOPE MAPS TO EXACTLY ONE CATEGORY. Only the composites fan
 * out. The arguments for where each category sits live beside the category, in
 * its declaring file: `noteTemplates`, `notes` -> `notes/notes.user-data.ts`;
 * `graph` -> `graph/graph.user-data.ts`; `ask` -> `ask/ask.user-data.ts`;
 * `credentials`, `onboarding` -> `user-data.base.ts`.
 *
 * Total over strings: an unknown scope or category answers `false`.
 */
export function scopeIncludes(scope: UserDataScope, category: string): boolean {
  return userDataScopeReaches(scope, category);
}

/**
 * The word a caller must type to authorise `scope`.
 *
 * ⚠ SCOPE-SPECIFIC ON PURPOSE — a single constant like `DELETE` would mean a
 * confirmation typed into the "delete my files" dialog authorises the
 * "everything" request the user's second click actually sent. Here the token
 * and the scope are the same word, so a mismatched pair is refused rather than
 * honoured. Uppercasing is the whole rule; there is no lookup table to fall out
 * of step with {@link USER_DATA_SCOPES}.
 */
export function confirmationFor(scope: UserDataScope): string {
  return scope.toUpperCase();
}
