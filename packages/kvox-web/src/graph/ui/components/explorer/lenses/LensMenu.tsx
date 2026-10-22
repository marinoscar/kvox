/**
 * The Lens menu (GIC-17, #678): apply a built-in or saved lens, save the current view as one,
 * rename and delete saved lenses.
 *
 *   - Expanded and medium: a "Lens" button that opens a dropdown.
 *   - Compact (phone): no button in the bar; the overflow menu's "Lenses" row opens the SAME
 *     list as a full-screen dialog (`compactOpen`).
 *
 * The component is controlled: it knows nothing of the URL or the settings store. The page binds
 * `onApply` to the URL and the actions to `useExplorerLenses`.
 */

import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Popover from '@mui/material/Popover';
import TextField from '@mui/material/TextField';
import { useState } from 'react';

import type { InputModality } from '../shell/useInputModality.js';
import type { WindowClass } from '../shell/useWindowClass.js';
import { LENS_LIMITS, type BuiltInLens, type ExplorerLens } from './lensModel.js';

/**
 * Props of {@link ExplorerLensMenu}.
 *
 * @stability experimental
 */
export interface ExplorerLensMenuProps {
  /** Compact draws the list full-screen and no button. */
  windowClass: WindowClass;
  /** A coarse pointer makes the rows 44px. */
  inputModality: InputModality;
  /** The built-in presets that exist in the caller's ontology. */
  builtIn: BuiltInLens[];
  /** The user's saved lenses. */
  lenses: ExplorerLens[];
  /** The lens the URL names, if any. */
  activeId: string | null;
  /** The view no longer matches the active lens. */
  modified: boolean;
  /** A write is in flight. */
  busy: boolean;
  /** A sentence about the last failed or refused write. */
  error: string | null;
  /** Dismisses `error`. */
  onClearError: () => void;
  /** Apply a lens. */
  onApply: (lens: ExplorerLens) => void;
  /** Save the current view under this name; resolves `true` when it was saved. */
  onSave: (name: string) => Promise<boolean>;
  /** Rename a saved lens; resolves `true` when it was renamed. */
  onRename: (id: string, name: string) => Promise<boolean>;
  /** Delete a saved lens. */
  onDelete: (id: string) => Promise<boolean>;
  /** Compact only: whether the full-screen list is open. */
  compactOpen?: boolean;
  /** Compact only: closes the full-screen list. */
  onCompactClose?: () => void;
  /** Disables the button (the list view has no layout, but lenses still apply; used while loading). */
  disabled?: boolean;
}

type NameTarget = { kind: 'save' } | { kind: 'rename'; lens: ExplorerLens };

/**
 * The Lens button and its list.
 *
 * @stability experimental
 */
export function ExplorerLensMenu(props: ExplorerLensMenuProps) {
  const { windowClass, compactOpen = false, onCompactClose, disabled, activeId, modified } = props;
  const compact = windowClass === 'compact';
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [naming, setNaming] = useState<NameTarget | null>(null);

  const close = () => {
    setAnchor(null);
    onCompactClose?.();
  };
  const active = [...props.builtIn, ...props.lenses].find((lens) => lens.id === activeId);

  const panel = (
    <LensPanel
      {...props}
      error={naming ? null : props.error}
      onApply={(lens) => {
        props.onApply(lens);
        close();
      }}
      onStartSave={() => setNaming({ kind: 'save' })}
      onStartRename={(lens) => setNaming({ kind: 'rename', lens })}
    />
  );

  return (
    <>
      {!compact && (
        <Button
          size="small"
          startIcon={<FilterAltOutlinedIcon />}
          aria-haspopup="dialog"
          aria-expanded={Boolean(anchor)}
          disabled={disabled}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{ whiteSpace: 'nowrap', maxWidth: 200 }}
        >
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {active ? `${active.name}${modified ? ' (changed)' : ''}` : 'Lens'}
          </Box>
        </Button>
      )}
      {compact ? (
        <Dialog fullScreen open={compactOpen} onClose={close} aria-labelledby="explorer-lens-title">
          <DialogTitle id="explorer-lens-title" sx={{ display: 'flex', alignItems: 'center', pr: 1 }}>
            <Box component="span" sx={{ flex: 1 }}>
              Lenses
            </Box>
            <IconButton aria-label="Close" onClick={close} sx={{ width: 44, height: 44 }}>
              <CloseIcon />
            </IconButton>
          </DialogTitle>
          <DialogContent sx={{ px: 0 }}>{panel}</DialogContent>
        </Dialog>
      ) : (
        <Popover
          open={Boolean(anchor)}
          anchorEl={anchor}
          onClose={close}
          slotProps={{ paper: { sx: { width: 340, maxWidth: 'calc(100vw - 32px)' } } }}
        >
          <Box role="dialog" aria-label="Lenses">
            {panel}
          </Box>
        </Popover>
      )}
      <LensNameDialog
        target={naming}
        busy={props.busy}
        error={props.error}
        onClearError={props.onClearError}
        onCancel={() => setNaming(null)}
        onSubmit={async (name) => {
          const done =
            naming?.kind === 'rename' ? await props.onRename(naming.lens.id, name) : await props.onSave(name);
          if (done) setNaming(null);
        }}
      />
    </>
  );
}

