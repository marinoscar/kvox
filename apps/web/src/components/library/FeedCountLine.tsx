/**
 * "42 transcripts" above a library feed — issue #190.
 *
 * =============================================================================
 * WHY IT IS A LIVE REGION
 * =============================================================================
 *
 * Epic #162 reduces the filter bar to one search box, which makes this line the
 * only feedback a search gives beyond the rows themselves. A sighted user sees
 * the list change under a settled search; a screen-reader user working the same
 * box hears nothing at all, because the rows below re-render without any
 * announcement and "no results" and "still loading" sound identical.
 *
 * `role="status"` / `aria-live="polite"` fixes exactly that: when the debounced
 * search lands, the new count is announced without interrupting whatever the
 * reader is doing. Rendered UNCONDITIONALLY (with empty text while the first
 * page is loading) rather than mounted when the count arrives — a live region
 * inserted at the same moment as its own content is announced by some screen
 * readers and silently ignored by others, which is the same reasoning
 * `TranscriptsLibraryView`'s playback region already carries.
 *
 * The count is the API's `total`, never `items.length` — see
 * `utils/feedDateGroups.ts`'s `feedCountLabel`.
 */

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

export function FeedCountLine({ label }: { label: string }) {
  return (
    <Box role="status" aria-live="polite" sx={{ mb: 1.5, minHeight: 20 }}>
      <Typography variant="body2" color="text.secondary" component="p">
        {label}
      </Typography>
    </Box>
  );
}

export default FeedCountLine;
