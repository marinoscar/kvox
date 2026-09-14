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
 * What a deletion request may ask for.
 *
 * ORDERED NARROWEST-FIRST, and the order is the one the UI renders: three
 * single-category scopes, then the two composites. `content` is
 * transcripts + notes + the note templates that go with them; `everything` is
 * that plus the caller's unmanaged files and their credentials.
 *
 * ⚠ THESE STRINGS ARE PERMANENT ONCE A JOB CARRIES ONE. A `user.data.purge`
 * row's payload records the scope it was queued for, and a handler that ran
 * days later against a renamed member would silently widen or narrow what it
 * destroys — the one kind of drift this feature cannot afford.
 */
export const USER_DATA_SCOPES = [
  'transcripts',
  'notes',
  'files',
  'content',
  'everything',
] as const;

/** One of {@link USER_DATA_SCOPES}. */
export type UserDataScope = (typeof USER_DATA_SCOPES)[number];

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
 * Pure, exported and dependency-free so the whole scope matrix is testable
 * without a database, a queue or a Nest module.
 */
export function scopeIncludes(
  scope: UserDataScope,
  category: 'transcripts' | 'notes' | 'noteTemplates' | 'files' | 'credentials',
): boolean {
  switch (category) {
    // Note templates travel with notes rather than being a scope of their own:
    // a template is the recipe a note was generated from, and a user asking for
    // their notes to be gone is not asking to keep the recipes that only make
    // sense beside them. `files` deliberately does NOT drag them along.
    case 'transcripts':
      return scope === 'transcripts' || scope === 'content' || scope === 'everything';
    case 'notes':
    case 'noteTemplates':
      return scope === 'notes' || scope === 'content' || scope === 'everything';
    case 'files':
      return scope === 'files' || scope === 'everything';
    // ⚠ CREDENTIALS ARE `everything` ONLY. Revoking a user's API tokens is not
    // implied by "delete my recordings", and a `content` scope that silently
    // signed out their CLI would be a surprise with no way back.
    case 'credentials':
      return scope === 'everything';
  }
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
