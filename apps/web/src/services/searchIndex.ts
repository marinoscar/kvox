/**
 * The semantic-index status API, as the web app sees it — issue #191,
 * epic #165.
 *
 * Shaped after `services/userData.ts`: `services/api.ts` stays the transport
 * (the `ApiService` instance, the refresh dance, the maintenance recogniser),
 * and this module holds the two `/search` indexing calls next to the types they
 * produce and the plain-language strings the page renders.
 *
 * =============================================================================
 * NO PERMISSION STRING, AND THAT IS THE API'S OWN SHAPE
 * =============================================================================
 *
 * `apps/api/src/search/indexing/search-index.controller.ts` gates both routes
 * on `@Auth()` with NO permission, deliberately, and for the same reason
 * `user-data.controller.ts` and `ai-credentials.controller.ts` do: the resource
 * is the CALLER'S OWN content and the CALLER'S OWN vendor account, scoped by
 * `ownerId` in the query itself. Nothing in this module, the hook above it, or
 * the page above that consults `usePermissions` — see
 * `config/userSettingsSections.tsx`'s card comment.
 *
 * =============================================================================
 * THE REASON STRINGS ARE TRANSLATED HERE, ONCE
 * =============================================================================
 *
 * `search_index_state.reason` is a plain TEXT column and deliberately not an
 * enum (see the schema): it is a diagnostic string for a human, and it grows
 * new values as new failure modes are found. So:
 *
 *   • the translation is a LOOKUP WITH A FALLBACK, never a `switch` that must
 *     be exhaustive — an unrecognised reason renders as itself rather than
 *     disappearing or crashing the row. The failure worth showing is the one
 *     nobody has seen before.
 *   • it lives in this module rather than in the page, because the library
 *     feed's notice and the settings page both need it and a component
 *     importing its sibling page would be the wrong direction.
 */

import { api } from './api';

/** The document kinds this build can index. Mirrors the API's own union. */
export type SearchIndexDocumentType = 'transcript' | 'note';

/** One document type's five numbers. */
export interface SearchIndexTypeCounts {
  type: SearchIndexDocumentType;
  indexed: number;
  /** Queued **or** being indexed right now — the API reports the two as one. */
  pending: number;
  failed: number;
  skipped: number;
  /**
   * Documents with NO indexing record at all.
   *
   * ⚠ THE NUMBER THIS WHOLE PAGE EXISTS FOR. Every other count needs a row to
   * exist; this one is what a library looks like before anybody presses the
   * button, and without it "0 indexed, 0 pending, 0 failed" reads as a healthy
   * empty state rather than as the degradation it is.
   */
  unindexed: number;
  total: number;
}

/** One document whose indexing did not succeed. */
export interface SearchIndexFailure {
  type: SearchIndexDocumentType;
  id: string;
  title: string;
  /** A diagnostic token, NOT an enum — render an unknown value as itself. */
  reason: string | null;
  lastError: string | null;
}

/** `GET /api/search/index-status`. */
export interface SearchIndexStatus {
  types: SearchIndexTypeCounts[];
  /** The embedding model the active provider would use, or null. */
  model: string | null;
  /** ⚠ Whether **you** have a key — per-caller, never per-deployment. */
  hasKey: boolean;
  /** Whether this deployment can embed at all. Independent of `hasKey`. */
  available: boolean;
  /** Which of the two is missing, when one is. */
  reason: string | null;
  failures: SearchIndexFailure[];
}

/** `POST /api/search/index` — the 202 body. */
export interface SearchIndexRequestResult {
  queued: number;
  /** Left over because the per-call cap was reached. `0` when the library is done. */
  remaining: number;
  cap: number;
}

const BASE = '/search';

/** `GET /api/search/index-status` — `@Auth()`, no permission. */
export async function getSearchIndexStatus(): Promise<SearchIndexStatus> {
  return api.get<SearchIndexStatus>(`${BASE}/index-status`);
}