interface LensPanelProps extends ExplorerLensMenuProps {
  onStartSave: () => void;
  onStartRename: (lens: ExplorerLens) => void;
}

function LensPanel(props: LensPanelProps) {
  const { builtIn, lenses, activeId, modified, inputModality, onApply, onDelete, error, onClearError, busy } = props;
  const row = inputModality === 'touch' ? 48 : 40;
  const atLimit = lenses.length >= LENS_LIMITS.maxLenses;
  return (
    <Box>
      {error && (
        // A rename or save problem shows in its own dialog; this one is for a failed delete or load.
        <Alert severity="warning" onClose={onClearError} sx={{ m: 1 }}>
          {error}
        </Alert>
      )}
      <List dense disablePadding subheader={<ListSubheader sx={{ lineHeight: '32px' }}>Built-in</ListSubheader>}>
        {builtIn.length === 0 && (
          <ListItem>
            <ListItemText secondary="None of the built-in lenses fit your ontology." />
          </ListItem>
        )}
        {builtIn.map((lens) => (
          <ListItem key={lens.id} disablePadding>
            <ListItemButton onClick={() => onApply(lens)} selected={activeId === lens.id} sx={{ minHeight: row }}>
              <ListItemText
                primary={lens.name}
                secondary={activeId === lens.id && modified ? 'Changed since applied' : lens.description}
              />
              {activeId === lens.id && (
                <ListItemIcon sx={{ minWidth: 0 }}>
                  <CheckIcon fontSize="small" aria-label="Applied" />
                </ListItemIcon>
              )}
            </ListItemButton>
          </ListItem>
        ))}
      </List>
      <Divider />
      <List dense disablePadding subheader={<ListSubheader sx={{ lineHeight: '32px' }}>Your lenses</ListSubheader>}>
        {lenses.length === 0 && (
          <ListItem>
            <ListItemText secondary="Save the current view to come back to it." />
          </ListItem>
        )}
        {lenses.map((lens) => (
          <ListItem
            key={lens.id}
            disablePadding
            secondaryAction={
              <Box sx={{ display: 'flex' }}>
                <IconButton
                  edge="end"
                  aria-label={`Rename ${lens.name}`}
                  disabled={busy}
                  onClick={() => props.onStartRename(lens)}
                  sx={{ width: row, height: row }}
                >
                  <DriveFileRenameOutlineIcon fontSize="small" />
                </IconButton>
                <IconButton
                  edge="end"
                  aria-label={`Delete ${lens.name}`}
                  disabled={busy}
                  onClick={() => void onDelete(lens.id)}
                  sx={{ width: row, height: row }}
                >
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Box>
            }
          >
            <ListItemButton onClick={() => onApply(lens)} selected={activeId === lens.id} sx={{ minHeight: row, pr: 12 }}>
              <ListItemText
                primary={lens.name}
                secondary={activeId === lens.id && modified ? 'Changed since applied' : undefined}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
      <Divider />
      <Box sx={{ p: 1 }}>
        <Button
          fullWidth
          startIcon={<SaveOutlinedIcon />}
          onClick={props.onStartSave}
          disabled={busy || atLimit}
          sx={{ justifyContent: 'flex-start', minHeight: row }}
        >
          Save current view as a lens
        </Button>
        {atLimit && (
          <Alert severity="info" sx={{ mt: 1 }}>
            You have {LENS_LIMITS.maxLenses} lenses, the most you can save. Delete one to make room.
          </Alert>
        )}
      </Box>
    </Box>
  );
}

interface LensNameDialogProps {
  target: NameTarget | null;
  busy: boolean;
  error: string | null;
  onClearError: () => void;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void>;
}

function LensNameDialog({ target, busy, error, onClearError, onCancel, onSubmit }: LensNameDialogProps) {
  const [name, setName] = useState('');
  const [seenTarget, setSeenTarget] = useState<NameTarget | null>(null);
  // Start from the current name each time the dialog opens for something new.
  if (target !== seenTarget) {
    setSeenTarget(target);
    setName(target?.kind === 'rename' ? target.lens.name : '');
  }
  const title = target?.kind === 'rename' ? 'Rename lens' : 'Save as a lens';
  return (
    <Dialog open={target !== null} onClose={busy ? undefined : onCancel} fullWidth maxWidth="xs" aria-labelledby="explorer-lens-name-title">
      <DialogTitle id="explorer-lens-name-title">{title}</DialogTitle>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit(name);
        }}
      >
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) onClearError();
            }}
            slotProps={{ htmlInput: { maxLength: LENS_LIMITS.maxNameLength } }}
            error={Boolean(error)}
            helperText={error ?? ' '}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={busy || name.trim().length === 0}>
            {target?.kind === 'rename' ? 'Rename' : 'Save'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
