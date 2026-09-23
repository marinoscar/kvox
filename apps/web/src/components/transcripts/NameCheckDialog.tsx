/**
 * "Fix names with AI" — the start dialog (issues #329 and #330, epic #326).
 *
 * Chooses WHAT to look for (the speakers whose names were mis-heard, plus any
 * extra names or terms) and HOW HARD (standard vs thorough), shows what that
 * will cost before anything is spent, and starts the check. It never shows
 * results: on success it hands off to the suggestions panel, which reads the
 * run's state from the API rather than from anything this dialog knew.
 *
 * =============================================================================
 * THE AI GATE LIVES HERE, NOT ON THE PAGE
 * =============================================================================
 *
 * `TranscriptPage` deliberately does not read `useAiConfig()` for its AI
 * entry points (see its header): hiding a feature from users who have not set
 * up a key hides it from exactly the people who have never heard of it. So the
 * page always offers "Fix names with AI" to an editor, and THIS dialog — only
 * mounted while open, so the config is read only when someone asks — renders
 * `AiKeyRequired` when the caller has no key, and an explanation when the
 * deployment has AI switched off. A 409 `ai_key_missing` from the start call
 * (a key deleted in another tab) lands in the same `AiKeyRequired` state.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import FormLabel from '@mui/material/FormLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useEffect, useMemo, useState } from 'react';

import { AiKeyRequired } from '../ai/AiKeyRequired';
import { useAiConfig } from '../../hooks/useAiConfig';
import { useIsMounted } from '../../hooks/useIsMounted';
import { ApiError } from '../../services/api';
import {
  getNameCheckEstimate,
  isGenericSpeakerName,
  MAX_NAME_CHECK_TERMS,
  nameCheckConflictReason,
} from '../../services/transcriptNameChecks';
import type {
  CreateNameCheckInput,
  NameCheckEstimate,
  NameCheckMode,
} from '../../services/transcriptNameChecks';
import type { TranscriptSpeaker } from '../../services/transcripts';
import { KeytermsField } from './KeytermsField';

export const NAME_CHECK_MODE_COPY: Record<NameCheckMode, { label: string; description: string }> = {
  standard: {
    label: 'Standard',
    description: 'Checks words that sound like these names — fast and low cost',
  },
  thorough: {
    label: 'Thorough',
    description:
      'The AI reads the whole transcript — finds more, uses more of your AI credits',
  },
};

export interface NameCheckDialogProps {
  open: boolean;
  transcriptId: string;
  speakers: readonly TranscriptSpeaker[];
  /** Pre-select only these speakers. Absent or null selects every named one. */
  initialSpeakerIds?: readonly string[] | null;
  onClose: () => void;
  /** Starts the check. Throws the API's error, which this dialog interprets. */
  onStart: (input: CreateNameCheckInput) => Promise<unknown>;
  /** A check is now running (started here, or already was): show its results. */
  onOpenResults: () => void;
}

/** "≈ 3 requests, ~12,400 tokens". Exported so the test and the UI agree. */
export function formatEstimate(estimate: NameCheckEstimate): string {
  const requests = `${estimate.requests.toLocaleString('en-US')} ${
    estimate.requests === 1 ? 'request' : 'requests'
  }`;
  return `≈ ${requests}, ~${estimate.inputTokens.toLocaleString('en-US')} tokens`;
}

