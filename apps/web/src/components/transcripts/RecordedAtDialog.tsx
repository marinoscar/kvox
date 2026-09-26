/**
 * "Edit recording date" — issue #352 (epic #344).
 *
 * =============================================================================
 * WHY THIS DATE IS WORTH A DIALOG
 * =============================================================================
 *
 * `createdAt` is when the file was uploaded; `recordedAt` is when the
 * conversation actually happened. Connected knowledge reads `recordedAt` as the
 * meeting date and resolves relative dates ("next Tuesday") against it, so a
 * recording uploaded three weeks late would date everything extracted from it
 * three weeks wrong until somebody corrects it here. The helper text says that
 * in plain words, because it is the only reason to touch this field.
 *
 * =============================================================================
 * ⚠ `datetime-local` HAS NO TIME ZONE
 * =============================================================================
 *
 * The input's value is a wall-clock string (`YYYY-MM-DDTHH:mm`) with no offset.
 * The stored value is an instant. So the conversion happens at exactly two
 * points and nowhere else:
 *
 *   - on open, the instant is rendered in the BROWSER'S local zone
 *     (`toLocalInputValue`, which reads the local getters — never
 *     `toISOString().slice(...)`, which would show UTC wall-clock time and
 *     shift the date by the user's offset);
 *   - on save, `new Date(local)` parses the wall-clock string as local time
 *     (the spec for an offset-less date-time form) and `toISOString()` sends
 *     the instant with an explicit `Z` offset, which the API requires.
 *
 * A test pins the round trip, because the failure mode — every save moving the
 * date by the user's UTC offset — is invisible to anyone who works in UTC.
 *
 * The future bound mirrors the server's (more than 24 h after now is refused):
 * the slack is the server's, not ours, and exists so a user a few time zones
 * ahead of the server is never told their own "today" is in the future.
 */

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import { useEffect, useId, useState } from 'react';

import { ApiError } from '../../services/api';
import { updateTranscript } from '../../services/transcripts';
import type { TranscriptDetail } from '../../services/transcripts';

/** How far ahead of now a recording date may be — the server's own bound. */
export const RECORDED_AT_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

export const RECORDED_AT_HELPER_TEXT =
  'Used as the meeting date for anything extracted from this recording.';

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * An ISO instant as a `datetime-local` value in the browser's local zone.
 * Returns `''` for an unparseable input, which the dialog reports as empty.
 */
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Why a `datetime-local` value cannot be saved, or `null` when it can.
 * `now` is a parameter so the rule is testable without faking timers.
 */
export function recordedAtError(local: string, now: number = Date.now()): string | null {
  if (local.trim() === '') return 'Enter the date and time the recording was made.';
  const time = new Date(local).getTime();
  if (Number.isNaN(time)) return 'Enter a valid date and time.';
  if (time > now + RECORDED_AT_FUTURE_SLACK_MS) {
    return 'A recording cannot be dated in the future.';
  }
  return null;
}

function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.message.trim().length > 0) return error.message;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return 'The recording date could not be saved. Try again.';
}

export interface RecordedAtDialogProps {
  open: boolean;
  onClose: () => void;
  transcript: TranscriptDetail;
  /** Receives the PATCH's 200 body — the fresh detail, applied directly. */
  onSaved: (detail: TranscriptDetail) => void;
}

export function RecordedAtDialog({ open, onClose, transcript, onSaved }: RecordedAtDialogProps) {
  const titleId = useId();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed on every open, so a cancelled edit never survives into the next
  // one and a value saved elsewhere since is what the user starts from.
  useEffect(() => {
    if (!open) return;
    setValue(toLocalInputValue(transcript.recordedAt));
    setSaving(false);
    setSaveError(null);
  }, [open, transcript.recordedAt]);

  const validationError = recordedAtError(value);

  const handleSave = async () => {
    if (validationError || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const detail = await updateTranscript(transcript.id, {
        recordedAt: new Date(value).toISOString(),
      });
      onSaved(detail);
      onClose();
    } catch (error) {
      setSaveError(saveErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      fullWidth
      maxWidth="xs"
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>Edit recording date</DialogTitle>
      <DialogContent>
        <TextField
          type="datetime-local"
          label="Recorded at"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          error={validationError !== null}
          helperText={validationError ?? RECORDED_AT_HELPER_TEXT}
          fullWidth
          margin="dense"
          disabled={saving}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        {saveError ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {saveError}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleSave()}
          disabled={saving || validationError !== null}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default RecordedAtDialog;