/**
 * `POST /api/search/index` — `@Auth()`, no permission.
 *
 * ⚠ SPENDS THE CALLER'S OWN AI PROVIDER ACCOUNT. Answers **202**: the work is
 * queued and continues whether or not the tab stays open.
 *
 * ⚠ **409 when indexing cannot run** — `details.reason` is `ai_key_missing`,
 * `ai_not_configured` or `embedding_unsupported`. That is a real, reachable
 * state (a key removed in another tab, an administrator switching AI off), so
 * the hook surfaces the API's own message rather than a generic failure string.
 *
 * There is no body: the caller is the JWT's subject and nothing else can be
 * named.
 */
export async function requestSearchIndex(): Promise<SearchIndexRequestResult> {
  return api.post<SearchIndexRequestResult>(`${BASE}/index`, {});
}

// =============================================================================
// Display
// =============================================================================

/**
 * Plain-language versions of the reason tokens this build writes.
 *
 * ⚠ A LOOKUP, NOT AN EXHAUSTIVE MAPPING. See the file header: the column grows
 * values, and `describeIndexReason` falls back to the raw token rather than
 * dropping a row it does not recognise.
 */
const REASON_TEXT: Record<string, string> = {
  ai_key_missing:
    'No AI provider key was saved for your account when this ran, so there was nothing to index with.',
  ai_key_invalid: 'Your AI provider refused the key that was saved for your account.',
  ai_not_configured:
    'This deployment has no AI provider configured, so nothing can be indexed for semantic search.',
  embedding_unsupported:
    'The AI provider this deployment uses does not offer embeddings, so semantic search is unavailable here.',
  dimension_mismatch:
    'The provider returned an embedding of an unexpected size. This is a bug rather than a problem with your document — please report it.',
};

/** One document's failure, in a sentence, with the raw token as the fallback. */
export function describeIndexReason(reason: string | null): string {
  if (!reason) return 'Indexing failed without reporting a reason.';

  return REASON_TEXT[reason] ?? `Indexing reported: ${reason}`;
}

/**
 * Why indexing cannot run at all, for the notice above a disabled button.
 *
 * Returns `null` when it can. The `ai_key_missing` sentence deliberately names
 * WHOSE account is involved and links nowhere on its own — the page adds the
 * link to `/settings/ai`, because a string that carries markup is a string that
 * cannot be asserted on.
 */
export function describeUnavailableReason(status: SearchIndexStatus): string | null {
  if (status.available && status.hasKey) return null;

  if (!status.available) {
    return status.reason === 'embedding_unsupported'
      ? 'The AI provider this deployment is configured for does not offer embeddings, so nothing can be indexed for semantic search. Your administrator can change the provider.'
      : 'This deployment has no AI provider configured yet, so nothing can be indexed for semantic search. Your administrator sets this up.';
  }

  return 'You have not saved an AI provider key. Indexing your library runs on your own provider account, so it needs your key.';
}

/** The label for one document type, singular and plural. */
export const DOCUMENT_TYPE_LABELS: Record<
  SearchIndexDocumentType,
  { singular: string; plural: string }
> = {
  transcript: { singular: 'Recording', plural: 'Recordings' },
  note: { singular: 'Note', plural: 'Notes' },
};

/** How many of this caller's documents indexing would act on right now. */
export function countNeedingIndex(status: SearchIndexStatus | null): number {
  if (!status) return 0;

  // `unindexed` plus everything that did not end up indexed. `pending` is
  // excluded: that work is already queued, and counting it would make the
  // button's own number fail to reach zero while a batch drains.
  return status.types.reduce(
    (total, entry) => total + entry.unindexed + entry.failed + entry.skipped,
    0,
  );
}

/** Is anything actually in flight? Drives the poll — see `useSearchIndex`. */
export function hasPendingIndexing(status: SearchIndexStatus | null): boolean {
  if (!status) return false;

  return status.types.some((entry) => entry.pending > 0);
}
