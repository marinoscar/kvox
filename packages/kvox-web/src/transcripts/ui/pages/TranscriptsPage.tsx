/**
 * `/transcripts` — one of the app's two content destinations. Issue #106, over
 * #30 (epic #19).
 *
 * =============================================================================
 * ONE PAGE, ONE ROUTE, NO TAB STRIP
 * =============================================================================
 *
 * This is what is left of `LibraryPage` once the Transcripts | Notes tab strip
 * is removed: a heading, a primary action and the view. Both of the first two
 * live in `LibraryPageFrame` (`@marinoscar/kvox-web/core/ui`), which `NotesPage` renders
 * too — the header is genuinely the same header, and duplicating it would mean
 * two copies of a FAB offset derived from the bottom bar's height.
 *
 * WHY THE STRIP IS GONE. #57 put it there because the bottom bar was full and
 * `library` had to be one row over two subtrees; the strip was that row's real
 * navigation, one tap below a destination named after neither of the things it
 * fronted. #106 frees the bar slot by pinning Console instead
 * (`config/destinations.ts`), so Transcripts and Notes are siblings in
 * navigation and there is nothing left for a strip to choose between. Reaching
 * a transcript now costs one tap from anywhere, not two.
 *
 * =============================================================================
 * THE TABS INSIDE THIS VIEW ARE UNTOUCHED, AND CORRECTLY SO
 * =============================================================================
 *
 * `TranscriptsLibraryView` keeps its Mine | Shared with me strip. That pair is
 * exactly what CLAUDE.md's Settings UI Pattern rule 2 permits: genuinely
 * PARALLEL content — one question ("which transcripts can I open?"), one
 * endpoint, one row shape, and a `scope` query parameter as the only difference
 * between the two. The strip #106 deleted was the other kind, a hierarchy
 * wearing a tab strip, which is why one goes and the other stays.
 *
 * (This is not a settings surface, so the registry rules do not reach it.
 * `config/destinations.ts` is what declares it, and the AppBar's drill-down
 * table is what handles its children.)
 */

import { LibraryPageFrame } from '../../../core/ui/index.js';
import { ImportTranscriptButton } from '../components/ImportTranscriptButton.js';
import { TranscriptsLibraryView } from '../components/TranscriptsLibraryView.js';
import type { TranscriptSharingAdapter, TranscriptsLibrarySlots } from '../slots.js';

/**
 * The props of {@link TranscriptsPage}.
 *
 * @stability experimental
 */
export interface TranscriptsPageProps {
  /** What the app adds to the library. See {@link TranscriptsLibrarySlots}. */
  slots?: TranscriptsLibrarySlots;
  /** How shares are managed; without it the row menu offers neither Share nor Leave. */
  sharing?: TranscriptSharingAdapter;
}

/**
 * The `/transcripts` page: the library under its page frame.
 *
 * @param props - The slots and the sharing adapter, both optional.
 * @returns The page.
 *
 * @stability experimental
 */
export function TranscriptsPage({ slots, sharing }: TranscriptsPageProps = {}) {
  return (
    <LibraryPageFrame
      title="Transcripts"
      // `transcripts:write`, which is what `transcripts.controller.ts` enforces
      // on create — not `transcripts:read`, which the route already required to
      // get here. Reachability versus content, the same split the settings
      // pages draw.
      action={{
        label: 'New transcript',
        path: '/transcripts/new',
        permission: 'transcripts:write',
      }}
      // Import a `kvox.transcript/v1` file (#571): a secondary action beside
      // "New transcript", gated inside on the same `transcripts:write`. Its
      // errors float, so an alert never pushes the heading around.
      secondaryAction={<ImportTranscriptButton errorPlacement="snackbar" />}
    >
      <TranscriptsLibraryView {...(slots ? { slots } : {})} {...(sharing ? { sharing } : {})} />
    </LibraryPageFrame>
  );
}

