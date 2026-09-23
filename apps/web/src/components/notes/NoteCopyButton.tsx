/**
 * Copy a note to the clipboard — issue #334.
 *
 * A split button: the main "Copy" puts the note on the clipboard in the form
 * most pastes want — for a markdown note, BOTH the rendered HTML and its text
 * (`copyRich`), so pasting into a mail client or a document editor keeps the
 * headings and lists while pasting into a plain field still reads cleanly; for
 * a plain-text note, the text itself. The arrow opens the explicit
 * alternatives a markdown note has: its raw markdown source, or the rendered
 * text with no markup.
 *
 * The HTML comes from the RENDERED body on screen (`getRendered`), not from a
 * second renderer. That is safe because `MarkdownView` renders with raw HTML
 * disabled — the element tree holds nothing a model or a user could have
 * injected as markup — and it is also why this component takes a getter
 * rather than a string: the element is read at click time.
 *
 * Feedback follows `common/CopyButton`: the icon swaps to a check or an error
 * mark, and a visually hidden `role="status"` region announces the outcome.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import visuallyHidden from '@mui/utils/visuallyHidden';
import { useState } from 'react';

import { COPY_FAILED_MESSAGE } from '../common/CopyButton';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import type { NoteBodyFormat } from '../../services/noteTemplates';

export interface NoteCopyButtonProps {
  /** The raw stored body — markdown source, or plain text. */
  markdown: string;
  /** The rendered body element, read at click time. */
  getRendered: () => HTMLElement | null;
  /** Absent means `markdown`. */
  bodyFormat?: NoteBodyFormat | null;
  disabled?: boolean;
  /** `button` (header split button) or `icon` (compact, icon only, no menu). */
  variant?: 'button' | 'icon';
}

export function NoteCopyButton({
  markdown,
  getRendered,
  bodyFormat,
  disabled = false,
  variant = 'button',
}: NoteCopyButtonProps) {
  const { state, copy, copyRich } = useCopyToClipboard();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const isPlain = bodyFormat === 'plain_text';
  const isDisabled = disabled || markdown.trim() === '';

  const renderedText = (): string => {
    const element = getRendered();
    return element?.innerText?.trim() ? element.innerText : markdown;
  };

  const copyDefault = () => {
    if (isPlain) {
      void copy(markdown);
      return;
    }
    const element = getRendered();
    if (!element) {
      void copy(markdown);
      return;
    }
    void copyRich({ html: element.innerHTML, text: renderedText() });
  };

  const icon =
    state === 'done' ? (
      <CheckIcon fontSize="small" color="success" />
    ) : state === 'failed' ? (
      <ErrorOutlineIcon fontSize="small" color="error" />
    ) : (
      <ContentCopyIcon fontSize="small" />
    );

  const live = (
    <Box component="span" role="status" aria-live="polite" sx={visuallyHidden}>
      {state === 'done' ? 'Copied' : state === 'failed' ? COPY_FAILED_MESSAGE : ''}
    </Box>
  );

  if (variant === 'icon') {
    const tip =
      state === 'done' ? 'Copied' : state === 'failed' ? COPY_FAILED_MESSAGE : 'Copy note';
    return (
      <>
        <Tooltip title={isDisabled ? '' : tip}>
          <span>
            <IconButton
              size="small"
              aria-label="Copy note"
              onClick={copyDefault}
              disabled={isDisabled}
            >
              {icon}
            </IconButton>
          </span>
        </Tooltip>
        {live}
      </>
    );
  }

  return (
    <>
      <Box sx={{ display: 'inline-flex', alignItems: 'center' }}>
        <Button
          size="small"
          startIcon={icon}
          onClick={copyDefault}
          disabled={isDisabled}
          // The accessible name stays the resting label; the outcome is
          // announced by the live region, as in `CopyButton`.
          aria-label="Copy"
          title={state === 'failed' ? COPY_FAILED_MESSAGE : undefined}
          sx={isPlain ? undefined : { pr: 0.5 }}
        >
          {state === 'done' ? 'Copied' : 'Copy'}
        </Button>
        {!isPlain && (
          <IconButton
            size="small"
            aria-label="More copy options"
            aria-haspopup="menu"
            aria-expanded={menuAnchor ? 'true' : undefined}
            onClick={(event) => setMenuAnchor(event.currentTarget)}
            disabled={isDisabled}
            sx={{ ml: -0.5 }}
          >
            <ArrowDropDownIcon fontSize="small" />
          </IconButton>
        )}
      </Box>
      {!isPlain && (
        <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              void copy(markdown);
            }}
          >
            Copy as Markdown
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              void copy(renderedText());
            }}
          >
            Copy as plain text
          </MenuItem>
        </Menu>
      )}
      {live}
    </>
  );
}

export default NoteCopyButton;
