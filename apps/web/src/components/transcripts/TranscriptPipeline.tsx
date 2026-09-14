/**
 * The four-step pipeline stepper, and the failed state that replaces it.
 *
 * Issue #30, epic #19. Shown while a transcript is not yet readable, which is
 * the only time the user has nothing else to look at — so this IS the page for
 * however many minutes the provider takes, and it has to answer "is this
 * working?" without the vocabulary the API uses internally.
 *
 * ORIENTATION FLIPS AT `sm`, and it is not one of the five coupled gates
 * (`common/Layout.tsx`): those decide which navigation chrome exists, this one
 * decides whether four labelled steps fit on one line. They happen to share a
 * number because 600px is where a row of four labels stops fitting, not because
 * they are related.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';

import type { TranscriptDetail } from '../../services/transcripts';
import {
  PIPELINE_STEPS,
  failureMessage,
  pipelineStepIndex,
  processingStageLabel,
} from '../../utils/transcriptDisplay';

interface TranscriptPipelineProps {
  transcript: TranscriptDetail;
  /** Owner only — the API refuses a retry from anyone else with a 404. */
  canRetry: boolean;
  onRetry: () => void;
  isRetrying: boolean;
  /** Set when a retry request itself failed, as distinct from the transcript. */
  retryError?: string | null;
}

export function TranscriptPipeline({
  transcript,
  canRetry,
  onRetry,
  isRetrying,
  retryError,
}: TranscriptPipelineProps) {
  const theme = useTheme();
  const isNarrow = useMediaQuery(theme.breakpoints.down('sm'));

  if (transcript.status === 'failed') {
    return (
      <Alert
        severity="error"
        action={
          canRetry ? (
            <Button color="inherit" size="small" onClick={onRetry} disabled={isRetrying}>
              {isRetrying ? 'Retrying…' : 'Retry'}
            </Button>
          ) : undefined
        }
      >
        <AlertTitle>This recording could not be transcribed</AlertTitle>
        {/* The provider's own reason, verbatim, rather than a generic sentence:
            "the audio contained no speech" and "the credential was rejected"
            need completely different things from the person reading this. */}
        {failureMessage(transcript)}
        {retryError && (
          <Typography variant="body2" sx={{ mt: 1 }} color="error">
            {retryError}
          </Typography>
        )}
      </Alert>
    );
  }

  const activeStep = pipelineStepIndex(transcript);
  const stage = processingStageLabel(transcript);

  return (
    <Box>
      <Stepper
        activeStep={activeStep}
        orientation={isNarrow ? 'vertical' : 'horizontal'}
        // `alternativeLabel` puts the caption UNDER the dot, which is what
        // stops four labels from colliding in the horizontal treatment.
        alternativeLabel={!isNarrow}
        sx={{ mb: 2 }}
      >
        {PIPELINE_STEPS.map((step) => (
          <Step key={step}>
            <StepLabel>{step}</StepLabel>
          </Step>
        ))}
      </Stepper>
      <Typography variant="body2" color="text.secondary" role="status">
        {/* `role="status"` — a polite live region. The stepper changes with
            nobody touching the page, and a screen-reader user who cannot see
            the dot move would otherwise never learn that it did. */}
        {stage
          ? `${stage}. This page updates itself; you can leave and come back.`
          : 'Working on it. This page updates itself; you can leave and come back.'}
      </Typography>
    </Box>
  );
}

export default TranscriptPipeline;
