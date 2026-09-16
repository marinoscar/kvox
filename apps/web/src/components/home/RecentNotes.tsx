/**
 * "Recent notes" — the notes the user touched last. Issue #107, epic #45.
 *
 * `RecentTranscripts`' opposite number, one section further down the home page,
 * and its twin on purpose. The epic's whole thesis is **Capture → Correct →
 * Transform**, and until this issue the home page stopped at Correct: a user
 * who had generated twenty notes had no evidence on the landing screen that the
 * feature existed at all.
 *
 * =============================================================================
 * WHY THE RESPONSIVE LAYOUT IS A GRID AND NOT A MEDIA QUERY
 * =============================================================================
 *
 * `size={{ xs: 12, sm: 6, md: 4, lg: 3 }}` on one grid, and nothing else.
 * `xs: 12` IS the phone list — a single full-width column of cards, which is
 * what a list is — so the `useMediaQuery` branch between a `<Stack>` and a
 * `<Grid>` was never needed. Avoiding it matters beyond tidiness: every
 * `useMediaQuery` is a JavaScript breakpoint read that has to agree with the
 * five `docs/specs/settings-ui.md` §5 pins together, and a sixth gate here
 * would be a sixth thing to check every time one of the five moves, in exchange
 * for a layout CSS already does. The counts fall out of the same line: 2
 * columns from `sm`, 3 from `md`, 4 from `lg`.
 *
 * The sizes are IDENTICAL to `RecentTranscripts`' and `SharedWithMe`'s, which
 * is not a coincidence to be tidied away later: three lists of card-shaped
 * things on one page that reflowed at different widths would look like a bug on
 * exactly the tablet widths nobody tests by hand.
 *
 * =============================================================================
 * TWO EMPTY STATES, AND ONLY ONE OF THEM IS A PROMPT
 * =============================================================================
 *
 * `total === 0` means this account has never generated a note, and it reaches
 * this component only when it HAS transcripts (`HomePage` renders the journey
 * walkthrough instead for an account with neither). That is precisely the user
 * the "Turn a transcript into a note" card is for: they have the raw material
 * and no idea the next step exists.
 *
 * `total > 0` with an empty `recent` is not a state the API produces — `recent`
 * is the newest few of everything the caller owns — so it renders NOTHING
 * rather than a prompt that would tell a user with forty notes to make their
 * first one.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useNavigate } from 'react-router-dom';

import { NoteSummaryCard } from './NoteSummaryCard';
import type { NoteListItem } from '../../services/notes';

export interface RecentNotesProps {
  /** Already ordered newest-first by the API. */
  items: NoteListItem[];
  /** `counts.total` — every note this account owns, not just the ones above. */
  total: number;
  /** The caller holds `notes:write`. Gates the button, never the explanation. */
  canCreate: boolean;
  /** `GET /api/notes/summary` has not answered yet. */
  isLoading: boolean;
}

/** The section heading and its "View all", shared by every rendered state. */
function SectionHeading({ onViewAll }: { onViewAll: (() => void) | null }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}
    >
      <Typography
        id="home-recent-notes"
        variant="h6"
        component="h2"
        sx={{ fontWeight: 600 }}
      >
        Recent notes
      </Typography>
      {/* Absent while there is nothing to view: a "View all" that lands on an
          empty library is a dead end offered to the one user who most needs a
          next step, and the prompt card below already gives them a better one. */}
      {onViewAll && (
        <Button size="small" endIcon={<ChevronRightIcon />} onClick={onViewAll}>
          View all
        </Button>
      )}
    </Stack>
  );
}

export function RecentNotes({ items, total, canCreate, isLoading }: RecentNotesProps) {
  const navigate = useNavigate();

  // Resolved for the rows actually on screen, and shared with the library's
  // module-level cache — so opening `/notes` after this renders costs no
  // second lookup for the same sources. See the hook's header for why the
  // client has to resolve these at all and what should replace it.

  if (isLoading) {
    // THIS SECTION'S OWN SKELETON, not the page's. `HomePage` gates its
    // full-page skeleton on the TRANSCRIPT summary alone, deliberately: the two
    // summaries are two parallel requests, and holding the whole landing screen
    // blank until the slower of them lands would make the page as slow as its
    // slowest part for no benefit.
    return (
      <Box
        component="section"
        aria-labelledby="home-recent-notes"
        sx={{ mb: { xs: 3, sm: 4 } }}
      >
        <SectionHeading onViewAll={null} />
        <Box role="status" aria-busy="true" aria-label="Loading your notes">
          <Grid container spacing={1.5}>
            {[0, 1, 2, 3].map((index) => (
              <Grid key={index} size={{ xs: 12, sm: 6, md: 4, lg: 3 }}>
                <Skeleton variant="rounded" height={132} />
              </Grid>
            ))}
          </Grid>
        </Box>
      </Box>
    );
  }

  if (items.length === 0) {
    // See the header: a prompt only for an account that genuinely has none.
    if (total > 0) return null;

    return (
      <Box
        component="section"
        aria-labelledby="home-recent-notes"
        sx={{ mb: { xs: 3, sm: 4 } }}
      >
        <SectionHeading onViewAll={null} />
        <Paper variant="outlined" sx={{ p: { xs: 2.5, sm: 3 }, textAlign: 'center' }}>
          <Typography variant="subtitle1" component="h3" gutterBottom sx={{ fontWeight: 600 }}>
            Turn a transcript into a note
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: canCreate ? 2.5 : 0 }}>
            Minutes, a summary, a brief — generated from a recording you already have,
            using a template you control. It runs on your own AI key.
          </Typography>
          {/* The EXPLANATION is unconditional and only the BUTTON is gated. A
              user without `notes:write` still benefits from knowing what the
              section is; hiding the sentence too would leave them an unexplained
              blank where their colleagues see a feature. */}
          {canCreate && (
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => navigate('/notes/new')}
            >
              New note
            </Button>
          )}
        </Paper>
      </Box>
    );
  }

  return (
    <Box
      component="section"
      aria-labelledby="home-recent-notes"
      sx={{ mb: { xs: 3, sm: 4 } }}
    >
      <SectionHeading onViewAll={() => navigate('/notes')} />

      <Grid container spacing={1.5} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {items.map((item) => (
          <Grid
            key={item.id}
            component="li"
            size={{ xs: 12, sm: 6, md: 4, lg: 3 }}
            sx={{ display: 'flex' }}
          >
            <NoteSummaryCard note={item} />
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}

export default RecentNotes;
