import { TranscriptPage } from '@marinoscar/kvox-web/transcripts/ui';

import { appTranscriptAiAccess } from './transcriptAiAccess';
import { appTranscriptSharing } from './transcriptSharing';
import { appTranscriptPageSlots } from './transcriptSlots';

/**
 * `/transcripts/:id`: the packaged transcript page with this app's slots (notes,
 * person links and "Add to graph" from the graph UI), its sharing and its AI
 * availability. Issue #500, epic #498.
 */
export function TranscriptPageWithSlots() {
  return (
    <TranscriptPage
      slots={appTranscriptPageSlots}
      sharing={appTranscriptSharing}
      ai={appTranscriptAiAccess}
    />
  );
}
