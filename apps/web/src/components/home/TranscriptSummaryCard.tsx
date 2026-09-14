/**
 * One transcript, as the home page shows it — issue #32, epic #19.
 *
 * ONE CARD FOR BOTH LISTS. "Recent" and "Shared with me" differ by exactly one
 * line — the owner's name and the role the caller holds — and two card
 * components would be two places for the metadata line, the truncation rules
 * and the tap target to drift apart. The difference is a prop.
 *
 * ⚠ IT IS A GRID CELL, NOT A ROW. There is no `useMediaQuery` here and there
 * must not be one: the phone-list / tablet-2-up / desktop-3-or-4-up layout is
 * done entirely by the parent's `Grid` sizes, so the responsive behaviour costs
 * no JavaScript, no re-render on resize, and — the point — no sixth coupled
 * breakpoint gate beside the five `docs/specs/settings-ui.md` §5 pins together.
 * The card simply fills whatever column it lands in.
 */

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useNavigate } from 'react-router-dom';

import { TranscriptStatusChip } from '../transcripts/TranscriptStatusChip';
import type { TranscriptAccessRole, TranscriptListItem } from '../../services/transcripts';
import { formatDuration } from '../../utils/playbackIntervals';
import { formatRelativeTime } from '../../utils/relativeTime';

/**
 * A summary row, plus the owner's name when the API has one to give.
 *
 * ⚠ `ownerName` IS OPTIONAL BECAUSE THE DTO DOES NOT CARRY IT YET.
 * `transcriptListItemSchema` (`apps/api/src/transcripts/dto/transcript.dto.ts`)
 * has `access` but no owner field, and issue #32 is web-only — adding one is an
 * API change this change is not allowed to make. Typed optional rather than
 * omitted so the day the field lands, `SharedWithMe` renders it with no further
 * edit; until then the caller reads "Shared with you", which is true and is
 * information the `access` chip does not already carry.
 */
export type HomeTranscriptItem = TranscriptListItem & {
  ownerName?: string | null;
};

/** How a share role is spelled for a person. `owner` never reaches a chip here. */
export function accessRoleLabel(access: TranscriptAccessRole): string {
  switch (access) {
    case 'editor':
      return 'Editor';
    case 'viewer':
      return 'Viewer';
    default:
      return 'Owner';
  }
}

export interface TranscriptSummaryCardProps {
  transcript: HomeTranscriptItem;
  /**
   * Show who shared it and what the caller may do with it.
   *
   * Off in "Recent", where every row is the caller's own and an "Owner" chip on
   * all eight would be eight chips saying nothing.
   */
  showOwner?: boolean;
}

export function TranscriptSummaryCard({
  transcript,
  showOwner = false,
}: TranscriptSummaryCardProps) {
  const navigate = useNavigate();

  // Joined into ONE line rather than rendered as three elements: at a 3-column
  // desktop width the cell is ~300px, and three separately-wrapping spans turn
  // into a ragged four-line block on exactly the widths this layout exists for.
  const meta = [
    formatRelativeTime(transcript.createdAt),
    formatDuration(transcript.durationMs),
    `${transcript.speakerCount} ${transcript.speakerCount === 1 ? 'speaker' : 'speakers'}`,
  ].join(' · ');

  return (
    // NOT an `li` itself: the two callers wrap this in a `Grid` cell that
    // carries the list semantics, and `ul > div > li` is invalid markup that
    // axe's `list` rule rejects outright.
    <Card variant="outlined" sx={{ height: '100%', width: '100%' }}>
      <CardActionArea
        onClick={() => navigate(`/transcripts/${transcript.id}`)}
        sx={{
          p: 2,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 0.75,
          // Without this the action area's content can report a wider
          // min-content width than the column it sits in and push the page
          // sideways — the same reason the shell sets `minWidth: 0` all the
          // way down.
          minWidth: 0,
        }}
      >
        <Box sx={{ width: '100%', minWidth: 0 }}>
          <Typography variant="subtitle1" component="h3" noWrap sx={{ fontWeight: 600 }}>
            {transcript.title}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="p">
            {meta}
          </Typography>
          {showOwner && (
            <Typography variant="caption" color="text.secondary" component="p" noWrap>
              {transcript.ownerName
                ? `Shared by ${transcript.ownerName}`
                : 'Shared with you'}
            </Typography>
          )}
        </Box>

        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75 }}>
          <TranscriptStatusChip transcript={transcript} />
          {showOwner && (
            <Chip size="small" variant="outlined" label={accessRoleLabel(transcript.access)} />
          )}
        </Stack>
      </CardActionArea>
    </Card>
  );
}

export default TranscriptSummaryCard;
