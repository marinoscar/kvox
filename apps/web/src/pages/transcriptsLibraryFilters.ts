/**
 * The library's status filter options — issue #30, epic #19.
 *
 * A SEPARATE MODULE from the page, so a test can assert the list without
 * mounting the page, and so the "Any" sentinel is defined once. `'all'` is a
 * UI value the API knows nothing about: `GET /api/transcripts` filters by
 * OMITTING `status`, never by a magic value, so the page translates rather than
 * forwarding it.
 *
 * `deleting` is deliberately offered. It is a real, visible state a transcript
 * can sit in for minutes while its purge job removes multi-gigabyte objects,
 * and a user who just deleted something and wants to know whether it is gone
 * has nowhere else to look.
 */

import type { TranscriptStatus } from '../services/transcripts';

export interface TranscriptStatusFilterOption {
  value: TranscriptStatus | 'all';
  label: string;
}

export const TRANSCRIPT_STATUS_FILTERS: readonly TranscriptStatusFilterOption[] = [
  { value: 'all', label: 'Any status' },
  { value: 'uploading', label: 'Uploading' },
  { value: 'processing', label: 'Processing' },
  { value: 'ready', label: 'Ready' },
  { value: 'failed', label: 'Failed' },
  { value: 'deleting', label: 'Deleting' },
];

/**
 * =============================================================================
 * THE URL SEEDS THE VIEW'S STATE. IT DOES NOT BIND TO IT.
 * =============================================================================
 *
 * `/transcripts?scope=shared`, `?status=failed` and `?q=budget` exist so that
 * something ELSEWHERE in the app can hand a user a filtered library: the home
 * page's counts strip (issue #170, epic #166) is the first caller, and a
 * notification email or a shared link is the next obvious one. The three
 * functions below are what turns that query string into the view's INITIAL
 * state, once, on mount.
 *
 * ⚠ THEY ARE SEEDS, NOT A TWO-WAY BINDING, and that is the decision this block
 * exists to record. Once the view is mounted, changing a filter updates
 * component state and NOTHING writes back to the URL.
 *
 * FULL TWO-WAY SYNC WAS CONSIDERED AND REJECTED, for two concrete reasons
 * rather than a preference:
 *
 *   1. The search box is DEBOUNCED (300 ms) precisely because a keystroke is a
 *      `LIKE` query against the column the list is also ordering by. Pushing
 *      the box's value into the URL puts a second clock beside that one —
 *      either a history entry per character, or a URL that lags the input and
 *      is wrong for exactly as long as the debounce is pending.
 *   2. A deep link is an ENTRY POINT, not a document location. `?scope=shared`
 *      answers "what should this page show when you arrive"; it is not a claim
 *      that the back button should walk a user backwards through their own
 *      filter edits, which is what a `history.push` per change would build.
 *
 * A future issue that genuinely wants shareable-at-any-moment library URLs
 * would be adding `replace: true` writes on the COMMITTED (post-debounce)
 * values — a different feature with a different failure mode, not an extension
 * of this one.
 *
 * Every function here is PURE and takes `URLSearchParams`, so the rules below
 * are asserted without mounting a page — the same reason this module was split
 * out from the view in the first place.
 */

/** The scope tab the view offers. `'all'` is an API value with no tab. */
export type TranscriptScopeFilter = 'owned' | 'shared';

/**
 * `?scope=shared` → the "Shared with me" tab; anything else → "Mine".
 *
 * An unknown value falls back rather than throwing, and it falls back to
 * `'owned'` specifically: a user who followed a broken link should land on
 * their own transcripts, which is the tab the page opens on anyway.
 */
export function transcriptScopeFromQuery(params: URLSearchParams): TranscriptScopeFilter {
  return params.get('scope') === 'shared' ? 'shared' : 'owned';
}

/**
 * `?status=<value>` → the status filter, VALIDATED AGAINST THE OFFERED LIST.
 *
 * Membership of `TRANSCRIPT_STATUS_FILTERS` is the check, not membership of
 * `TranscriptStatus`: the list is what the `<Select>` can actually display, so
 * a status the API knows and this page does not offer would otherwise seed a
 * filter whose value matches no `<MenuItem>` — a control rendered blank, with
 * the list silently filtered by something the reader cannot see or undo.
 *
 * Absent, unknown, empty and `all` all answer `'all'`, which the view already
 * translates into omitting `status` from the request.
 */
export function transcriptStatusFromQuery(params: URLSearchParams): TranscriptStatus | 'all' {
  const raw = params.get('status');
  const offered = TRANSCRIPT_STATUS_FILTERS.find((option) => option.value === raw);
  return offered ? offered.value : 'all';
}

/**
 * `?q=<text>` → the search box's initial text.
 *
 * Returned RAW, not trimmed: the box is a text input and seeding it with
 * something other than what the URL said would make the first edit look like a
 * correction the user did not make. Consumers that care about emptiness already
 * trim at the point they ask the question (`isFiltered`).
 *
 * Shared with `notesLibraryFilters.ts`, which re-exports it rather than
 * spelling a second `?q` convention — two libraries whose deep links disagreed
 * about the name of the search parameter is the failure that costs.
 */
export function searchFromQuery(params: URLSearchParams): string {
  return params.get('q') ?? '';
}
