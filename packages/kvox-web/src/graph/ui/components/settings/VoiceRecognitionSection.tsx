/**
 * "Voice recognition" — the Knowledge graph settings page's voiceprint opt-in
 * (#827, epic #820).
 *
 * A voiceprint is biometric data, so the switch is OFF until the user turns it
 * on, and turning it on asks first: the consent text has to be acknowledged
 * (a checkbox in a dialog) before the preference is written. The server stamps
 * the consent time and learns the voices of people already named. Turning it
 * off needs no confirmation; it stops learning and suggesting, and "Delete all
 * voiceprints" removes what was learned.
 *
 * A section of the existing page, not a card or a tab (Settings UI rules 1 and
 * 2). Layout is CSS only, so the five breakpoint gates are untouched.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { formatDateTime } from '@marinoscar/platform-web/timezone/headless';

import type { DeleteAllVoiceprintsResult } from '../../../headless/clients/voiceprints.js';
import type { GraphPreferencesPatch } from '../../../headless/hooks/useGraphPreferences.js';
import { useVoiceprintSettings } from '../../../headless/hooks/useVoiceprintSettings.js';

/**
 * What a voiceprint is and where it lives, in the user's words: shown in the
 * section and again in the consent dialog.
 *
 * @stability experimental
 */
export const VOICEPRINT_CONSENT_TEXT =
  'A voiceprint is biometric data. It is computed on this server from recordings in which you name a speaker, ' +
  'and stored only for you. It is never exported or sent to AI providers, and it is deleted with the person, ' +
  'the recording or your account.';

/**
 * Props of {@link VoiceRecognitionSection}.
 *
 * @stability experimental
 */
export interface VoiceRecognitionSectionProps {
  /** The page's preferences write (`useGraphPreferences().update`). */
  update: (patch: GraphPreferencesPatch) => Promise<boolean>;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The voice recognition opt-in, its counts and "Delete all voiceprints".
 *
 * @param props - The preferences write.
 * @returns The section body.
 *
 * @stability experimental
 */
export function VoiceRecognitionSection({ update }: VoiceRecognitionSectionProps) {
  const { summary, isLoading, error, isWorking, actionError, setEnabled, deleteAll } = useVoiceprintSettings({
    update,
  });
  const [consentOpen, setConsentOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleted, setDeleted] = useState<DeleteAllVoiceprintsResult | null>(null);

  if (isLoading) return <Typography variant="body2">Loading…</Typography>;

  const enabled = summary?.enabled === true;
  const hasSamples = (summary?.samples ?? 0) > 0;
  const consentDate = summary?.consentAt
    ? formatDateTime(summary.consentAt, { dateStyle: 'medium', fallback: '' })
    : '';

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {VOICEPRINT_CONSENT_TEXT}
      </Typography>

      {error && <Alert severity="error">{error}</Alert>}

      <Box>
        <FormControlLabel
          control={
            <Switch
              checked={enabled}
              disabled={isWorking || summary === null}
              onChange={(event) => {
                if (event.target.checked) {
                  setAgreed(false);
                  setConsentOpen(true);
                } else {
                  void setEnabled(false);
                }
              }}
            />
          }
          label="Suggest speaker names from voices"
        />
        <FormHelperText sx={{ mt: 0, ml: 0 }}>
          {enabled
            ? `On${consentDate ? ` since ${consentDate}` : ''}. Turning it off stops learning voices and suggesting names.`
            : 'When a speaker in a new recording sounds like someone you named before, you are offered their name.'}
        </FormHelperText>
      </Box>

      {summary && (enabled || hasSamples) && (
        <Typography variant="body2">
          {plural(summary.people, 'person', 'people')} · {plural(summary.samples, 'sample', 'samples')}
        </Typography>
      )}

      {deleted && (
        <Alert severity="success" onClose={() => setDeleted(null)}>
          Deleted {plural(deleted.deletedSamples, 'voiceprint sample', 'voiceprint samples')} and{' '}
          {plural(deleted.deletedSuggestions, 'pending suggestion', 'pending suggestions')}.
        </Alert>
      )}
      {actionError && !deleteOpen && <Alert severity="error">{actionError}</Alert>}

      <Box>
        <Button
          variant="outlined"
          color="error"
          disabled={isWorking || summary === null}
          onClick={() => {
            setDeleted(null);
            setDeleteOpen(true);
          }}
        >
          Delete all voiceprints
        </Button>
      </Box>

      <Dialog
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        aria-labelledby="kg-voice-consent-title"
        aria-describedby="kg-voice-consent-description"
      >
        <DialogTitle id="kg-voice-consent-title">Turn on voice recognition?</DialogTitle>
        <DialogContent>
          <DialogContentText id="kg-voice-consent-description">{VOICEPRINT_CONSENT_TEXT}</DialogContentText>
          <DialogContentText sx={{ mt: 2 }}>
            Voices of people you have already named are learned now, and names are only ever suggested; you
            decide.
          </DialogContentText>
          <FormControlLabel
            sx={{ mt: 2 }}
            control={<Checkbox checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />}
            label="I understand and agree to voiceprints being stored for me"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConsentOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!agreed || isWorking}
            onClick={() => {
              setConsentOpen(false);
              void setEnabled(true);
            }}
          >
            Turn on
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => {
          if (!isWorking) setDeleteOpen(false);
        }}
        aria-labelledby="kg-voice-delete-title"
        aria-describedby="kg-voice-delete-description"
      >
        <DialogTitle id="kg-voice-delete-title">Delete all voiceprints?</DialogTitle>
        <DialogContent>
          <DialogContentText id="kg-voice-delete-description">
            Every voiceprint learned for you is deleted, along with the name suggestions waiting on your
            transcripts. People, recordings and notes are not changed. This cannot be undone.
          </DialogContentText>
          {actionError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {actionError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)} disabled={isWorking}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            disabled={isWorking}
            onClick={() => {
              void deleteAll().then((result) => {
                if (result) {
                  setDeleted(result);
                  setDeleteOpen(false);
                }
              });
            }}
          >
            Delete all
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
