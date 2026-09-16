/**
 * The "what is this person called?" form — one implementation, two entry
 * points (issue #220, epic #19).
 *
 * =============================================================================
 * WHY THIS IS A COMPONENT AND NOT A SECOND COPY
 * =============================================================================
 *
 * It started as the rename view inside `SpeakerActions`. Issue #220 gave the
 * segment overflow menu its own rename item, which needs the identical surface
 * — same suggestions, same freeSolo behaviour, same disabled-while-blank Save.
 * Copying it would mean two places to keep the suggestion filter, the trim rule
 * and the scope wording in step, and the failure mode of letting them drift is
 * not a visual glitch: it is one entry point promising "every line" while the
 * other quietly does something else.
 *
 * SUGGESTIONS ARE THE POINT, not a convenience. The realistic correction is
 * "Speaker 3 is also Ana" — the name is almost always one already on screen,
 * and typing it again by hand is how two spellings of one person end up in the
 * same transcript. `freeSolo` because a name this transcript has never seen is
 * the other half of the job, and `openOnFocus` so the list is offered rather
 * than discovered.
 *
 * THE HELPER LINE IS LOAD-BEARING. `speaker.rename` rewrites the name on every
 * line that speaker holds, which is what the user almost always wants and is
 * also irreversible-looking at the moment of typing. Stating the scope under
 * the field means the guarantee is read at the moment it is being relied on,
 * rather than inferred from the menu item that got here.
 */

import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import { useState } from 'react';

export interface SpeakerNameFormProps {
  /** The name to open with — the speaker's current one. */
  initialName: string;
  /** Names already used in this transcript. The current one is filtered out. */
  nameSuggestions: readonly string[];
  /** The scope sentence under the field. */
  helperText?: string;
  onCancel: () => void;
  /** Called with the TRIMMED draft. Never called with an empty string. */
  onSave: (displayName: string) => void;
}

const DEFAULT_HELPER_TEXT = 'Renames this speaker on every line they speak.';

export function SpeakerNameForm({
  initialName,
  nameSuggestions,
  helperText = DEFAULT_HELPER_TEXT,
  onCancel,
  onSave,
}: SpeakerNameFormProps) {
  // Seeded from the prop rather than synced to it: the caller MOUNTS this form
  // when its surface opens and unmounts it on close, so "reset the draft each
  // time the surface opens" is the mount itself. An effect syncing state to a
  // prop would additionally clobber a half-typed name the moment an optimistic
  // rename came back from the queue with a different `initialName`.
  const [draftName, setDraftName] = useState(initialName);
  const trimmed = draftName.trim();

  return (
    <Box sx={{ p: 2, minWidth: 260 }}>
      <Autocomplete
        freeSolo
        openOnFocus
        options={nameSuggestions.filter((name) => name !== initialName)}
        value={draftName}
        onInputChange={(_event, value) => setDraftName(value)}
        renderInput={(params) => (
          <TextField
            {...params}
            autoFocus
            label="Speaker name"
            size="small"
            helperText={helperText}
          />
        )}
      />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 }}>
        <Button size="small" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={!trimmed}
          onClick={() => onSave(trimmed)}
        >
          Save
        </Button>
      </Box>
    </Box>
  );
}

export default SpeakerNameForm;
