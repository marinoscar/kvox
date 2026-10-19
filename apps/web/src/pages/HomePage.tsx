/**
 * `/` — the signed-in home page, the web edition's binding of the packaged one.
 *
 * The page itself is `KvoxHomePage` of `@marinoscar/kvox-web/home/ui` (issue #632):
 * the desktop host draws the same Home from the same code. Its header carries the rules (one content request per content type, no
 * breakpoint read) and the history; this file is only what is the web edition's:
 *
 *   - the transcription capability probe, `GET /api/transcription/config`. It is not
 *     content but a deployment CAPABILITY: it decides whether "New transcript" works
 *     at all, it is the same probe `NewTranscriptPage` runs, and it is fired in
 *     parallel with the content requests and never blocks them. A FAILED PROBE IS
 *     "NOT AVAILABLE": an enabled button whose flow ends in a 409 is worse than a
 *     disabled one that says why.
 *   - the "New transcript" button in the hero and the "Record or upload audio" step of
 *     the journey, the two slots the packaged page leaves for it.
 *   - the product tagline, from the one identity file (`@app/shared`).
 */

import { TAGLINE } from '@app/shared';
import { useIsMounted, useKvoxHost } from '@marinoscar/kvox-web/core/headless';
import { KvoxHomePage } from '@marinoscar/kvox-web/home/ui';
import { getTranscriptionConfig } from '@marinoscar/kvox-web/transcription/headless';
import { useEffect, useState } from 'react';

import { NewTranscriptButton } from '../components/home/NewTranscriptButton';
import { useRecordAudioStep } from '../components/home/recordAudioStep';

export default function HomePage() {
  const isMounted = useIsMounted();
  const kvoxHost = useKvoxHost();

  const [transcriptionAvailable, setTranscriptionAvailable] = useState(false);
  const [isCheckingTranscription, setIsCheckingTranscription] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void getTranscriptionConfig(kvoxHost)
      .then((config) => {
        if (!cancelled && isMounted()) setTranscriptionAvailable(config.available);
      })
      .catch(() => {
        if (!cancelled && isMounted()) setTranscriptionAvailable(false);
      })
      .finally(() => {
        if (!cancelled && isMounted()) setIsCheckingTranscription(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isMounted, kvoxHost]);

  const recordStep = useRecordAudioStep({
    available: transcriptionAvailable,
    isChecking: isCheckingTranscription,
  });

  return (
    <KvoxHomePage
      tagline={TAGLINE}
      // The slices' own steps (write a note, explore the knowledge) are not part of
      // the web edition's first run: it ends in the "New transcript" call to action.
      journeySteps={[]}
      extraSteps={[recordStep]}
      heroActions={
        <NewTranscriptButton
          available={transcriptionAvailable}
          isChecking={isCheckingTranscription}
        />
      }
    />
  );
}
