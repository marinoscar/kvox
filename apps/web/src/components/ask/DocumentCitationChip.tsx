/**
 * `DocumentCitationChip` — an Ask answer citing a transcript or note passage
 * (`[^docN]`, #380): a title chip that opens the transcript AT the cited moment
 * (`/transcripts/:id?t=<startMs>`) or the note (`/notes/:id`).
 */

import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import Chip from '@mui/material/Chip';
import { Link as RouterLink } from 'react-router-dom';

import { formatTimestamp } from '../../utils/playbackIntervals';

export interface DocumentCitationChipProps {
  documentId: string;
  documentKind: 'transcript' | 'note' | null;
  label: string | null;
  startMs: number | null;
}

/** Where a document citation opens. */
export function documentCitationHref(
  documentId: string,
  documentKind: 'transcript' | 'note' | null,
  startMs: number | null,
): string {
  const id = encodeURIComponent(documentId);
  if (documentKind === 'note') return `/notes/${id}`;
  return startMs !== null && startMs >= 0 ? `/transcripts/${id}?t=${Math.floor(startMs)}` : `/transcripts/${id}`;
}

export function DocumentCitationChip({ documentId, documentKind, label, startMs }: DocumentCitationChipProps) {
  const isNote = documentKind === 'note';
  const title = label?.trim() || (isNote ? 'Note' : 'Transcript');
  const at = !isNote && startMs !== null ? formatTimestamp(startMs) : null;
  const text = at ? `${title} · ${at}` : title;
  return (
    <Chip
      component={RouterLink}
      to={documentCitationHref(documentId, documentKind, startMs)}
      clickable
      size="small"
      variant="outlined"
      icon={isNote ? <DescriptionOutlinedIcon /> : <GraphicEqIcon />}
      label={text}
      aria-label={at ? `Play ${title} from ${at}` : `Open ${title}`}
      sx={{ height: 22, mx: 0.25, verticalAlign: 'middle', maxWidth: '100%' }}
    />
  );
}

export default DocumentCitationChip;
