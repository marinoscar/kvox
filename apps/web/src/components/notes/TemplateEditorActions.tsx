/**
 * The note template editor's Save/Create action row — issue #331.
 *
 * =============================================================================
 * THE FORM IS LONG, SO FINISHING IT HAS TO BE REACHABLE FROM ITS END
 * =============================================================================
 *
 * The editor runs to name, description, an eight-row instructions box, output
 * format, a structure list, tone, length and model. With the only Save button
 * in the page's top bar, a user who has just filled in the last field has to
 * scroll all the way back up to finish — or, worse, does not realise there is
 * a way to finish at all. This row is rendered as the editor's own footer
 * (`NoteTemplateEditor`'s `footer` prop), so the action sits where the form
 * ends.
 *
 * =============================================================================
 * ⚠ STICKY FROM `sm` UP, DELIBERATELY STATIC ON PHONES
 * =============================================================================
 *
 * From `sm` up the row sticks to the bottom of the viewport while the editor
 * is in view, spanning the Paper edge to edge, so Save stays one click away
 * however far down the form the user is. Below `sm` it is static: the fixed
 * `BottomNav` owns the bottom edge of a phone, and a second sticky bar would
 * stack on top of it and eat a third of a small screen. On phones the page
 * keeps its top-bar Save button instead (see `UserNoteTemplatesPage`).
 *
 * This is CSS-only and it is NOT a sixth breakpoint gate (CLAUDE.md's "five
 * coupled breakpoint gates"): nothing here decides whether a piece of app
 * chrome mounts. Like `LibraryPageFrame`'s `down('sm')` read, it is one page's
 * layout choice about where its own action goes.
 */

import { useId } from 'react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

export interface TemplateEditorActionsProps {
  /** "Create template" for a new row, "Save changes" for a saved one. */
  primaryLabel: string;
  onSave: () => void;
  onCancel: () => void;
  /** The form cannot be saved as it stands (e.g. a required field is empty). */
  disabled: boolean;
  isSaving: boolean;
  /** Why `disabled` is true, shown beside the button and linked to it. */
  disabledReason?: string | null;
}

/** Keyboard shortcut hint, shown when nothing more useful needs saying. */
const SHORTCUT_HINT = 'Ctrl/⌘ + S to save';

export function TemplateEditorActions({
  primaryLabel,
  onSave,
  onCancel,
  disabled,
  isSaving,
  disabledReason,
}: TemplateEditorActionsProps) {
  const hintId = useId();
  const theme = useTheme();
  const paperRadius = `${theme.shape.borderRadius}px`;
  const reason = disabled && disabledReason ? disabledReason : null;

  return (
    <Box
      // ⚠ Every responsive difference is a responsive VALUE, never a literal
      // `[theme.breakpoints.up('sm')]` key: both emit the same
      // `@media (min-width:600px)` key, and one silently overwrites the other
      // (which rendered this row as a column on desktop).
      sx={{
        mt: 3,
        display: 'flex',
        // Phones: a caption stacked above a full-width button. Wider: one row.
        flexDirection: { xs: 'column', sm: 'row' },
        alignItems: { xs: 'stretch', sm: 'center' },
        justifyContent: 'flex-end',
        gap: 1,
        position: { xs: 'static', sm: 'sticky' },
        bottom: 0,
        zIndex: { sm: 1 },
        bgcolor: { sm: 'background.paper' },
        borderTop: { xs: 0, sm: 1 },
        borderColor: 'divider',
        // Edge to edge across the editor Paper, whose padding is `{ xs: 2, sm: 3 }`.
        mx: { sm: -3 },
        mb: { sm: -3 },
        px: { sm: 3 },
        py: { sm: 1.5 },
        // The Paper's own corner radius. Only the `borderRadius` shorthand is
        // multiplied by `theme.shape.borderRadius` in `sx`; these longhands are
        // plain CSS, so they take a literal length.
        borderBottomLeftRadius: { sm: paperRadius },
        borderBottomRightRadius: { sm: paperRadius },
      }}
    >
      <Typography
        id={hintId}
        variant="body2"
        color="text.secondary"
        sx={{
          mr: { sm: 'auto' },
          // On phones only a reason is worth the space; the shortcut is useless there.
          display: { xs: reason ? 'block' : 'none', sm: 'block' },
          typography: { xs: 'caption', sm: 'body2' },
        }}
      >
        {reason ?? SHORTCUT_HINT}
      </Typography>

      <Button
        onClick={onCancel}
        disabled={isSaving}
        sx={{ display: { xs: 'none', sm: 'inline-flex' } }}
      >
        Cancel
      </Button>

      <Button
        variant="contained"
        onClick={onSave}
        disabled={disabled || isSaving}
        aria-describedby={reason ? hintId : undefined}
        sx={{ width: { xs: '100%', sm: 'auto' } }}
      >
        {isSaving ? 'Saving…' : primaryLabel}
      </Button>
    </Box>
  );
}

export default TemplateEditorActions;
