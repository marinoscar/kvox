/**
 * The user-data deletion API, as the web app sees it — issue #80.
 *
 * Shaped after `services/ai.ts`: `services/api.ts` stays the transport (the
 * `ApiService` instance, the refresh dance, the maintenance recogniser), and
 * this module holds the two `/user-data` calls next to the types they produce.
 *
 * =============================================================================
 * NO PERMISSION STRING, AND THAT IS THE API'S OWN SHAPE
 * =============================================================================
 *
 * `apps/api/src/user-data/`'s controller gates both routes on `@Auth()` with NO
 * permission, deliberately, and for the same reason `ai-credentials.controller
 * .ts` and `/api/user-settings` do: the resource is the CALLER'S OWN data,
 * scoped by `userId` in the query itself. There is no role in this application
 * that should decide whether a person may delete the recordings they uploaded.
 * Nothing in this module, the hook above it, or the page above that consults
 * `usePermissions` — see `config/userSettingsSections.tsx`'s card comment.
 *
 * =============================================================================
 * BYTES ARE DECIMAL STRINGS, NOT NUMBERS — DO NOT "FIX" THAT
 * =============================================================================
 *
 * Every `bytes` field below is a `string`, mirroring `services/dbBackup.ts`'s
 * `sizeBytes`/`bytesWritten`. The API sums Postgres `BIGINT` columns, and a sum
 * over a library of multi-gigabyte recordings can exceed `Number.MAX_SAFE_
 * INTEGER` — at which point a JSON number silently loses precision on the wire,
 * before this code ever sees it. The string is the honest representation; it is
 * parsed exactly once, at the edge of rendering, by `dbBackupTable.ts`'s
 * `formatBytes`, which already takes a string for this exact reason.
 *
 * =============================================================================
 * THE CONFIRMATION LITERAL IS PER SCOPE, AND IT IS EXPORTED
 * =============================================================================
 *
 * `USER_DATA_CONFIRMATION` is the scope, uppercased — five different words, one
 * per action, exactly the reasoning `ROTATE`/`REMOVE` (`services/pushConfig.ts`)
 * and `RESTORE`/`ROLLBACK` (`services/dbBackup.ts`) already establish here: a
 * word typed for one destructive action must never be able to authorise
 * another. The literals are the API's own Zod literals, exported as a record so
 * a dialog compares against a constant rather than a string re-typed in a
 * component, and so a test can import the same source of truth the UI uses
 * instead of hardcoding "EVERYTHING" a third time.
 *
 * ⚠ THE UPPERCASING IS WRITTEN OUT, NOT DERIVED. The API's own
 * `confirmationFor(scope)` (`apps/api/src/user-data/job-types.ts`) is
 * `scope.toUpperCase()`, and mirroring that one-liner here would be shorter —
 * but it would be a SECOND, independently-written definition of the rule, which
 * is exactly the drift that file's own header warns about for the scope strings
 * themselves. A `Record<UserDataScope, string>` fails differently and better:
 * adding a scope to the union without adding its word is a compile error here,
 * where `scope.toUpperCase()` would keep compiling and keep producing a
 * plausible-looking string that the API refuses with a 400 in production.
 */

import { api } from './api';

/**
 * What a deletion request covers.
 *
 * The two compound scopes are not sugar for "run the three narrow ones":
 * `content` is every transcript, note, note template and standalone upload;
 * `everything` is all of that PLUS the caller's stored AI provider keys and
 * personal access tokens. Neither deletes the ACCOUNT — see the page's copy.
 */
export type UserDataScope = 'transcripts' | 'notes' | 'files' | 'content' | 'everything';

/** A count/size pair, as the summary reports one category. */
export interface UserDataCategorySummary {
  count: number;
  /** A DECIMAL STRING, never a number — see the file header. */
  bytes: string;
}

/**
 * `GET /api/user-data/summary` — what the caller currently has, and whether a
 * deletion is already under way.
 *
 * `activeDeletion` being non-null is the page's single disabling condition: the
 * work is a background queue job, so a second request would be refused with a
 * 409 anyway, and a UI that let one be attempted would be offering a button
 * whose only outcome is an error.
 */
