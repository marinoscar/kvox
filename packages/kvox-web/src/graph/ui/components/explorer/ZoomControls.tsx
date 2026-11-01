/**
 * `ZoomControls` — the canvas's on-screen camera cluster (#775): zoom in, zoom
 * out, fit, and full screen. Bottom-right of the canvas, above whatever covers
 * it (`insets`). 44px targets on a coarse pointer; every button has a name.
 *
 * Imported only by `GraphCanvas`, so it lives in the lazy canvas chunk.
 */

import AddIcon from '@mui/icons-material/Add';
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import RemoveIcon from '@mui/icons-material/Remove';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import type { ReactElement } from 'react';

/**
 * Props of {@link ZoomControls}.
 *
 * @stability experimental
 */
export interface ZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  /** Absent: the Fullscreen API is not available and the button is not shown. */
  onToggleFullscreen?: () => void;
  /** Whether the canvas pane is full screen now. */
  fullscreen?: boolean;
  /** A coarse pointer: 44px targets. */
  coarse?: boolean;
  /** Px covered at the bottom and right edges (the inspector, a sheet). */
  insets?: { bottom: number; right: number };
}

/** The camera cluster. */
export function ZoomControls({
  onZoomIn,
  onZoomOut,
  onFit,
  onToggleFullscreen,
  fullscreen = false,
  coarse = false,
  insets,
}: ZoomControlsProps) {
  const target = coarse ? 44 : 32;
  const button = (label: string, icon: ReactElement, onClick: () => void, extra: Record<string, unknown> = {}) => (
    <Tooltip title={label} placement="left" disableInteractive>
      <IconButton
        aria-label={label}
        onClick={onClick}
        size="small"
        sx={{ width: target, height: target, borderRadius: 0 }}
        {...extra}
      >
        {icon}
      </IconButton>
    </Tooltip>
  );
  return (
    <Paper
      role="group"
      aria-label="Canvas zoom"
      elevation={2}
      data-testid="canvas-zoom-controls"
      sx={{
        position: 'absolute',
        right: 12 + (insets?.right ?? 0),
        bottom: 12 + (insets?.bottom ?? 0),
        zIndex: 3,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: 1.5,
      }}
    >
      {button('Zoom in', <AddIcon fontSize="small" />, onZoomIn)}
      <Divider />
      {button('Zoom out', <RemoveIcon fontSize="small" />, onZoomOut)}
      <Divider />
      {button('Fit to screen', <CenterFocusStrongIcon fontSize="small" />, onFit)}
      {onToggleFullscreen && (
        <>
          <Divider />
          {button(
            fullscreen ? 'Exit full screen' : 'Full screen',
            fullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />,
            onToggleFullscreen,
            { 'aria-pressed': fullscreen },
          )}
        </>
      )}
    </Paper>
  );
}
