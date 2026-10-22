/**
 * The Undo snackbar (GIC-17, #678): on a phone, Hide and Expand have no Undo button in view, so
 * the step is followed by a snackbar with one. It sits above the bottom navigation bar.
 */

import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';

/**
 * Props of {@link UndoSnackbar}.
 *
 * @stability experimental
 */
export interface UndoSnackbarProps {
  /** What just happened ("Node hidden"); `null` keeps the snackbar closed. */
  message: string | null;
  /** The user pressed Undo. */
  onUndo: () => void;
  /** The snackbar timed out or was dismissed. */
  onClose: () => void;
}

/**
 * A snackbar offering Undo for the step that just happened.
 *
 * @stability experimental
 */
export function UndoSnackbar({ message, onUndo, onClose }: UndoSnackbarProps) {
  return (
    <Snackbar
      open={message !== null}
      message={message ?? ''}
      autoHideDuration={6000}
      onClose={(_event, reason) => {
        if (reason !== 'clickaway') onClose();
      }}
      // Above the bottom navigation bar, which the shell pads <main> for (xs: 10 = 80px).
      sx={{ bottom: { xs: 88, sm: 24 } }}
      action={
        <Button
          color="inherit"
          size="small"
          onClick={() => {
            onUndo();
            onClose();
          }}
          sx={{ minHeight: 44 }}
        >
          Undo
        </Button>
      }
    />
  );
}
