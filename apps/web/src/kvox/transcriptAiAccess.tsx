/**
 * The web edition's AI availability for the transcripts slice (issue #500, epic #498).
 *
 * "Fix names with AI" runs on the viewer's own provider key, and whether they
 * have one is `GET /api/ai-tasks/config` (`useAiTasksConfig`), an endpoint of
 * this app. The slice receives it through the `ai` prop of `TranscriptPage`.
 */

import type { TranscriptAiAccess, TranscriptAiState } from '@marinoscar/kvox-web/transcripts/ui';

import { AiKeyRequired } from '../components/ai/AiKeyRequired';
import { useAiTasksConfig } from '../hooks/useAiTasksConfig';

function useTranscriptAiState(): TranscriptAiState {
  const { isLoading, keyConfigured, available, canGenerate } = useAiTasksConfig();
  return { isLoading, keyConfigured, available, canGenerate };
}

/** The viewer's AI availability and the "add your key" state, as the transcripts slice takes them. */
export const appTranscriptAiAccess: TranscriptAiAccess = {
  useAiState: useTranscriptAiState,
  KeyRequired: AiKeyRequired,
};
