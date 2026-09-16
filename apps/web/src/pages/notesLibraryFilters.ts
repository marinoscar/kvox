/**
 * The Notes view's status filter options — issue #57, epic #45; the URL seeds
 * are #170, epic #166.
 *
 * ⚠ THIS LIST NO LONGER FEEDS A `<Select>` — #193 removed it. It survives as
 * the allowlist `noteStatusFromQuery` validates against and as the source of
 * the chip's label; see `transcriptsLibraryFilters.ts` for the full argument.
 *
 * A SEPARATE MODULE from the view, exactly like `transcriptsLibraryFilters.ts`,
 * so a test can assert the list without mounting anything and so the "Any"
 * sentinel is defined once. `'all'` is a UI value the API knows nothing about:
 * `GET /api/notes` filters by OMITTING `status`, never by a magic value, so the
 * view translates rather than forwarding it.
 *
 * `draft` is deliberately absent as a user-facing choice and `deleting`
 * deliberately present. `draft` is the API's word for "created, never generated
 * even once" — a state a note passes through in the seconds between pressing
 * Generate and the first token, which nobody would ever filter FOR and which
 * "Generating" already covers in the only way a reader means it. `deleting` is
 * a state a note genuinely sits in while its purge job runs, and a user who has
 * just deleted something and wants to know whether it is gone has nowhere else
 * to look — the same argument `transcriptsLibraryFilters.ts` makes for offering
 * it there.
 */

import type { NoteStatus } from '../services/notes';

export interface NoteStatusFilterOption {
  value: NoteStatus | 'all';
  label: string;
}

export const NOTE_STATUS_FILTERS: readonly NoteStatusFilterOption[] = [
  { value: 'all', label: 'Any status' },
  { value: 'generating', label: 'Generating' },
  { value: 'ready', label: 'Ready' },
  { value: 'failed', label: 'Failed' },
  { value: 'deleting', label: 'Deleting' },
];

/**
 * =============================================================================
 * THE URL SEEDS THE VIEW'S STATE. IT DOES NOT BIND TO IT.
 * =============================================================================
 *
 * `/notes?status=failed` and `?q=budget` are deep links into this library —
 * issue #170, epic #166 — and the two functions below are what turns that query
 * string into the view's INITIAL state, once, on mount. The full decision, the
 * rejected full two-way sync, and why the debounce is the reason for rejecting
 * it are recorded in `transcriptsLibraryFilters.ts`'s matching block; this
 * module deliberately does not restate the argument, because there is one
 * decision here and it must not be able to drift into two.
 *
 * ⚠ THERE IS NO `?scope` HERE, and that is not an omission. `GET /api/notes`
 * lists the caller's own notes and nothing else — a note has no share model and
 * no `notes:read_any` exists for anybody, ever (CLAUDE.md's RBAC table says so
 * in as many words) — so the Notes view has no scope tab for a parameter to
 * seed. A `scope` parser here would be a control this library cannot grow.
 */

/**
 * `?status=<value>` → the status filter, VALIDATED AGAINST THE OFFERED LIST.
 *
 * Membership of `NOTE_STATUS_FILTERS` is the check, not membership of
 * `NoteStatus`, for the reason its transcript twin states: the list is what
 * this page can NAME, and `draft` is a real `NoteStatus` this page deliberately
 * does not offer. `?status=draft` therefore answers `'all'` rather than
 * silently filtering the feed by something the reader cannot see.
 *
 * ⚠ Since #193 the thing that names it is the chip above the feed, not a
 * `<Select>` — the filter bar is one search box. The failure this guard
 * prevents got WORSE rather than better with that change: an unnamed status
 * used to render a blank dropdown, and would now render no chip at all,
 * leaving a filtered feed with no visible way out of it.
 *
 * Absent, unknown, empty and `all` all answer `'all'`, which the view already
 * translates into omitting `status` from the request.
 */
export function noteStatusFromQuery(params: URLSearchParams): NoteStatus | 'all' {
  const raw = params.get('status');
  const offered = NOTE_STATUS_FILTERS.find((option) => option.value === raw);
  return offered ? offered.value : 'all';
}

/**
 * `?q=<text>` → the search box's initial text.
 *
 * RE-EXPORTED, never re-implemented. Both libraries read the same `?q` and a
 * second spelling of "which parameter carries the search term" is exactly the
 * kind of divergence a deep link discovers in production rather than in review.
 */
export { searchFromQuery } from './transcriptsLibraryFilters';
