/**
 * "Recent" — the eight transcripts the user touched last. Issue #32, epic #19.
 *
 * =============================================================================
 * WHY THE RESPONSIVE LAYOUT IS A GRID AND NOT A MEDIA QUERY
 * =============================================================================
 *
 * The issue asks for a list on phones, two columns on tablet and three to four
 * on desktop. The obvious implementation reads `useMediaQuery` and branches
 * between a `<Stack>` and a `<Grid>`; this one sets
 * `size={{ xs: 12, sm: 6, md: 4, lg: 3 }}` on one grid and stops.
 *
 * `xs: 12` IS the phone list — a single full-width column of cards, which is
 * what a list is. So the branch was never needed, and avoiding it matters for
 * a reason beyond tidiness: every `useMediaQuery` is a JavaScript breakpoint
 * read that has to agree with the five `docs/specs/settings-ui.md` §5 pins
 * together (the rail, the bottom bar, `<main>`'s bottom padding, and the two
 * `isCompactWindow` reads). A sixth gate here would be a sixth thing to check
 * every time one of the five moves, in exchange for a layout CSS already does.
 *
 * The counts fall out of the same line: 2 columns from `sm` (600px), 3 from
 * `md` (900px), 4 from `lg` (1200px) — "3–4 columns on desktop" is a width
 * question, not a device question.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useNavigate } from 'react-router-dom';

import { TranscriptSummaryCard } from './TranscriptSummaryCard';
import type { HomeTranscriptItem } from './TranscriptSummaryCard';

export interface RecentTranscriptsProps {
  /** At most eight, already ordered newest-first by the API. */
  items: HomeTranscriptItem[];
}

export function RecentTranscripts({ items }: RecentTranscriptsProps) {
  const navigate = useNavigate();

  // Rendered even when empty — unlike `InProgressSection` and `SharedWithMe`,
  // which hide. An account WITH transcripts but none in this list does not
  // exist (the API's `recent` is simply the newest eight of everything the
  // caller owns), so the only way to get here empty is a brand-new account —
  // and `HomePage` renders `JourneyEmptyState` instead of this in that case.
  // The guard below is therefore belt-and-braces against a partial summary,
  // not a state the product has.
  if (items.length === 0) return null;

  return (
    <Box component="section" aria-labelledby="home-recent" sx={{ mb: { xs: 3, sm: 4 } }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}
      >
        <Typography id="home-recent" variant="h6" component="h2" sx={{ fontWeight: 600 }}>
          Recent
        </Typography>
        <Button
          size="small"
          endIcon={<ChevronRightIcon />}
          onClick={() => navigate('/transcripts')}
        >
          View all
        </Button>
      </Stack>

      <Grid container spacing={1.5} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {items.map((item) => (
          <Grid
            key={item.id}
            component="li"
            size={{ xs: 12, sm: 6, md: 4, lg: 3 }}
            sx={{ display: 'flex' }}
          >
            <TranscriptSummaryCard transcript={item} />
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}

export default RecentTranscripts;
