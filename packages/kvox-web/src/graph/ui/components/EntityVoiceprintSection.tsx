/**
 * `EntityVoiceprintSection` — the "Voice" section of a Person's page (#827,
 * epic #820).
 *
 * Enrolled: "Voice learned from N recordings · M min of speech · updated
 * (relative date)", and "Forget voice" (`graph:write`) behind a confirmation
 * that says the samples are deleted and suggestions for this person stop.
 * Not enrolled: a muted "No voice learned yet" hint. A failed read is said in
 * the section alone; the page carries on.
 *
 * The caller renders it for a Person only. Layout is CSS only (a row that
 * wraps), so no breakpoint is read.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { formatRelativeTime } from '../../../core/headless/index.js';
import type { PersonVoiceprint } from '../../headless/clients/voiceprints.js';
import { useEntityVoiceprint } from '../../headless/hooks/useEntityVoiceprint.js';

/**
 * The props of {@link EntityVoiceprintSection}.
 *
 * @stability experimental
 */
export interface EntityVoiceprintSectionProps {
  /** The Person. */
  entityId: string;
  /** The Person's name, for the confirmation. */
  label: string;
  /** The viewer holds `graph:write`: offers "Forget voice". */
  canForget: boolean;
}

/**
 * Whole minutes of speech, at least 1 once anything was learned: `90_000` → `2 min`.
 *
 * @stability experimental
 */
export function formatSpeechMinutes(speechMs: number): string {
  if (!Number.isFinite(speechMs) || speechMs <= 0) return '0 min';
  return `${Math.max(1, Math.round(speechMs / 60_000))} min`;
}

/**
 * The one-line summary of an enrolled voice.
 *
 * @stability experimental
 */
export function voiceprintSummaryLine(voice: PersonVoiceprint): string {
  const parts = [
    `Voice learned from ${voice.samples} ${voice.samples === 1 ? 'recording' : 'recordings'}`,
    `${formatSpeechMinutes(voice.speechMs)} of speech`,
  ];
  if (voice.lastUpdatedAt) parts.push(`updated ${formatRelativeTime(voice.lastUpdatedAt)}`);
  return parts.join(' · ');
}

/**
 * The Voice section of a Person's page.
 *
 * @param props - See {@link EntityVoiceprintSectionProps}.
 * @returns The section.
 *
 * @stability experimental
 */
export function EntityVoiceprintSection({ entityId, label, canForget }: EntityVoiceprintSectionProps) {
  const voice = useEntityVoiceprint(entityId);
  const [confirmOpen, setConfirmOpen] = useState(false);

  let body;
  if (voice.isLoading && !voice.data) {
    body = (
      <Typography variant="body2" color="text.secondary">
        Loading…
      </Typography>
    );
  } else if (voice.error) {
    body = (
      <Alert
        severity="warning"
        action={
          <Button color="inherit" size="small" onClick={() => void voice.refresh()}>
            Retry
          </Button>
        }
      >
        {voice.error}
      </Alert>
    );
  } else if (voice.data?.enrolled) {
    body = (
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5 }}>
        <Typography variant="body2" sx={{ flex: '1 1 16rem', minWidth: 0 }}>
          {voiceprintSummaryLine(voice.data)}
        </Typography>
        {canForget && (
          <Button size="small" color="error" onClick={() => setConfirmOpen(true)} disabled={voice.isForgetting}>
            Forget voice
          </Button>
        )}
      </Box>
    );
  } else {
    body = (
      <Typography variant="body2" color="text.secondary">
        No voice learned yet. Naming this person as a speaker in a recording teaches it, when voice
        recognition is on in your Knowledge graph settings.
      </Typography>
    );
  }

  return (
    <Box component="section" aria-labelledby="entity-voice-title" sx={{ mb: 3 }}>
      <Typography id="entity-voice-title" variant="h6" component="h2" sx={{ fontWeight: 600, mb: 1 }}>
        Voice
      </Typography>
      {body}
      {voice.forgetError && !confirmOpen && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {voice.forgetError}
        </Alert>
      )}

      <Dialog
        open={confirmOpen}
        onClose={() => {
          if (!voice.isForgetting) setConfirmOpen(false);
        }}
        aria-labelledby="entity-voice-forget-title"
        aria-describedby="entity-voice-forget-description"
      >
        <DialogTitle id="entity-voice-forget-title">Forget {label}&apos;s voice?</DialogTitle>
        <DialogContent>
          <DialogContentText id="entity-voice-forget-description">
            The voice samples learned for {label} are deleted, and speakers are no longer suggested as{' '}
            {label}. The person, your recordings and your notes are not changed. Naming {label} as a
            speaker again learns the voice again.
          </DialogContentText>
          {voice.forgetError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {voice.forgetError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={voice.isForgetting}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            disabled={voice.isForgetting}
            onClick={() => {
              void voice.forget().then((ok) => {
                if (ok) setConfirmOpen(false);
              });
            }}
          >
            Forget voice
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
