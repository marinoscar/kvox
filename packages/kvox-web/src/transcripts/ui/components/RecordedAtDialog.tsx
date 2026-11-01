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
 * points and nowhere else, both in the user's DISPLAY time zone (the zone they
 * chose in their profile, else the device's: `useDisplayTimeZone()` of
 * `@marinoscar/platform-web/timezone/headless`), the same zone the page's
 * "Recorded …" line is rendered in:
 *
 *   - on open, the instant is rendered as that zone's wall clock
 *     (`toLocalInputValue` — never `toISOString().slice(...)`, which would show
 *     UTC wall-clock time and shift the date by the user's offset);
 *   - on save, `fromLocalInputValue` reads the wall-clock string as that
 *     zone's time (not the browser's: `new Date(local)` would use the device's
 *     zone, which is a different instant whenever the user chose another one)
 *     and `toISOString()` sends the instant with an explicit `Z` offset, which
 *     the API requires.
 *
 * A test pins the round trip, because the failure mode — every save moving the
 * date by the user's UTC offset — is invisible to anyone who works in UTC.
 *
 * The future bound mirrors the server's (more than 24 h after now is refused):
 * the slack is the server's, not ours, and exists so a user a few time zones
 * ahead of the server is never told their own "today" is in the future.
 */

import { KvoxApiError, useKvoxHost } from '../../../core/headless/index.js';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import { useEffect, useId, useState } from 'react';

import { updateTranscript } from '../../headless/clients/transcripts.js';
import type { TranscriptDetail } from '../../headless/clients/transcripts.js';
import {
  getDateTimeFormat,
  getDisplayTimeZone,
  getTimeZoneOffsetMinutes,
  toValidDate,
  useDisplayTimeZone,
} from '@marinoscar/platform-web/timezone/headless';

/** How far ahead of now a recording date may be — the server's own bound. */
export const RECORDED_AT_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

export const RECORDED_AT_HELPER_TEXT =
  'Used as the meeting date for anything extracted from this recording.';

/**
 * An ISO instant as a `datetime-local` value: the wall clock of `timeZone`
 * (default: the display zone). Returns `''` for an unparseable input, which the
 * dialog reports as empty.
 */
export function toLocalInputValue(iso: string, timeZone?: string): string {
  const date = toValidDate(iso);
  if (!date) return '';
  const parts = getDateTimeFormat({
    locale: 'en-US',
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A `datetime-local` value read as the wall clock of `timeZone` (default: the
 * display zone), as epoch milliseconds, or `null` when it is not a valid
 * date and time. A repeated wall time (the hour a daylight-saving change
 * repeats) resolves to its first occurrence; one a change skips still resolves
 * to an instant, an hour from it.
 */
export function fromLocalInputValue(local: string, timeZone?: string): number | null {
  const match = LOCAL_INPUT.exec(local.trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((field) => Number(field ?? 0));
  const wall = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  const check = new Date(wall);
  // Refuse a date that does not exist (`2026-02-31`) instead of rolling it over.
  if (check.getUTCMonth() !== month! - 1 || check.getUTCDate() !== day! || hour! > 23 || minute! > 59) {
    return null;
  }
  const zone = timeZone ?? getDisplayTimeZone();
  // The zone's offset at the wall time read as UTC is a first guess; read again
  // at the instant it gives, so a guess across a DST change settles.
  const guess = wall - getTimeZoneOffsetMinutes(zone, check) * 60_000;
  return wall - getTimeZoneOffsetMinutes(zone, new Date(guess)) * 60_000;
}

/**
 * Why a `datetime-local` value cannot be saved, or `null` when it can.
 * `now` is a parameter so the rule is testable without faking timers;
 * `timeZone` (default: the display zone) is the zone the value is read in.
 */
export function recordedAtError(
  local: string,
  now: number = Date.now(),
  timeZone?: string,
): string | null {
  if (local.trim() === '') return 'Enter the date and time the recording was made.';
  const time = fromLocalInputValue(local, timeZone);
  if (time === null) return 'Enter a valid date and time.';
  if (time > now + RECORDED_AT_FUTURE_SLACK_MS) {
    return 'A recording cannot be dated in the future.';
  }
  return null;
}

function saveErrorMessage(error: unknown): string {
  if (error instanceof KvoxApiError && error.message.trim().length > 0) return error.message;
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
  const host = useKvoxHost();
  // The field shows, and saves, the wall clock of the user's display zone.
  const zone = useDisplayTimeZone();
  const titleId = useId();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed on every open, so a cancelled edit never survives into the next
  // one and a value saved elsewhere since is what the user starts from.
  useEffect(() => {
    if (!open) return;
    setValue(toLocalInputValue(transcript.recordedAt, zone));
    setSaving(false);
    setSaveError(null);
  }, [open, transcript.recordedAt, zone]);

  const validationError = recordedAtError(value, Date.now(), zone);

  const handleSave = async () => {
    const time = fromLocalInputValue(value, zone);
    if (validationError || saving || time === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const detail = await updateTranscript(host, transcript.id, {
        recordedAt: new Date(time).toISOString(),
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

