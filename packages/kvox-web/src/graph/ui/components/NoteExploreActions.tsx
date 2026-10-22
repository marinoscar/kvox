/**
 * The graph's entries on the notes pages (GIC-14, #675):
 *
 *   - the note page header: "Explore in graph" (what this note touches) and "Compare with…"
 *     (a picker for a second note, then what the two have in common);
 *   - the notes library's selection bar: "Explore connections" for two to ten selected notes.
 *
 * Every entry is a link into the explorer: `/graph/explore?connectNotes=id1,id2,…`. The explorer asks
 * the API what connects them and restores the same view from that URL.
 */

import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useNotes } from '../../../notes/headless/index.js';
import { formatRelativeTime } from '../../../core/headless/index.js';

/** The most notes the explorer compares (the API's limit). */
export const EXPLORE_MAX_NOTES = 10;

/**
 * The explorer URL for these notes.
 *
 * @param noteIds - One to ten note ids.
 * @returns The path and query to navigate to.
 *
 * @stability experimental
 */
export function exploreNotesPath(noteIds: readonly string[]): string {
  return `/graph/explore?connectNotes=${noteIds.slice(0, EXPLORE_MAX_NOTES).map(encodeURIComponent).join(',')}`;
}

/**
 * Props of {@link ExploreConnectionsButton}.
 *
 * @stability experimental
 */
export interface ExploreConnectionsButtonProps {
  /** The selected notes. */
  noteIds: readonly string[];
  /** Runs after navigating (leaves the selection mode). */
  onDone?: () => void;
}

/**
 * "Explore connections": opens the explorer on two to ten notes; disabled with a reason below two.
 *
 * @stability experimental
 */
export function ExploreConnectionsButton({ noteIds, onDone }: ExploreConnectionsButtonProps) {
  const navigate = useNavigate();
  const enough = noteIds.length >= 2;
  return (
    <Button
      variant="contained"
      startIcon={<HubOutlinedIcon />}
      disabled={!enough}
      onClick={() => {
        navigate(exploreNotesPath(noteIds));
        onDone?.();
      }}
      sx={{ minHeight: 44 }}
      title={enough ? 'See what these notes have in common' : 'Select at least two notes'}
    >
      Explore connections
    </Button>
  );
}

/**
 * Props of {@link NoteExploreActions}.
 *
 * @stability experimental
 */
export interface NoteExploreActionsProps {
  /** The note the page shows. */
  noteId: string;
}

/**
 * The note page's graph entries: "Explore in graph" and "Compare with…".
 *
 * @stability experimental
 */
export function NoteExploreActions({ noteId }: NoteExploreActionsProps) {
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  return (
    <>
      <Button
        size="small"
        startIcon={<HubOutlinedIcon />}
        onClick={() => navigate(exploreNotesPath([noteId]))}
        title="See what this note touches in your knowledge graph"
      >
        Explore in graph
      </Button>
      <Button size="small" startIcon={<CompareArrowsIcon />} onClick={() => setPicking(true)}>
        Compare with…
      </Button>
      {picking && (
        <NoteComparePicker
          currentNoteId={noteId}
          onClose={() => setPicking(false)}
          onPick={(other) => {
            setPicking(false);
            navigate(exploreNotesPath([noteId, other]));
          }}
        />
      )}
    </>
  );
}

/**
 * Props of {@link NoteComparePicker}.
 *
 * @stability experimental
 */
export interface NoteComparePickerProps {
  /** The note being compared from; left out of the list. */
  currentNoteId: string;
  /** Close without choosing. */
  onClose: () => void;
  /** A second note was chosen. */
  onPick: (noteId: string) => void;
}

/**
 * A dialog that finds a second note by title and returns its id.
 *
 * @stability experimental
 */
export function NoteComparePicker({ currentNoteId, onClose, onPick }: NoteComparePickerProps) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const { notes, isLoading, error } = useNotes({ q: debounced || undefined, status: 'ready', pollIntervalMs: 0 });
  const candidates = notes.filter((note) => note.id !== currentNoteId);

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs" aria-labelledby="compare-note-title">
      <DialogTitle id="compare-note-title">Compare with another note</DialogTitle>
      <DialogContent dividers sx={{ px: 2 }}>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="Search notes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          sx={{ mb: 1 }}
        />
        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={24} aria-label="Loading notes" />
          </Box>
        ) : error ? (
          <Typography color="error" variant="body2">
            {error}
          </Typography>
        ) : candidates.length === 0 ? (
          <Typography color="text.secondary" variant="body2" sx={{ py: 2 }}>
            No other notes match.
          </Typography>
        ) : (
          <List dense disablePadding aria-label="Notes to compare with">
            {candidates.map((note) => (
              <ListItem key={note.id} disablePadding>
                <ListItemButton onClick={() => onPick(note.id)} sx={{ minHeight: 48, borderRadius: 1 }}>
                  <ListItemText
                    primary={note.title}
                    secondary={formatRelativeTime(note.createdAt)}
                    slotProps={{ primary: { noWrap: true } }}
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}
