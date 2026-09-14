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
 * ⚠ THE UPPERCASING IS NOT DERIVED AT RUNTIME. `scope.toUpperCase()` would be
 * shorter and would be wrong in the way that matters: it would keep compiling,
 * and keep producing a plausible-looking string, on the day the API's literal
 * for a new scope stops being a straight uppercasing of its id. The record is
 * `Record<UserDataScope, string>`, so adding a scope to the union without
 * adding its literal here is a compile error rather than a 400 in production.
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
  /** Must equal `USER_DATA_CONFIRMATION[scope]`; the API enforces it as a Zod literal. */
  confirmation: string;
}

/**
 * The exact strings the API's Zod literals require — one per scope, all
 * different. See the file header for why this is a written-out record rather
 * than `scope.toUpperCase()`.
 */
export const USER_DATA_CONFIRMATION: Record<UserDataScope, string> = {
  transcripts: 'TRANSCRIPTS',
  notes: 'NOTES',
  files: 'FILES',
  content: 'CONTENT',
  everything: 'EVERYTHING',
};

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
