/**
 * The web edition's AI availability for the notes slice (issue #502, epic #498).
 *
 * Generating a note runs on the viewer's own provider key, and whether they have
 * one, which models they may pick and whether the deployment allows AI at all is
 * `GET /api/ai-tasks/config` (`useAiTasksConfig`), an endpoint of this app. The
 * slice receives it through the `ai` prop of `NewNotePage`,
 * `UserNoteTemplatesPage` and `NotePage`.
 */

import { useMemo } from 'react';
import type { NotesAiAccess, NotesAiModel, NotesAiState } from '@marinoscar/kvox-web/notes/ui';

import { AiKeyRequired } from '../components/ai/AiKeyRequired';
import { useAiTasksConfig } from '../hooks/useAiTasksConfig';
import type { UseAiTasksConfigReturn } from '../hooks/useAiTasksConfig';

/** Stable, so a page that lists `models` in a dependency array does not re-run on every render. */
const NO_MODELS: readonly NotesAiModel[] = [];

/** The slice's view of the app's AI config read. Memoised on the pieces it is built from. */
export function useNotesAiState(read: UseAiTasksConfigReturn): NotesAiState {
  const { config, isLoading, loadError, keyConfigured, available } = read;
  const models = config?.models ?? NO_MODELS;
  const defaultModel = config?.defaultModel ?? null;
  return useMemo(
    () => ({ isLoading, loadError, keyConfigured, available, models, defaultModel }),
    [available, defaultModel, isLoading, keyConfigured, loadError, models],
  );
}

function useAppNotesAiState(): NotesAiState {
  return useNotesAiState(useAiTasksConfig());
}

/** The viewer's AI availability and the "add your key" state, as the notes slice takes them. */
export const appNotesAiAccess: NotesAiAccess = {
  useAiState: useAppNotesAiState,
  KeyRequired: AiKeyRequired,
};
