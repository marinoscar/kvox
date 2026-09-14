/**
 * "Notes from this transcript" — issue #59, epic #45.
 *
 * The other half of the provenance relationship #58 renders from the note side.
 * A note names the transcript it was generated from; without this, the
 * transcript names nothing back, and a recording somebody has already made
 * three notes from looks exactly like one nobody has touched.
 *
 * =============================================================================
 * THE SECTION IS ABSENT, NOT EMPTY
 * =============================================================================
 *
 * No notes, still loading, or a failed read — all three render `null`. An
 * empty "Notes from this transcript" panel is a permanent fixture on every
 * transcript that has never had a note made from it, which is most of them, and
 * it would push the thing the page exists for further down for no information
 * at all. The create action above it is the call to action; this is the
 * receipt.
 *
 * A FAILED READ IS ALSO SILENT, deliberately. This is a secondary, additive
 * relationship on somebody else's page — an error alert here would put a red
 * box on a transcript that is itself perfectly fine, about a list the user did
 * not ask for. The notes library is one navigation away and says so properly.
 *
 * ⚠ IT IS MOUNTED ONLY BY A CALLER HOLDING `notes:read`. The hook fetches on
 * mount, so the gate has to be the caller's decision to render it at all — a
 * gate inside would still have fired the request that 403s.
 */

import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import { NoteStatusChip } from './NoteStatusChip';
import { useNotes } from '../../hooks/useNotes';

const HEADING_ID = 'transcript-notes-heading';

export interface TranscriptNotesSectionProps {
  transcriptId: string;
}

export function TranscriptNotesSection({ transcriptId }: TranscriptNotesSectionProps) {
  const { notes, isLoading, error } = useNotes({ sourceTranscriptId: transcriptId });

  if (isLoading || error || notes.length === 0) return null;

  return (
    <Paper
      variant="outlined"
      // A named landmark, like `AiKeyRequired`'s: a screen-reader user reaches
      // this as "Notes from this transcript" rather than as a loose list of
      // links after the transcript.
      component="section"
      aria-labelledby={HEADING_ID}
      sx={{ p: 2 }}
    >
      <Typography id={HEADING_ID} variant="subtitle2" component="h2" sx={{ mb: 1 }}>
        Notes from this transcript
      </Typography>
      <List dense disablePadding>
        {notes.map((note) => (
          <ListItem
            key={note.id}
            disableGutters
            disablePadding
            // The status is worth carrying: a note still generating from this
            // transcript is the single most useful thing this list can say, and
            // it is the reason the hook polls while one is in flight.
            secondaryAction={<NoteStatusChip status={note.status} />}
          >
            <ListItemButton
              component={RouterLink}
              to={`/notes/${note.id}`}
              // Clear of the absolutely-positioned status chip above.
              sx={{ pr: 12 }}
            >
              <ListItemText
                primary={note.title}
                secondary={note.excerpt || undefined}
                slotProps={{
                  primary: { noWrap: true },
                  secondary: { noWrap: true },
                }}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Paper>
  );
}

export default TranscriptNotesSection;
