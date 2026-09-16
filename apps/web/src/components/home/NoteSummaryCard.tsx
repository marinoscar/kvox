/**
 * One note, as the home page shows it — issue #107, epic #45.
 *
 * `TranscriptSummaryCard`'s opposite number, and deliberately its twin in
 * shape: the same outlined `Card` filling a grid cell, the same single metadata
 * line, the same status chip in the same corner. The two sit one section apart
 * on the same screen, so a card that padded differently or truncated
 * differently would read as two products stacked on one page.
 *
 * ⚠ IT IS A GRID CELL, NOT A ROW, and there is no `useMediaQuery` here. The
 * phone-list / tablet-2-up / desktop-3-or-4-up layout is done entirely by the
 * parent's `Grid` sizes, so the responsive behaviour costs no JavaScript, no
 * re-render on resize and — the point — no sixth coupled breakpoint gate beside
 * the five `docs/specs/settings-ui.md` §5 pins together. See `HomePage`'s
 * header.
 *
 * =============================================================================
 * THE PROVENANCE LINE IS OUTSIDE THE TAP TARGET, AND THAT IS NOT A LAYOUT
 * PREFERENCE
 * =============================================================================
 *
 * `SourceLine` is imported from `components/library/NotesLibraryView.tsx`
 * rather than reimplemented, and it is rendered BELOW the `CardActionArea`
 * rather than inside it. A link inside a button is nested interactive content:
 * axe fails it, a screen reader cannot offer both targets, and a keyboard user
 * reaches a control their reader has just told them is part of a button. The
 * library row makes exactly this choice for exactly this reason; copying the
 * markup and not the reasoning is how the two drift.
 */

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { useNavigate } from 'react-router-dom';

import { SourceLine } from '../library/NotesLibraryView';
import { NoteStatusChip } from '../notes/NoteStatusChip';
import { isNoteInFlight } from '../../hooks/useNotes';
import type { NoteListItem } from '../../services/notes';
import { formatRelativeTime } from '../../utils/relativeTime';

export interface NoteSummaryCardProps {
  note: NoteListItem;
}

/**
 * ⚠ NO `sourceName` PROP SINCE #192. The name is on the row — `note.sourceName`
 * — resolved server-side for the whole page, so a caller no longer has to
 * thread a separately-fetched map down to each card. `SourceLine` reads it
 * directly and falls back to the category noun for `null`.
 */
export function NoteSummaryCard({ note }: NoteSummaryCardProps) {
  const navigate = useNavigate();
  const inFlight = isNoteInFlight(note.status);

  // Joined into ONE line rather than rendered as two elements, the same rule
  // `TranscriptSummaryCard` states: at a 3-column desktop width the cell is
  // ~300px, and two separately-wrapping spans turn into a ragged block on
  // exactly the widths this layout exists for.
  const meta = [formatRelativeTime(note.createdAt), note.templateName]
    .filter(Boolean)
    .join(' · ');

  return (
    // NOT an `li` itself: the caller wraps this in a `Grid` cell that carries
    // the list semantics, and `ul > div > li` is invalid markup that axe's
    // `list` rule rejects outright.
    <Card variant="outlined" sx={{ height: '100%', width: '100%' }}>
      <CardActionArea
        onClick={() => navigate(`/notes/${note.id}`)}
        sx={{
          px: 2,
          pt: 2,
          pb: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 0.75,
          // Without this the action area's content can report a wider
          // min-content width than the column it sits in and push the page
          // sideways — the same reason the shell sets `minWidth: 0` all the way
          // down.
          minWidth: 0,
        }}
      >
        <Box sx={{ width: '100%', minWidth: 0 }}>
          {/* `h3`, not `h2`: this card sits under the section's own `h2`
              ("Recent notes"), which sits under the page's `h1` greeting. The
              library row is an `h2` because its page has no section heading
              between it and the `h1` — the level is a property of where the
              thing is, not of what it is. */}
          <Typography variant="subtitle1" component="h3" noWrap sx={{ fontWeight: 600 }}>
            {note.title}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="p">
            {meta}
          </Typography>

          {inFlight ? (
            <Box sx={{ mt: 1 }}>
              {/* INDETERMINATE, because the API publishes no percentage and
                  inventing one would be a bar that lies. What it says is "this
                  is moving", which is exactly what is known. LABELLED rather
                  than `aria-hidden` (the choice `InProgressSection`'s rows
                  make): there the caption already says "Generating…", here the
                  bar replaces the excerpt and is the only thing on the card
                  reporting motion. */}
              <LinearProgress aria-label={`Generating ${note.title}`} />
            </Box>
          ) : note.excerpt ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{
                mt: 0.5,
                // Clamped to two lines rather than truncated to a character
                // count: a cell is a different width at every breakpoint, so
                // any character count is wrong at five of them.
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {note.excerpt}
            </Typography>
          ) : null}
        </Box>

        <NoteStatusChip status={note.status} />
      </CardActionArea>

      {/* The provenance footer. See the file header for why it is HERE and not
          in the action area above. */}
      <Box sx={{ px: 2, pb: 1.5 }}>
        <SourceLine note={note} />
      </Box>
    </Card>
  );
}

export default NoteSummaryCard;
