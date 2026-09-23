/**
 * What a template actually is, shown under the regenerate dialog's template
 * select — issue #312.
 *
 * A template's NAME is a promise; its description, output format and section
 * list are what the note will actually look like. Choosing a different recipe
 * by name alone is choosing blind, and the choice is billed to the user's own
 * provider account, so the dialog shows the recipe beside the choice.
 *
 * `missing` and `error` are different sentences for the same reason
 * `useNoteTemplateDetail` keeps them apart: a template the user can no longer
 * read is a fact about the template, not a failure worth retrying.
 */

import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  NOTE_BODY_FORMAT_LABELS,
  NOTE_OUTPUT_FORMAT_LABELS,
  effectiveBodyFormat,
} from '../../services/noteTemplates';
import type { NoteTemplate } from '../../services/noteTemplates';

/** How many sections are listed before the rest collapse into "+N more". */
const MAX_SECTIONS_SHOWN = 6;

export interface TemplateSummaryProps {
  template: NoteTemplate | null;
  state: 'idle' | 'loading' | 'loaded' | 'missing' | 'error';
}

function Description({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  // Measured rather than guessed from a character count: two lines hold very
  // different amounts of text on a phone and on a desktop. The caller keys this
  // component by template id, so picking another template starts collapsed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text]);

  return (
    <Box>
      <Typography
        ref={ref}
        variant="body2"
        color="text.secondary"
        sx={
          expanded
            ? undefined
            : {
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
        }
      >
        {text}
      </Typography>
      {(overflowing || expanded) && (
        <Link
          component="button"
          type="button"
          variant="body2"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? 'less' : 'more'}
        </Link>
      )}
    </Box>
  );
}

export function TemplateSummary({ template, state }: TemplateSummaryProps) {
  let content: ReactNode = null;

  if (state === 'loading') {
    content = (
      <Stack spacing={0.5}>
        <Skeleton variant="text" width="90%" />
        <Skeleton variant="text" width="60%" />
        <Skeleton variant="text" width="40%" />
      </Stack>
    );
  } else if (state === 'missing') {
    content = (
      <Typography variant="body2" color="text.secondary">
        This template’s details are no longer available to you.
      </Typography>
    );
  } else if (state === 'error') {
    content = (
      <Typography variant="body2" color="text.secondary">
        This template’s details could not be loaded.
      </Typography>
    );
  } else if (state === 'loaded' && template) {
    const shown = template.structure.slice(0, MAX_SECTIONS_SHOWN);
    const hiddenCount = template.structure.length - shown.length;
    const facts: [string, string][] = [];
    if (template.tone) facts.push(['Tone', template.tone]);
    if (template.length) facts.push(['Length', template.length]);
    if (template.model) facts.push(['Model', template.model]);

    content = (
      <Stack spacing={1}>
        {template.description && <Description key={template.id} text={template.description} />}

        <Typography variant="body2">
          <Box component="span" sx={{ color: 'text.secondary' }}>
            Format:{' '}
          </Box>
          {NOTE_OUTPUT_FORMAT_LABELS[template.outputFormat] ?? template.outputFormat}
        </Typography>

        <Typography variant="body2">
          <Box component="span" sx={{ color: 'text.secondary' }}>
            Body format:{' '}
          </Box>
          {NOTE_BODY_FORMAT_LABELS[effectiveBodyFormat(template.bodyFormat)]}
        </Typography>

        {shown.length > 0 && (
          <Box>
            <Typography variant="body2" color="text.secondary">
              Sections:
            </Typography>
            <Box
              component="ol"
              sx={{ m: 0, pl: 3, typography: 'body2', '& li': { lineHeight: 1.5 } }}
            >
              {shown.map((section, index) => (
                <li key={`${index}-${section}`}>{section}</li>
              ))}
            </Box>
            {hiddenCount > 0 && (
              <Typography variant="caption" color="text.secondary">
                +{hiddenCount} more
              </Typography>
            )}
          </Box>
        )}

        {facts.length > 0 && (
          <Typography variant="body2">
            {facts.map(([label, value], index) => (
              <Box component="span" key={label}>
                {index > 0 && ' · '}
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  {label}:{' '}
                </Box>
                {value}
              </Box>
            ))}
          </Typography>
        )}
      </Stack>
    );
  }

  return (
    <Box
      aria-live="polite"
      aria-busy={state === 'loading'}
      data-testid="template-summary"
      sx={
        content
          ? {
              mt: 1,
              p: 1.5,
              borderRadius: 1,
              border: 1,
              borderColor: 'divider',
              bgcolor: 'action.hover',
            }
          : undefined
      }
    >
      {content}
    </Box>
  );
}

export default TemplateSummary;
