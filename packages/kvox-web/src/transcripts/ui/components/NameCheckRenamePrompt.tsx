/**
 * The nudge after a speaker rename — issue #329, epic #326.
 *
 * The moment somebody types "Oscar" over "Speaker A" is the moment they know
 * the name the recognizer has probably been mangling all along, so this offers
 * to go and look: `Check the transcript for misheard "Oscar"?`.
 *
 * It is a NUDGE, so unlike the explicit "Fix names with AI" action it is shown
 * only when the check could actually run — a key saved and AI enabled. An
 * unsolicited prompt that opens onto "add your key first" is a nag, not a help.
 * That needs the AI availability (`ai.useAiState()`), and this component exists so the page never has
 * to read it on load: it is mounted only after a rename has SAVED (see
 * `TranscriptPage`), so the config request happens then, and at most once per
 * prompt.
 */

import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';

import type { TranscriptAiAccess } from '../slots.js';

export interface NameCheckRenamePromptProps {
  name: string;
  onCheck: () => void;
  onDismiss: () => void;
  /** The viewer's AI availability; the nudge shows only when a check could run. */
  ai: TranscriptAiAccess;
}

export function nameCheckPromptMessage(name: string): string {
  return `Check the transcript for misheard "${name}"?`;
}

export function NameCheckRenamePrompt({ name, onCheck, onDismiss, ai }: NameCheckRenamePromptProps) {
  const { canGenerate, isLoading } = ai.useAiState();

  return (
    <Snackbar
      open={!isLoading && canGenerate}
      autoHideDuration={12_000}
      onClose={(_event, reason) => {
        if (reason === 'clickaway') return;
        onDismiss();
      }}
      message={nameCheckPromptMessage(name)}
      action={
        <>
          <Button color="secondary" size="small" onClick={onCheck}>
            Check
          </Button>
          <Button color="inherit" size="small" onClick={onDismiss} aria-label="Dismiss">
            Not now
          </Button>
        </>
      }
    />
  );
}

