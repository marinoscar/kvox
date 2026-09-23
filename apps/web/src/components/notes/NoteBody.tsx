/**
 * A note's body, rendered in its own format — issue #334.
 *
 * A note is either MARKDOWN (the default, and every note that predates #334)
 * or PLAIN TEXT, snapshotted from its template at generation time. Markdown
 * goes through `MarkdownView` — raw HTML disabled, see that file's header —
 * and plain text is shown exactly as written, line breaks preserved, with no
 * markup interpretation at all: a plain-text note that happens to contain `#`
 * or `*` must not grow headings and bullets the AI was told not to produce.
 *
 * The forwarded ref points at the wrapper element, so `NoteCopyButton` can read
 * the RENDERED body (its `innerHTML` for a rich-text paste, its `innerText` for
 * "Copy as plain text") without a second renderer that could disagree with
 * what is on screen.
 */

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { forwardRef } from 'react';

import { MarkdownView } from './MarkdownView';
import type { NoteBodyFormat } from '../../services/noteTemplates';

export interface NoteBodyProps {
  /** The body text — markdown or plain, per `bodyFormat`. */
  children: string;
  /** Absent means `markdown`. */
  bodyFormat?: NoteBodyFormat | null;
}

export const NoteBody = forwardRef<HTMLDivElement, NoteBodyProps>(function NoteBody(
  { children, bodyFormat },
  ref,
) {
  if (bodyFormat === 'plain_text') {
    return (
      <Box ref={ref} data-body-format="plain_text">
        <Typography
          variant="body1"
          component="div"
          sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {children}
        </Typography>
      </Box>
    );
  }
  return (
    <Box ref={ref} data-body-format="markdown">
      <MarkdownView>{children}</MarkdownView>
    </Box>
  );
});

export default NoteBody;
