/**
 * The date heading between runs of rows in a library feed — issue #190.
 *
 * =============================================================================
 * AN `<li>`, NOT A WRAPPER AROUND THE GROUP
 * =============================================================================
 *
 * Both library feeds are ONE `<ul>` whose rows are `<li>`. This separator is
 * another `<li>` sitting among them rather than a `<section>` wrapping each
 * group, and that is a deliberate accessibility choice rather than a layout
 * shortcut:
 *
 *  - Nesting each group in its own sub-list would put a list inside a list item
 *    and change what a screen reader announces for every row in the feed
 *    ("list, 3 items" repeatedly instead of one list of 300).
 *  - A heading level between the page's `h1` and each row's `h2` does not exist
 *    today, and inventing one would push every row to `h3` — a change the axe
 *    passes in `TranscriptsPage.test.tsx` and `NotesPage.test.tsx` assert
 *    against, and one that would make the row headings no longer the page's
 *    content outline.
 *
 * So it is `aria-hidden` and `role="presentation"`: a VISUAL cut, carrying no
 * information a reader does not already have. Every row states its own date in
 * its metadata line, so nothing is lost by not announcing the separator, and a
 * screen-reader user is spared 30 interruptions while arrowing through a long
 * feed.
 *
 * `role="presentation"` on an `<li>` also removes it from the list's item
 * count, so "list, 300 items" stays the number of recordings rather than the
 * number of recordings plus headings.
 */

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

export function FeedDateSeparator({ label }: { label: string }) {
  return (
    <Box
      component="li"
      role="presentation"
      aria-hidden
      sx={{
        listStyle: 'none',
        // Tight above the first group, roomier between groups — the separator
        // reads as belonging to the rows below it rather than floating between.
        pt: 2,
        pb: 0.5,
        '&:first-of-type': { pt: 0 },
      }}
    >
      <Typography
        variant="overline"
        color="text.secondary"
        component="p"
        sx={{ fontWeight: 600, letterSpacing: '0.08em', lineHeight: 1.6 }}
      >
        {label}
      </Typography>
    </Box>
  );
}

export default FeedDateSeparator;
