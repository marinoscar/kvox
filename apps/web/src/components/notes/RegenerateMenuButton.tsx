/**
 * The Regenerate split button — issue #312.
 *
 * The common case ("the same again") is one click on the main part; everything
 * else ("a different template, context or model") is behind the arrow. Before
 * #312 the only door was a form, so the most common regeneration — the same
 * recipe, one more time — cost the user a trip through three controls they had
 * no intention of touching.
 *
 * ⚠ A NOTE WHOSE TEMPLATE WAS DELETED HAS NO "SAME". The API nulls `templateId`
 * when the row is gone and answers `409 template_required` to an empty body, so
 * the main part routes straight to the options dialog and the "same template"
 * item is shown disabled, with the reason, rather than hidden: a user who has
 * used the menu before should find out why it is missing, not wonder.
 *
 * This component decides nothing about cost or confirmation; both paths still
 * end in a dialog that states the price before anything is spent.
 */

import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import RefreshIcon from '@mui/icons-material/Refresh';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { useId, useRef, useState } from 'react';

import type { Note } from '../../services/notes';

export interface RegenerateMenuButtonProps {
  note: Note;
  disabled?: boolean;
  variant?: 'contained' | 'outlined';
  /** `small` inside an Alert's action slot; `medium` everywhere else. */
  size?: 'small' | 'medium';
  /** `inherit` picks up an Alert's own colour, the way its other actions do. */
  color?: 'primary' | 'inherit';
  onRegenerateSame: () => void;
  onRegenerateWithOptions: () => void;
}

export function RegenerateMenuButton({
  note,
  disabled = false,
  variant = 'outlined',
  size = 'medium',
  color = 'primary',
  onRegenerateSame,
  onRegenerateWithOptions,
}: RegenerateMenuButtonProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const buttonId = useId();

  const templateGone = note.templateId === null;

  const handleMain = () => {
    if (templateGone) onRegenerateWithOptions();
    else onRegenerateSame();
  };

  const choose = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  return (
    <>
      <ButtonGroup
        ref={anchorRef}
        variant={variant}
        size={size}
        color={color}
        disabled={disabled}
        aria-label="Regenerate"
      >
        <Button startIcon={<RefreshIcon />} onClick={handleMain}>
          Regenerate
        </Button>
        <Button
          id={buttonId}
          size="small"
          aria-label="More regenerate options"
          aria-haspopup="menu"
          aria-expanded={menuOpen ? 'true' : 'false'}
          aria-controls={menuOpen ? menuId : undefined}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <ArrowDropDownIcon />
        </Button>
      </ButtonGroup>

      <Menu
        id={menuId}
        anchorEl={anchorRef.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ list: { 'aria-labelledby': buttonId } }}
      >
        <MenuItem disabled={templateGone} onClick={() => choose(onRegenerateSame)}>
          <ListItemText
            primary="Regenerate with same template"
            secondary={
              templateGone
                ? 'The template this note used was deleted'
                : (note.templateName ?? 'Current template')
            }
          />
        </MenuItem>
        <MenuItem onClick={() => choose(onRegenerateWithOptions)}>
          <ListItemText primary="Regenerate with another template…" />
        </MenuItem>
      </Menu>
    </>
  );
}

export default RegenerateMenuButton;