export interface UserDataSummary {
  transcripts: UserDataCategorySummary;
  notes: UserDataCategorySummary;
  /** Standalone uploads only — NOT the objects a transcript or note manages. */
  files: UserDataCategorySummary;
  /** Templates have no meaningful byte weight, so this pair carries only a count. */
  noteTemplates: { count: number };
  credentials: { aiKeys: number; accessTokens: number };
  /**
   * The caller's knowledge graph (issue #357) — row counts only, no bytes: the
   * graph is rows of structured text with no storage object behind them.
   * `entities` excludes merged tombstones; `items` is every commitment,
   * decision, claim and person fact. Deleted by `content` and `everything`
   * only — never by a narrow scope, and there is deliberately no narrow
   * `graph` scope.
   */
  graph: { entities: number; items: number };
  activeDeletion: UserDataDeletion | null;
}

/** `POST /api/user-data/deletions` — the 202 body, and `summary.activeDeletion`. */
export interface UserDataDeletion {
  id: string;
  scope: UserDataScope;
  /** The queue job's own state, passed through verbatim; the UI only tests for presence. */
  status: string;
  requestedAt: string;
}

/** `POST /api/user-data/deletions` request body. */
export interface CreateUserDataDeletionInput {
  scope: UserDataScope;
  /** Must equal `USER_DATA_CONFIRMATION[scope]`; a mismatch is a 400 naming the expected word. */
  confirmation: string;
}

/**
 * The exact strings the API requires — one per scope, all different.
 *
 * Checked in `UserDataService.requestDeletion` against `confirmationFor(scope)`
 * and answered with a **400** naming the expected word when it does not match.
 * See the file header for why this is a written-out record rather than
 * `scope.toUpperCase()`.
 */
export const USER_DATA_CONFIRMATION: Record<UserDataScope, string> = {
  transcripts: 'TRANSCRIPTS',
  notes: 'NOTES',
  files: 'FILES',
  content: 'CONTENT',
  everything: 'EVERYTHING',
};

// =============================================================================
// Scope semantics — a deliberate mirror of the API's own `scopeIncludes`
// =============================================================================

/**
 * The six categories a scope may or may not cover.
 *
 * Named exactly as `apps/api/src/user-data/job-types.ts` names them, and in the
 * same order, so the two functions can be read side by side.
 */
export type UserDataCategory =
  | 'transcripts'
  | 'notes'
  | 'noteTemplates'
  | 'files'
  | 'credentials'
  | 'onboarding';

/** Every category, for callers that need to ask about all of them. */
export const USER_DATA_CATEGORIES: readonly UserDataCategory[] = [
  'transcripts',
  'notes',
  'noteTemplates',
  'files',
  'credentials',
  'onboarding',
];

/**
 * Whether `scope` covers `category` — a MIRROR of `scopeIncludes` in
 * `apps/api/src/user-data/job-types.ts`, which is the authority.
 *
 * ⚠ THIS IS A SECOND IMPLEMENTATION OF A RULE THE SERVER OWNS, and that is
 * worth being uncomfortable about, so here is the whole argument for it.
 *
 * It exists so the confirmation dialog can state what is about to be destroyed
 * IN NUMBERS at the moment of decision, and there is no way to get that from
 * the server: `GET /api/user-data/summary` reports each category's count
 * independently and says nothing about which scope covers which. The
 * alternative is not "no duplication" — it is duplication in a worse place. A
 * dialog that hardcoded "content means transcripts + notes + templates +
 * files" would be the same rule, spelled in prose, inside a string, where
 * nothing could grep it. That is exactly how the earlier `notes`-claims-
 * templates copy went wrong and had to be reversed: the coupling lived in a
 * sentence, so nothing connected it to the function that actually decided.
 *
 * Written as the same `switch` on the same category union rather than as a
 * lookup table, so a diff against the API file is a genuine line-by-line
 * comparison. What keeps them in step is that this is the only copy on this
 * side, every caller goes through it, and a category added to the union above
 * without a case here is a compile error.
 *
 * ⚠ IT IS NEVER AN AUTHORIZATION OR A GUARANTEE. Nothing here decides what gets
 * deleted — the handler does, from the server's own copy. This answers one
 * question only: what should this dialog tell the user is about to go. If the
 * two ever disagree, the server wins and the dialog was misleading, which is
 * why the header comments on both sides point at each other.
 */
