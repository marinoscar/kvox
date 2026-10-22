/**
 * Keyboard shortcuts of the explorer (GIC-17, #678): the page-level ones (Undo, Redo, Back,
 * Forward, "?") and the dialog that documents all of them, canvas keys included.
 *
 * The page-level shortcuts are listened for on the document so they work wherever focus is on
 * the page, but never while the user is typing (an input, a textarea, a select, an editable
 * element) or while a dialog or menu is open: Ctrl+Z in a text field must stay a text edit.
 */

import CloseIcon from '@mui/icons-material/Close';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { useEffect, useRef } from 'react';

import { modifierLabel } from './HistoryControls.js';

/** Whether a key event came from somewhere the user is typing or a layer that owns the keyboard. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
  return target.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null;
}

/**
 * The page-level actions {@link useExplorerShortcuts} calls.
 *
 * @stability experimental
 */
export interface ExplorerShortcutHandlers {
  /** Ctrl/Cmd+Z. */
  onUndo: () => void;
  /** Shift+Ctrl/Cmd+Z, or Ctrl+Y. */
  onRedo: () => void;
  /** `[`. */
  onBack: () => void;
  /** `]`. */
  onForward: () => void;
  /** `?`. */
  onHelp: () => void;
}

/**
 * Listens for the explorer's page-level shortcuts on the document.
 *
 * @param handlers - What each shortcut does.
 * @param enabled - Turn the listener off (for example while an early state is shown).
 *
 * @stability experimental
 */
export function useExplorerShortcuts(handlers: ExplorerShortcutHandlers, enabled = true): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key;
      if (mod && !event.altKey && (key === 'z' || key === 'Z')) {
        event.preventDefault();
        if (event.shiftKey) latest.current.onRedo();
        else latest.current.onUndo();
        return;
      }
      if (mod && !event.altKey && !event.shiftKey && (key === 'y' || key === 'Y')) {
        event.preventDefault();
        latest.current.onRedo();
        return;
      }
      if (mod || event.altKey) return;
      if (key === '[') {
        event.preventDefault();
        latest.current.onBack();
      } else if (key === ']') {
        event.preventDefault();
        latest.current.onForward();
      } else if (key === '?') {
        event.preventDefault();
        latest.current.onHelp();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

interface ShortcutRow {
  keys: string;
  does: string;
}

function shortcutGroups(): Array<{ title: string; rows: ShortcutRow[] }> {
  const mod = modifierLabel();
  return [
    {
      title: 'History',
      rows: [
        { keys: `${mod}+Z`, does: 'Undo the last change (expand, hide, filter, new seed)' },
        { keys: `Shift+${mod}+Z`, does: 'Redo' },
        { keys: '[', does: 'Back to the previous focus' },
        { keys: ']', does: 'Forward to the next focus' },
      ],
    },
    {
      title: 'Canvas (focus the canvas first)',
      rows: [
        { keys: '+  /  -', does: 'Zoom in / out' },
        { keys: '0', does: 'Fit the graph' },
        { keys: '←  /  →', does: 'Select the previous / next node' },
        { keys: 'Enter', does: 'Expand the selected node' },
        { keys: 'P', does: 'Pin or unpin the selected node' },
        { keys: 'O', does: 'Open the selected entity’s page' },
        { keys: 'L', does: 'Switch between graph and list' },
        { keys: 'Esc', does: 'Clear the selection' },
      ],
    },
    {
      title: 'Anywhere',
      rows: [{ keys: '?', does: 'Show this list' }],
    },
  ];
}

/**
 * Props of {@link ShortcutsDialog}.
 *
 * @stability experimental
 */
export interface ShortcutsDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Closes it. */
  onClose: () => void;
}

/**
 * The "?" dialog: every keyboard shortcut of the explorer.
 *
 * @stability experimental
 */
export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs" aria-labelledby="explorer-shortcuts-title">
      <DialogTitle id="explorer-shortcuts-title" sx={{ display: 'flex', alignItems: 'center', pr: 1 }}>
        <Box component="span" sx={{ flex: 1 }}>
          Keyboard shortcuts
        </Box>
        <IconButton aria-label="Close" onClick={onClose} sx={{ width: 44, height: 44 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        {shortcutGroups().map((group) => (
          <Box key={group.title} component="section" aria-label={group.title} sx={{ mb: 2 }}>
            <Typography variant="subtitle2" component="h3" gutterBottom>
              {group.title}
            </Typography>
            <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.75 }}>
              {group.rows.map((row) => (
                <Box key={row.keys} sx={{ display: 'contents' }}>
                  <Box
                    component="dt"
                    sx={{ fontFamily: 'monospace', fontSize: 13, bgcolor: 'action.hover', borderRadius: 0.5, px: 0.75, py: 0.25, whiteSpace: 'nowrap' }}
                  >
                    {row.keys}
                  </Box>
                  <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                    {row.does}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        ))}
      </DialogContent>
    </Dialog>
  );
}
