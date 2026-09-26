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
  category:
    | 'transcripts'
    | 'notes'
    | 'noteTemplates'
    | 'files'
    | 'credentials'
    | 'onboarding'
    | 'graph',
): boolean {
  switch (category) {
    // ⚠ EVERY NARROW SCOPE MAPS TO EXACTLY ONE CATEGORY. Only the composites
    // fan out. That symmetry is the rule the three cases below hold, and the
    // `noteTemplates` case is the one that had to be argued for rather than
    // assumed — see its own comment.
    case 'transcripts':
      return scope === 'transcripts' || scope === 'content' || scope === 'everything';
    case 'notes':
      return scope === 'notes' || scope === 'content' || scope === 'everything';
    case 'files':
      return scope === 'files' || scope === 'content' || scope === 'everything';
    // ⚠ NOTE TEMPLATES ARE `content`/`everything` ONLY — THE NARROW `notes`
    // SCOPE DOES NOT TOUCH THEM.
    //
    // A template is not note CONTENT; it is reusable CONFIGURATION. It has its
    // own settings destination (`/settings/note-templates`), it is authored
    // deliberately and independently of any particular note, and its whole
    // purpose is to be used by notes that DO NOT EXIST YET — so "the notes are
    // gone, therefore the recipes are meaningless" is exactly backwards.
    //
    // The user-facing consequence is the argument. A person clicking "Delete
    // notes" on a row whose inventory reads "12 notes · 340 MB" has been told
    // they are deleting notes; silently emptying a different settings page they
    // did not open is the kind of surprise a Danger Zone can least afford. And
    // unlike the data itself, templates were HAND-WRITTEN and are recoverable
    // from nowhere — there is no provider, no bucket and no source recording to
    // rebuild one from.
    //
    // The composites still take them, and that is consistent rather than a
    // compromise: `content` means "everything you made", and a template is
    // something you made.
    case 'noteTemplates':
      return scope === 'content' || scope === 'everything';
    // ⚠ CREDENTIALS ARE `everything` ONLY. Revoking a user's API tokens is not
    // implied by "delete my recordings", and a `content` scope that silently
    // signed out their CLI would be a surprise with no way back.
    case 'credentials':
      return scope === 'everything';
    // ⚠ ONBOARDING IS `everything` ONLY, for a reason RELATED TO CREDENTIALS
    // RATHER THAN TO THE FOUR CONTENT CATEGORIES ABOVE: it is not something the
    // user MADE. The `onboarding` user-settings namespace (epic #271, issue
    // #272) holds first-run INTENT — `welcomeSeenAt`, `dismissedAt`,
    // `adminDismissedAt`, `skipped[]` — state this application wrote about the
    // user rather than content the user authored, which is exactly what keeps
    // it out of `content` ("everything you made") on the same line credentials
    // sit on.
    //
    // A full wipe should genuinely start over, and without this it did not.
    // The checklist itself is DERIVED on every read, so after an `everything`
    // run its required steps correctly go outstanding again (no transcripts,
    // no AI key) — but the surviving `dismissedAt` makes
    // `chooseBannerAudience` bail and the surviving `welcomeSeenAt` makes
    // `FirstRunWelcomeDialog`'s `due` gate bail, so the user is never shown the
    // guidance those steps exist to give. A person who deleted everything and
    // then saw no first-run guidance at all would reasonably conclude the
    // feature was broken.
    //
    // ⚠ THIS CATEGORY IS NOT A MEMBER OF `USER_DATA_SCOPES`, deliberately.
    // That array's strings are permanent once a queued payload records one;
    // this union is internal to this function and names the STEPS a scope fans
    // out to, not the requests a caller may make. There is no "delete my
    // onboarding state" scope and there should not be — the replay button on
    // `/settings/getting-started` is already that, without destroying anything.
    case 'onboarding':
      return scope === 'everything';
    // ⚠ THE KNOWLEDGE GRAPH IS `content`/`everything` ONLY (#357, epic #344).
    //
    // The graph is derived content the user MADE, by reviewing and committing
    // proposals — so it follows `content` ("everything you made"), the same
    // line note templates sit on. None of the narrow scopes takes it: "Delete
    // transcripts" does not silently empty a graph the user curated by hand,
    // and a graph row whose cited transcript is gone keeps its `quote` (every
    // evidence anchor FK is SetNull, by design).
    //
    // A CATEGORY, NOT A SCOPE — like `onboarding`, it is not a member of
    // `USER_DATA_SCOPES`, whose strings are permanent. The handler enqueues
    // `kg.purge { scope: 'all' }` for it rather than deleting inline. A deleted
    // ACCOUNT loses its graph separately, by the `owner_id` Cascade on every
    // `kg_*` table. (#376 adds `case 'ask'` beside this one — additive cases.)
    case 'graph':
      return scope === 'content' || scope === 'everything';
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
