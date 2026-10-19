/**
 * The web edition's own step of the first-run journey: "Record or upload audio".
 *
 * The packaged Home (`KvoxHomePage` of `@marinoscar/kvox-web/home/ui`) does not know
 * about transcription: not every host has it (the desktop host has none in v1). The web
 * edition hands the step over as `extraSteps`, so the journey ends in the same
 * "New transcript" call to action, with the same disabled state and the same
 * explanation, as it did when the page lived in this app.
 */

import AddIcon from '@mui/icons-material/Add';
import type { KvoxJourneyStep } from '@marinoscar/kvox-web/home/headless';
import { useId } from 'react';
import { useNavigate } from 'react-router-dom';

import { TranscriptionBlockedNote } from './NewTranscriptButton';

export interface UseRecordAudioStepOptions {
  /** `GET /api/transcription/config` said this deployment can transcribe. */
  available: boolean;
  /** The capability probe has not answered yet. */
  isChecking: boolean;
}

/**
 * The "Record or upload audio" step for the current state of the capability probe.
 *
 * @remarks
 * Gated on `transcripts:write` by the packaged page (`permission`), the same string
 * `/transcripts/new` is guarded with. Disabled while the deployment cannot
 * transcribe, with the reason as its `body`; silent while the probe is in flight.
 */
export function useRecordAudioStep({ available, isChecking }: UseRecordAudioStepOptions): KvoxJourneyStep {
  const navigate = useNavigate();
  // `useId`: the hero's button and this step can be on screen together, and two
  // elements sharing one `id` is an axe failure.
  const reasonId = useId();
  const blocked = !available && !isChecking;

  return {
    key: 'record-or-upload-audio',
    title: 'Record or upload audio',
    body: blocked ? <TranscriptionBlockedNote id={reasonId} /> : null,
    done: false,
    permission: 'transcripts:write',
    action: {
      label: 'New transcript',
      icon: <AddIcon />,
      onClick: () => navigate('/transcripts/new'),
      disabled: !available,
      ...(blocked ? { describedBy: reasonId } : {}),
    },
  };
}
