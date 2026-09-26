/**
 * Where a proposed row came from — one entry per `evidence[]` (#367; §5.3).
 *
 * Each entry quotes its source and offers the way back to it:
 *   ▶ Play             segment evidence — seeks the sheet's ONE shared player
 *                      (`useSourceAudio`) to the line's start and plays;
 *   Show in note       note evidence — highlights the span in the rendered body;
 *   Open in transcript segment evidence — `/transcripts/:id?segment=:segmentId`.
 * `stale` evidence says so: the cited text has changed since extraction.
 */

import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import type { ProposalEvidence } from '../../../services/graph';
import { formatTimestamp } from '../../../utils/playbackIntervals';

/** Quotes longer than this start clamped to three lines with a "Show more". */
const LONG_QUOTE = 180;

export interface EvidenceListProps {
  evidence: readonly ProposalEvidence[];
  /** Absent when there is no origin transcript to play. */
  onPlay?: (evidence: ProposalEvidence) => void;
  /** Absent off the note page. */
  onShowInNote?: (evidence: ProposalEvidence) => void;
  /** Called when a link leaves the page (the sheet closes itself). */
  onNavigate?: () => void;
}

export function transcriptHref(evidence: ProposalEvidence): string | null {
  if (evidence.source !== 'segment' || !evidence.transcriptId) return null;
  const base = `/transcripts/${encodeURIComponent(evidence.transcriptId)}`;
  return evidence.segmentId ? `${base}?segment=${encodeURIComponent(evidence.segmentId)}` : base;
}

function EvidenceEntry({
  evidence,
  onPlay,
  onShowInNote,
  onNavigate,
}: { evidence: ProposalEvidence } & Omit<EvidenceListProps, 'evidence'>) {
  const [expanded, setExpanded] = useState(false);
  const long = evidence.quote.length > LONG_QUOTE;
  const at = evidence.startMs !== null ? formatTimestamp(evidence.startMs) : null;
  const href = transcriptHref(evidence);
  const origin =
    evidence.source === 'segment'
      ? [evidence.speakerName ?? 'Speaker', at].filter(Boolean).join(' · ')
      : 'From the note';

  return (
    <Box component="li" sx={{ listStyle: 'none', py: 0.75 }}>
      <Typography
        variant="body2"
        component="blockquote"
        sx={{
          m: 0,
          pl: 1,
          borderLeft: 2,
          borderColor: 'divider',
          fontStyle: 'italic',
          wordBreak: 'break-word',
          ...(long && !expanded
            ? {
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
            : {}),
        }}
      >
        “{evidence.quote}”
      </Typography>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25 }}>
        {origin}
        {evidence.stale ? ' · The text has changed since' : ''}
      </Typography>
      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', alignItems: 'center', mt: 0.25 }}>
        {long && (
          <Button size="small" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
            {expanded ? 'Show less' : 'Show more'}
          </Button>
        )}
        {onPlay && evidence.source === 'segment' && evidence.startMs !== null && (
          <Button
            size="small"
            startIcon={<PlayArrowIcon fontSize="small" />}
            aria-label={`Play from ${at}`}
            onClick={() => onPlay(evidence)}
          >
            Play
          </Button>
        )}
        {onShowInNote && evidence.source === 'note' && (
          <Button size="small" onClick={() => onShowInNote(evidence)}>
            Show in note
          </Button>
        )}
        {href && (
          <Link component={RouterLink} to={href} variant="body2" onClick={onNavigate} sx={{ px: 0.5 }}>
            Open in transcript
          </Link>
        )}
      </Stack>
    </Box>
  );
}

export function EvidenceList({ evidence, ...handlers }: EvidenceListProps) {
  if (evidence.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        No evidence recorded.
      </Typography>
    );
  }
  return (
    <Box component="ul" aria-label="Evidence" sx={{ m: 0, p: 0 }}>
      {evidence.map((entry) => (
        <EvidenceEntry key={entry.id} evidence={entry} {...handlers} />
      ))}
    </Box>
  );
}

export default EvidenceList;