function DialogBody({
  transcriptId,
  speakers,
  initialSpeakerIds,
  onClose,
  onStart,
  onOpenResults,
}: Omit<NameCheckDialogProps, 'open'>) {
  const isMounted = useIsMounted();
  const { keyConfigured, available, isLoading: aiLoading } = useAiConfig();

  const namedSpeakers = useMemo(
    () => speakers.filter((speaker) => !isGenericSpeakerName(speaker.displayName)),
    [speakers],
  );

  const [selected, setSelected] = useState<string[]>(() => {
    const named = namedSpeakers.map((speaker) => speaker.id);
    if (!initialSpeakerIds) return named;
    return named.filter((id) => initialSpeakerIds.includes(id));
  });
  const [terms, setTerms] = useState<string[]>([]);
  const [mode, setMode] = useState<NameCheckMode>('standard');

  const [estimate, setEstimate] = useState<NameCheckEstimate | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [keyMissing, setKeyMissing] = useState(false);

  const canUseAi = !aiLoading && keyConfigured && available && !keyMissing;

  useEffect(() => {
    if (!canUseAi) return;
    let cancelled = false;
    setEstimateLoading(true);
    setEstimateError(null);
    getNameCheckEstimate(transcriptId, mode)
      .then((next) => {
        if (!cancelled) setEstimate(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEstimate(null);
        setEstimateError(
          err instanceof ApiError ? err.message : 'The cost could not be estimated.',
        );
      })
      .finally(() => {
        if (!cancelled) setEstimateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canUseAi, mode, transcriptId]);

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  const handleStart = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onStart({
        mode,
        speakerIds: selected,
        ...(terms.length > 0 ? { terms } : {}),
      });
      if (!isMounted()) return;
      onOpenResults();
      onClose();
    } catch (err) {
      if (!isMounted()) return;
      const reason = nameCheckConflictReason(err);
      if (reason === 'name_check_running') {
        onOpenResults();
        onClose();
        return;
      }
      if (reason === 'ai_key_missing') {
        setKeyMissing(true);
        return;
      }
      if (reason === 'ai_not_configured') {
        setSubmitError(
          'AI features are not enabled for this deployment. Your administrator can turn them on.',
        );
        return;
      }
      if (reason === 'transcript_not_ready') {
        setSubmitError('This transcript is still being processed. Try again once it is ready.');
        return;
      }
      setSubmitError(
        err instanceof ApiError ? err.message : 'The name check could not be started.',
      );
    } finally {
      if (isMounted()) setSubmitting(false);
    }
  };

  if (aiLoading) {
    return (
      <DialogContent>
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress aria-label="Checking your AI configuration" />
        </Box>
      </DialogContent>
    );
  }

  if (!keyConfigured || keyMissing) {
    return (
      <>
        <DialogContent>
          <AiKeyRequired />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </>
    );
  }

  if (!available) {
    return (
      <>
        <DialogContent>
          <Alert severity="info">
            AI features are not enabled for this deployment right now, so names cannot be
            checked. Your administrator can turn them on.
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </>
    );
  }

  const nothingToCheck = selected.length === 0 && terms.length === 0;

  return (
    <>
      <DialogContent>
        <Stack spacing={2.5}>
          <Typography variant="body2" color="text.secondary">
            Speech recognition often mis-hears names. The AI looks for places where a name
            was probably transcribed wrong and suggests a fix — nothing changes until you
            accept it.
          </Typography>

          {namedSpeakers.length > 0 ? (
            <FormControl component="fieldset">
              <FormLabel component="legend">Speaker names to look for</FormLabel>
              <FormGroup>
                {namedSpeakers.map((speaker) => (
                  <FormControlLabel
                    key={speaker.id}
                    control={
                      <Checkbox
                        checked={selected.includes(speaker.id)}
                        onChange={() => toggle(speaker.id)}
                      />
                    }
                    label={speaker.displayName}
                  />
                ))}
              </FormGroup>
            </FormControl>
          ) : (
            <Typography variant="body2" color="text.secondary">
              None of the speakers have been named yet. Rename a speaker, or add the names
              below.
            </Typography>
          )}

          <KeytermsField
            value={terms}
            onChange={setTerms}
            maxKeyterms={MAX_NAME_CHECK_TERMS}
            suggestions={[]}
            label="Other names & terms"
            placeholder="e.g. Kvox, Solís"
            helperText="Other people, places or products mentioned in the recording. Press Enter or type a comma after each."
          />

          <FormControl component="fieldset">
            <FormLabel component="legend">How thorough</FormLabel>
            <RadioGroup
              value={mode}
              onChange={(event) => setMode(event.target.value as NameCheckMode)}
            >
              {(Object.keys(NAME_CHECK_MODE_COPY) as NameCheckMode[]).map((value) => (
                <FormControlLabel
                  key={value}
                  value={value}
                  control={<Radio />}
                  sx={{ alignItems: 'flex-start', mb: 0.5 }}
                  label={
                    <Box sx={{ pt: 1 }}>
                      <Typography variant="body2">{NAME_CHECK_MODE_COPY[value].label}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {NAME_CHECK_MODE_COPY[value].description}
                      </Typography>
                    </Box>
                  }
                />
              ))}
            </RadioGroup>
          </FormControl>

          <Typography variant="body2" color="text.secondary" role="status">
            {estimateLoading
              ? 'Estimating cost…'
              : estimate
                ? `${formatEstimate(estimate)} on your own AI account`
                : (estimateError ?? '')}
          </Typography>

          {nothingToCheck && (
            <Typography variant="caption" color="text.secondary">
              No speakers selected and no names added — only names given when the recording
              was uploaded will be checked.
            </Typography>
          )}

          {submitError && <Alert severity="error">{submitError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={submitting}
          onClick={() => void handleStart()}
        >
          {submitting ? 'Starting…' : 'Check names'}
        </Button>
      </DialogActions>
    </>
  );
}

export function NameCheckDialog({ open, ...rest }: NameCheckDialogProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));

  return (
    <Dialog
      open={open}
      onClose={rest.onClose}
      fullWidth
      maxWidth="sm"
      fullScreen={fullScreen}
      aria-labelledby="name-check-dialog-title"
    >
      <DialogTitle id="name-check-dialog-title">Fix names with AI</DialogTitle>
      {/* Mounted only while open: the body reads the AI config and the
          estimate, and neither is worth a request until someone asks. */}
      {open ? <DialogBody {...rest} /> : null}
    </Dialog>
  );
}

export default NameCheckDialog;
