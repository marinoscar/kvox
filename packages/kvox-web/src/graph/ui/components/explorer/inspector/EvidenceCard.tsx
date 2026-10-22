/**
 * `EvidenceCard` — one quote and where it comes from (GIC-11, #672).
 *
 * An `article` named "source title, date": the quote (clamped to two lines
 * with "Show more" when the pane is roomy), the source's kind icon and title, the
 * date the citation was recorded, badges when the source is gone or was edited
 * since, and "Open at source", the API's own deep link (`/notes/:id?v=…` or
 * `/transcripts/:id?segment=…&t=ms`). The quote is always shown, even when the
 * source is unavailable: it is the user's own data and what keeps the citation
 * readable.
 */

import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import EditNoteOutlinedIcon from '@mui/icons-material/EditNoteOutlined';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useId, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import type { EvidenceLink } from '../../../../headless/clients/graph.js';
import { formatPrecisionDate } from '../../../../headless/utils/graphDisplay.js';

/** A quote longer than this gets "Show more" when it is clamped. */
const LONG_QUOTE_CHARS = 110;

/** The card's title: the source's own title, else what kind of source it is. */
export function evidenceSourceTitle(link: EvidenceLink): string {
  const { source } = link;
  switch (source.kind) {
    case 'segment':
      return source.transcriptTitle ?? (source.available ? 'Transcript' : 'Transcript no longer available');
    case 'note':
      return source.noteTitle ?? (source.available ? 'Note' : 'Note no longer available');
    case 'manual':
      return 'Set by hand';
    default:
      return 'Imported file';
  }
}

function SourceIcon({ link }: { link: EvidenceLink }) {
  const sx = { fontSize: 18, color: 'text.secondary', flexShrink: 0 } as const;
  switch (link.source.kind) {
    case 'segment':
      return <GraphicEqIcon aria-hidden sx={sx} />;
    case 'note':
      return <DescriptionOutlinedIcon aria-hidden sx={sx} />;
    case 'manual':
      return <EditNoteOutlinedIcon aria-hidden sx={sx} />;
    default:
      return <UploadFileOutlinedIcon aria-hidden sx={sx} />;
  }
}

/**
 * Props of {@link EvidenceCard}.
 *
 * @stability experimental
 */
export interface EvidenceCardProps {
  /** The citation to show. */
  link: EvidenceLink;
  /** Clamp the quote to two lines with a "Show more" button (the roomy panes). */
  clampQuote?: boolean;
  /** A coarse pointer: controls are at least 44px tall. */
  touch?: boolean;
}

/**
 * One citation as a card: quote, source, date, badges and the deep link.
 *
 * @stability experimental
 */
export function EvidenceCard({ link, clampQuote = false, touch = false }: EvidenceCardProps) {
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const { source } = link;
  const title = evidenceSourceTitle(link);
  const date = formatPrecisionDate(link.createdAt, 'day');
  const changed =
    (source.kind === 'segment' && source.textChanged) || (source.kind === 'note' && source.versionChanged);
  const unavailable = !source.available;
  const href = source.available ? source.href : null;
  const clamped = clampQuote && !expanded;
  const longQuote = link.quote.length > LONG_QUOTE_CHARS;
  const minHeight = touch ? 44 : undefined;

  const badges: ReactNode[] = [];
  if (unavailable) badges.push(<Chip key="gone" size="small" color="warning" variant="outlined" label="Source unavailable" />);
  if (changed) {
    badges.push(
      <Chip
        key="changed"
        size="small"
        variant="outlined"
        label={source.kind === 'note' ? 'Note edited since' : 'Text changed'}
      />,
    );
  }

  return (
    <Box
      component="article"
      aria-label={`${title}, ${date}`}
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5,
        p: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
        minWidth: 0,
        bgcolor: 'background.paper',
      }}
    >
      <Typography
        variant="body2"
        component="blockquote"
        sx={{
          m: 0,
          pl: 1.25,
          borderLeft: 3,
          borderColor: 'primary.main',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
          ...(clamped
            ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
            : {}),
        }}
      >
        “{link.quote}”
      </Typography>
      {clampQuote && longQuote && (
        <Button
          size="small"
          onClick={() => setExpanded((on) => !on)}
          aria-expanded={expanded}
          sx={{ alignSelf: 'flex-start', minHeight, ml: -0.5 }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
        <SourceIcon link={link} />
        <Typography id={titleId} variant="caption" sx={{ fontWeight: 600, minWidth: 0 }} noWrap>
          {title}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
          · {date}
        </Typography>
      </Box>
      {badges.length > 0 && <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>{badges}</Box>}
      {href && (
        <Button
          size="small"
          component={RouterLink}
          to={href}
          aria-label={`Open at source: ${title}`}
          endIcon={<OpenInNewIcon fontSize="inherit" />}
          sx={{ alignSelf: 'flex-start', minHeight, ml: -0.5 }}
        >
          Open at source
        </Button>
      )}
    </Box>
  );
}