export function scopeIncludes(scope: UserDataScope, category: UserDataCategory): boolean {
  switch (category) {
    // Every narrow scope maps to exactly one category; only the composites fan
    // out.
    case 'transcripts':
      return scope === 'transcripts' || scope === 'content' || scope === 'everything';
    case 'notes':
      return scope === 'notes' || scope === 'content' || scope === 'everything';
    case 'files':
      return scope === 'files' || scope === 'content' || scope === 'everything';
    // ⚠ NOTE TEMPLATES ARE `content`/`everything` ONLY — the narrow `notes`
    // scope does not touch them. A template is reusable CONFIGURATION with its
    // own settings destination (`/settings/note-templates`), authored
    // independently of any particular note and meant for notes that do not
    // exist yet, so "Delete notes" must not empty a page the user never opened.
    case 'noteTemplates':
      return scope === 'content' || scope === 'everything';
    // ⚠ CREDENTIALS ARE `everything` ONLY. Revoking a user's API tokens is not
    // implied by deleting their recordings.
    case 'credentials':
      return scope === 'everything';
    // ⚠ ONBOARDING IS `everything` ONLY, and it is the one category here with
    // NO COUNT. It is not content the user made; it is the first-run state this
    // application wrote about them, cleared so a full wipe genuinely starts
    // over (epic #271). It is listed because this mirror's whole job is to
    // match the server's switch — `userDataDisplay.ts` skips it when building
    // the itemised inventory, since "1 onboarding" is not a sentence.
    case 'onboarding':
      return scope === 'everything';
  }
}

/**
 * Whether a scope covers more than one category — i.e. whether its name alone
 * fails to say what it takes.
 *
 * DERIVED, NOT A LIST OF THE TWO COMPOSITES. This is what decides whether a
 * confirmation dialog is worth showing an itemised inventory for: a narrow
 * scope names one category whose count the user just read on the row they
 * clicked, and restating it would be noise. Deriving it means a scope that
 * later grew a second category would start showing an inventory on its own,
 * instead of silently keeping a one-line dialog that no longer describes it.
 */
export function scopeIsCompound(scope: UserDataScope): boolean {
  return USER_DATA_CATEGORIES.filter((category) => scopeIncludes(scope, category)).length > 1;
}

const BASE = '/user-data';

/** `GET /api/user-data/summary` — `@Auth()`, no permission. */
export async function getUserDataSummary(): Promise<UserDataSummary> {
  return api.get<UserDataSummary>(`${BASE}/summary`);
}

/**
 * `POST /api/user-data/deletions` — `@Auth()`, no permission. DESTRUCTIVE, and
 * permanently so: there is no undo and no user-triggerable restore.
 *
 * Answers **202**, not 200: the deletion is enqueued as a background job and
 * continues whether or not the tab stays open. The returned row is the same
 * shape `summary.activeDeletion` carries, so a caller can adopt it directly
 * instead of re-reading the summary just to learn that something is running.
 *
 * ⚠ **409 WHEN ONE IS ALREADY RUNNING.** That is a real, reachable state (two
 * tabs, or a reload mid-run), not a defensive check — which is why the hook
 * surfaces the API's own message rather than a generic failure string.
 *
 * The confirmation is filled in HERE from the scope, so no caller can send a
 * scope and a literal that disagree.
 */
export async function createUserDataDeletion(
  scope: UserDataScope,
): Promise<UserDataDeletion> {
  const body: CreateUserDataDeletionInput = {
    scope,
    confirmation: USER_DATA_CONFIRMATION[scope],
  };
  return api.post<UserDataDeletion>(`${BASE}/deletions`, body);
}
