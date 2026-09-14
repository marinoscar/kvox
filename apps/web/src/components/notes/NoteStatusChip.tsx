/**
 * The status chip every note surface uses — issue #57, epic #45.
 *
 * ONE COMPONENT, not a chip per page, for the reason `TranscriptStatusChip`
 * states for itself: the library list, the note page's header and (later) the
 * home page all answer the same question, and three chips would be three
 * chances for `generating` to mean something slightly different in each.
 *
 * ⚠ `draft` IS NOT "A DRAFT THE USER IS WRITING". It is the API's word for
 * "created, never generated even once" (`dto/note.dto.ts`: a note that already
 * produced content is `generating` again, never back to `draft`), which from
 * the reader's side is the first moment of a generation that has been queued
 * and has not yet produced a token. Labelling it "Draft" would be technically
 * faithful and practically a lie — the user pressed Generate a second ago and
 * nothing is asking them to do anything. So it reads as "Starting…", with the
 * same spinner `generating` gets.
 */

import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';

import type { NoteStatus } from '../../services/notes';

interface StatusDescriptor {
  label: string;
  color: 'default' | 'primary' | 'success' | 'error' | 'warning';
}

/**
 * Status → the word and the colour.
 *
 * A `Record` over the union rather than a `switch`, so the compiler is what
 * notices the day the API grows a sixth status — an unhandled `default:`
 * returning "Unknown" would ship that gap to a user instead.
 */
const DESCRIPTORS: Record<NoteStatus, StatusDescriptor> = {
  draft: { label: 'Starting…', color: 'primary' },
  generating: { label: 'Generating…', color: 'primary' },
  ready: { label: 'Ready', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  deleting: { label: 'Deleting', color: 'default' },
};

export function noteStatusLabel(status: NoteStatus): string {
  return DESCRIPTORS[status].label;
}

export interface NoteStatusChipProps {
  status: NoteStatus;
  size?: 'small' | 'medium';
}

export function NoteStatusChip({ status, size = 'small' }: NoteStatusChipProps) {
  const descriptor = DESCRIPTORS[status];
  const inFlight = status === 'draft' || status === 'generating';

  return (
    <Chip
      size={size}
      color={descriptor.color}
      variant={descriptor.color === 'default' ? 'filled' : 'outlined'}
      label={descriptor.label}
      // A spinner INSIDE the chip rather than beside it: the two are one
      // statement ("this is still moving"), and a separate spinner is a second
      // thing to align, wrap and explain to a screen reader.
      icon={
        inFlight ? (
          <CircularProgress
            size={size === 'small' ? 12 : 16}
            thickness={6}
            // `aria-hidden` because the chip's own text already says
            // "Generating…"; an unlabelled progressbar beside it announces a
            // second, meaningless element.
            aria-hidden
            sx={{ ml: 0.75 }}
          />
        ) : undefined
      }
    />
  );
}

export default NoteStatusChip;
