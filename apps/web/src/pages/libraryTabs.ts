/**
 * The library's two top-level tabs, and the URLs they ARE — issue #57, epic #45.
 *
 * A SEPARATE MODULE from the page, like `transcriptsLibraryFilters.ts`, so the
 * mapping can be asserted without mounting anything.
 *
 * =============================================================================
 * ⚠ THE TAB IS THE URL. IT IS NOT COMPONENT STATE THAT UPDATES THE URL.
 * =============================================================================
 *
 * `/transcripts` and `/notes` are two routes onto one page, and which tab is
 * selected is DERIVED from the pathname on every render — there is no
 * `useState` holding a tab anywhere in `LibraryPage`, deliberately. The
 * alternative (state, synchronised to the URL by an effect) is the same picture
 * on the screen and a different thing underneath: it has two sources of truth
 * that agree only while nothing surprising happens, and the surprising things
 * are ordinary. A deep link into `/notes` renders the transcripts tab for a
 * frame and then jumps. The browser's Back button moves the URL and leaves the
 * tab where it was. A reload lands on whichever tab the initial state happened
 * to name.
 *
 * Deriving instead makes all three correct by construction: a link, a reload, a
 * Back and a Forward are the same operation, and the only thing a tab click has
 * to do is navigate.
 *
 * Both routes are owned by the ONE `library` destination
 * (`config/destinations.ts`), so switching tabs never changes which navigation
 * row is lit — which is the navigational half of the same claim: these are two
 * views of one question, not two destinations.
 */

/** The two views. Declaration order IS tab order. */
export type LibraryTab = 'transcripts' | 'notes';

/** Tab → the route that IS that tab. */
export const LIBRARY_TAB_PATHS: Record<LibraryTab, string> = {
  transcripts: '/transcripts',
  notes: '/notes',
};

/**
 * Which tab a pathname selects.
 *
 * TOTAL: every path resolves to a tab, because this is only ever called from
 * inside the page and the page is only mounted on one of the two subtrees. A
 * `null` return would make every caller handle a case the router has already
 * made impossible.
 *
 * Matched at the SEGMENT BOUNDARY, the same rule `destinations.ts`'s `owns`
 * applies and for the same reason: a bare `startsWith('/notes')` would claim a
 * future `/notes-archive`, and the failure — a page rendering the wrong tab for
 * a route it does not own — would look like a routing bug rather than a string
 * bug.
 */
export function libraryTabFromPath(pathname: string): LibraryTab {
  const notes = LIBRARY_TAB_PATHS.notes;
  if (pathname === notes || pathname.startsWith(`${notes}/`)) return 'notes';
  return 'transcripts';
}
