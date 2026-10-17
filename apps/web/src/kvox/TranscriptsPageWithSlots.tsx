import { TranscriptsPage } from '@marinoscar/kvox-web/transcripts/ui';

import { appTranscriptSharing } from './transcriptSharing';
import { appTranscriptsLibrarySlots } from './transcriptSlots';

/**
 * `/transcripts`: the packaged library with this app's search-hits slot (graph
 * entities) and its sharing. Issue #500, epic #498.
 */
export function TranscriptsPageWithSlots() {
  return <TranscriptsPage slots={appTranscriptsLibrarySlots} sharing={appTranscriptSharing} />;
}
