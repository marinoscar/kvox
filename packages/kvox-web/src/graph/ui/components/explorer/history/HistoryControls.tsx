/**
 * History controls and breadcrumbs of the explorer (GIC-17, #678).
 *
 *   - Expanded and medium: Back / Forward arrows (the focus trail) and Undo / Redo (the change
 *     stack) as icon buttons, each with a tooltip that names its shortcut.
 *   - Compact (phone): ONE back chevron in the top bar, drawn only while there is an earlier focus;
 *     Undo and Redo live in the overflow menu, and an Undo snackbar follows Hide and Expand.
 *
 * Breadcrumbs show the focus trail (Joe › Company A › Copilot rollout): every crumb is a button on
 * expanded, the middle is collapsed on medium, and a phone shows the current item only.
 */

import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import RedoIcon from '@mui/icons-material/Redo';
import UndoIcon from '@mui/icons-material/Undo';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

import type { InputModality } from '../shell/useInputModality.js';
import type { WindowClass } from '../shell/useWindowClass.js';

/** The platform's modifier key as the shortcuts dialog and tooltips name it. */
export function modifierLabel(): string {
  try {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘' : 'Ctrl';
  } catch {
    return 'Ctrl';
  }
}

/**
 * Props of {@link HistoryControls}.
 *
 * @stability experimental
 */
export interface HistoryControlsProps {
  /** The window class decides which controls are drawn. */
  windowClass: WindowClass;
  /** A coarse pointer makes the buttons 44px. */
  inputModality: InputModality;
  /** There is an earlier focus. */
  canGoBack: boolean;
  /** There is a later focus. */
  canGoForward: boolean;
  /** Back one focus. */
  onGoBack: () => void;
  /** Forward one focus. */
  onGoForward: () => void;
  /** There is a change to undo. */
  canUndo: boolean;
  /** There is a change to redo. */
  canRedo: boolean;
  /** Undo the last change. */
  onUndo: () => void;
  /** Redo the change Undo took back. */
  onRedo: () => void;
}

/**
 * Back / Forward and Undo / Redo as icon buttons; a single back chevron on a phone.
 *
 * @stability experimental
 */
export function HistoryControls(props: HistoryControlsProps) {
  const { windowClass, inputModality, canGoBack, canGoForward, onGoBack, onGoForward, canUndo, canRedo, onUndo, onRedo } =
    props;
  const size = inputModality === 'touch' ? 44 : 36;
  const mod = modifierLabel();
  const button = (label: string, shortcut: string, disabled: boolean, onClick: () => void, icon: ReactNode) => (
    <Tooltip title={`${label} (${shortcut})`}>
      {/* The span keeps the tooltip available on a disabled button. */}
      <span>
        <IconButton
          size="small"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          sx={{ width: size, height: size }}
        >
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );
  if (windowClass === 'compact') {
    if (!canGoBack) return null;
    return (
      <IconButton aria-label="Back" onClick={onGoBack} sx={{ width: 44, height: 44 }}>
        <ChevronLeftIcon />
      </IconButton>
    );
  }
  return (
    <Box role="group" aria-label="History" sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
      {button('Back', '[', !canGoBack, onGoBack, <ArrowBackIcon fontSize="small" />)}
      {button('Forward', ']', !canGoForward, onGoForward, <ArrowForwardIcon fontSize="small" />)}
      {button('Undo', `${mod}+Z`, !canUndo, onUndo, <UndoIcon fontSize="small" />)}
      {button('Redo', `Shift+${mod}+Z`, !canRedo, onRedo, <RedoIcon fontSize="small" />)}
    </Box>
  );
}

/**
 * One crumb of the focus trail.
 *
 * @stability experimental
 */
export interface Crumb {
  /** The node's id. */
  id: string;
  /** What to show; the node's label. */
  label: string;
}

/**
 * Props of {@link FocusBreadcrumbs}.
 *
 * @stability experimental
 */
export interface FocusBreadcrumbsProps {
  /** The focus trail up to the current focus, oldest first. */
  crumbs: Crumb[];
  /** The window class decides how much of the trail is drawn. */
  windowClass: WindowClass;
  /** Go to the crumb at this index. */
  onGoTo: (index: number) => void;
}

/**
 * The focus trail as breadcrumbs: full on expanded, middle-truncated on medium, the current item on compact.
 *
 * @stability experimental
 */
export function FocusBreadcrumbs({ crumbs, windowClass, onGoTo }: FocusBreadcrumbsProps) {
  if (crumbs.length === 0) return null;
  const current = crumbs[crumbs.length - 1];
  if (windowClass === 'compact') {
    return (
      <Typography variant="body2" noWrap aria-label={`Focus: ${current.label}`} sx={{ minWidth: 0, fontWeight: 600 }}>
        {current.label}
      </Typography>
    );
  }
  return (
    <Breadcrumbs
      aria-label="Focus trail"
      maxItems={windowClass === 'medium' ? 3 : 100}
      itemsBeforeCollapse={1}
      itemsAfterCollapse={2}
      sx={{ minWidth: 0, '& .MuiBreadcrumbs-ol': { flexWrap: 'nowrap' }, '& .MuiBreadcrumbs-li': { minWidth: 0 } }}
    >
      {crumbs.map((crumb, index) =>
        index === crumbs.length - 1 ? (
          <Typography key={`${crumb.id}:${index}`} variant="body2" aria-current="location" noWrap sx={{ fontWeight: 600 }}>
            {crumb.label}
          </Typography>
        ) : (
          <ButtonBase
            key={`${crumb.id}:${index}`}
            onClick={() => onGoTo(index)}
            sx={{ typography: 'body2', color: 'primary.main', maxWidth: 160, overflow: 'hidden', borderRadius: 0.5 }}
          >
            <Typography variant="body2" noWrap component="span">
              {crumb.label}
            </Typography>
          </ButtonBase>
        ),
      )}
    </Breadcrumbs>
  );
}
