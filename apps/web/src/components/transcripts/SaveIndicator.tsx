/**
 * "Saving…" / "All changes saved", and the offline banner — issue #31, epic #19.
 *
 * The single most important thing a correction UI says is whether the work is
 * safe. This component is that sentence, and it is deliberately a `role="status"`
 * live region rather than a silent visual: a screen-reader user editing a
 * transcript has no other way to learn that a save landed.
 *
 * The OFFLINE state is an `Alert` and not another word in the same line,
 * because it is the one state that needs an explanation rather than a label —
 * "Offline" on its own reads as "your work is gone".
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';

import type { SaveState } from '../../hooks/useTranscriptOperations';

interface SaveIndicatorProps {
  state: SaveState;
  /** Ops still to go, so "Saving…" can say how much is left when it is a lot. */
  pendingCount: number;
}

/** The sentence for each state. Exported so a test asserts against one list. */
export function saveStateLabel(state: SaveState): string {
  switch (state) {
    case 'saving':
      return 'Saving…';
    case 'pending':
      return 'Unsaved changes';
    case 'offline':
      return 'Offline — changes will sync';
    case 'error':
      return 'Not saved';
    default:
      return 'All changes saved';
  }
}

export function SaveIndicator({ state, pendingCount }: SaveIndicatorProps) {
  if (state === 'offline') {
    return (
      <Alert severity="warning" role="status" sx={{ mb: 1.5 }}>
        Offline — changes will sync
        {pendingCount > 0 ? ` (${pendingCount} waiting)` : ''}. Nothing you have
        typed has been lost.
      </Alert>
    );
  }

  return (
    <Box
      role="status"
      // `polite`, never `assertive`: a save indicator that interrupts is a save
      // indicator that talks over the sentence the user is editing.
      aria-live="polite"
      sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minHeight: 24 }}
    >
      {state === 'saving' && <CircularProgress size={12} aria-hidden />}
      <Typography
        variant="caption"
        color={state === 'error' ? 'error.main' : 'text.secondary'}
      >
        {saveStateLabel(state)}
      </Typography>
    </Box>
  );
}

export default SaveIndicator;
