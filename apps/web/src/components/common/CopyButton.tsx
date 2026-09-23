/**
 * The shared copy control — issue #308.
 *
 * One visual language for "copy this": `ContentCopy` at rest, `Check` once the
 * clipboard accepted the text, `ErrorOutline` when it refused. The state is
 * also announced through a visually hidden `aria-live="polite"` region, because
 * an icon swap is invisible to a screen reader.
 *
 * `text` may be a function, evaluated at CLICK time — for a caller whose text is
 * large or assembled from several parts and should not be built on every render.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import visuallyHidden from '@mui/utils/visuallyHidden';
import { useCallback } from 'react';

import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import type { CopyState } from '../../hooks/useCopyToClipboard';

export const COPY_FAILED_MESSAGE = 'Copy failed — select the text and copy manually';

export interface CopyButtonProps {
  text: string | (() => string);
  /** The resting label (tooltip for `icon`, button text for `button`). Default "Copy". */
  label?: string;
  variant?: 'icon' | 'button';
  size?: 'small' | 'medium';
  disabled?: boolean;
}

function labelFor(state: CopyState, label: string): string {
  if (state === 'done') return 'Copied';
  if (state === 'failed') return COPY_FAILED_MESSAGE;
  return label;
}

function announcementFor(state: CopyState): string {
  if (state === 'done') return 'Copied to clipboard';
  if (state === 'failed') return COPY_FAILED_MESSAGE;
  return '';
}

export function CopyButton({
  text,
  label = 'Copy',
  variant = 'icon',
  size = 'small',
  disabled = false,
}: CopyButtonProps) {
  const { state, copy } = useCopyToClipboard();

  const onClick = useCallback(() => {
    const value = typeof text === 'function' ? text() : text;
    void copy(value);
  }, [copy, text]);

  const icon =
    state === 'done' ? (
      <CheckIcon fontSize={size === 'small' ? 'small' : 'medium'} color="success" />
    ) : state === 'failed' ? (
      <ErrorOutlineIcon fontSize={size === 'small' ? 'small' : 'medium'} color="error" />
    ) : (
      <ContentCopyIcon fontSize={size === 'small' ? 'small' : 'medium'} />
    );

  const current = labelFor(state, label);

  const live = (
    <Box component="span" role="status" aria-live="polite" sx={visuallyHidden}>
      {announcementFor(state)}
    </Box>
  );

  if (variant === 'button') {
    return (
      <>
        <Button
          variant="contained"
          size={size}
          startIcon={icon}
          onClick={onClick}
          disabled={disabled}
          // The accessible name stays the resting label so a test or an assistive
          // user can find the control by what it does; the state is announced by
          // the live region instead.
          aria-label={label}
          title={state === 'failed' ? COPY_FAILED_MESSAGE : undefined}
        >
          {state === 'idle' ? label : state === 'done' ? 'Copied' : 'Copy failed'}
        </Button>
        {live}
      </>
    );
  }

  return (
    <>
      <Tooltip title={disabled ? '' : current}>
        {/* A span so the tooltip still has a hoverable target while disabled. */}
        <span>
          <IconButton size={size} onClick={onClick} disabled={disabled} aria-label={label}>
            {icon}
          </IconButton>
        </span>
      </Tooltip>
      {live}
    </>
  );
}

export default CopyButton;
