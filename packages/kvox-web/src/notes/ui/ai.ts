import { createElement } from 'react';
import type { ComponentType, ReactElement } from 'react';

/**
 * One model the viewer may pick for a note.
 *
 * @stability experimental
 */
export interface NotesAiModel {
  /** The provider's own model id, for example `gpt-5.4`. */
  id: string;
  /** What a person reads in the picker. Never show the id where a label belongs. */
  label: string;
}

/**
 * The viewer's AI availability, as the notes screens need it.
 *
 * @remarks
 * Two booleans, and they are not interchangeable: `available` is a fact about
 * the deployment (AI is on and at least one model is permitted), `keyConfigured`
 * is a fact about the viewer (they saved their own provider key). Screens say
 * the two apart.
 *
 * @stability experimental
 */
export interface NotesAiState {
  /** The answer has not arrived yet. */
  isLoading: boolean;
  /** A message when reading the availability failed, else `null`. */
  loadError: string | null;
  /** The viewer has saved a key. */
  keyConfigured: boolean;
  /** The deployment permits AI at all. */
  available: boolean;
  /** The models the viewer may pick, already narrowed by deployment policy. */
  models: readonly NotesAiModel[];
  /** The model to offer first, or `null`; never a model absent from `models`. */
  defaultModel: string | null;
}

/**
 * AI access for generating notes: the viewer's availability and the empty state
 * that asks for a key. The host supplies it because the key and the model list
 * live in the host (the web edition reads them from its own AI settings).
 *
 * @remarks
 * Optional on every page that takes it. Without it the page behaves as for a
 * viewer with no AI: it asks for a key and offers no generation.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export interface NotesAiAccess {
  /** A hook that reads the viewer's AI availability. */
  useAiState: () => NotesAiState;
  /** The "add your AI key to use this" state. */
  KeyRequired: ComponentType;
}

function useNoAiState(): NotesAiState {
  return {
    isLoading: false,
    loadError: null,
    keyConfigured: false,
    available: false,
    models: [],
    defaultModel: null,
  };
}

function NoAiKeyRequired(): ReactElement {
  return createElement('p', null, 'AI is not available in this application.');
}

/**
 * What a page uses when its host passes no {@link NotesAiAccess}: no AI at all.
 *
 * @stability experimental
 */
export const NO_NOTES_AI_ACCESS: NotesAiAccess = {
  useAiState: useNoAiState,
  KeyRequired: NoAiKeyRequired,
};
