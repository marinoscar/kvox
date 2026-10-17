/**
 * `DocumentCitationChip` — an Ask answer citing a transcript or note passage
 * (`[^docN]`, #380): a title chip that opens the transcript AT the cited moment
 * (`/transcripts/:id?t=<startMs>`) or the note (`/notes/:id`).
 */

import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import Chip from '@mui/material/Chip';
import { Link as RouterLink } from 'react-router-dom';

import { useKvoxHost } from '../../../core/headless/index.js';
import type { KvoxLinks } from '../../../core/headless/index.js';
import { formatTimestamp } from '../../../transcripts/headless/index.js';

export interface DocumentCitationChipProps {
  documentId: string;
  documentKind: 'transcript' | 'note' | null;
  label: string | null;
  startMs: number | null;
}

/** Where a document citation opens. */
export function documentCitationHref(
  links: Pick<KvoxLinks, 'transcript' | 'note'>,
  documentId: string,
  documentKind: 'transcript' | 'note' | null,
  startMs: number | null,
): string {
  if (documentKind === 'note') return links.note(documentId);
  const transcript = links.transcript(documentId);
  return startMs !== null && startMs >= 0 ? `${transcript}?t=${Math.floor(startMs)}` : transcript;
}

export function DocumentCitationChip({ documentId, documentKind, label, startMs }: DocumentCitationChipProps) {
  const host = useKvoxHost();
  const isNote = documentKind === 'note';
  const title = label?.trim() || (isNote ? 'Note' : 'Transcript');
  const at = !isNote && startMs !== null ? formatTimestamp(startMs) : null;
  const text = at ? `${title} · ${at}` : title;
  return (
    <Chip
      component={RouterLink}
      to={documentCitationHref(host.links, documentId, documentKind, startMs)}
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

