/**
 * `EvidenceChip` — one numbered citation (#373, spec §5.3 "evidence ▶").
 *
 * GENERIC ON PURPOSE: it takes an evidence id and a number, nothing about the
 * statement it cites — #380 reuses it for Ask citations.
 *
 * Click or Enter opens the source: a `Popover` beside the chip, or on a phone
 * a bottom-sheet `Drawer` (the `NameSuggestionsPanel` pattern: radius 12,
 * 80vh). It shows the QUOTE (as text, never HTML), the source title, and one
 * action — "▶ Play from m:ss" for a transcript segment, "Open note" for a note
 * span — that navigates to the `href` #370 builds. An edited source says so;
 * a vanished one says "Source no longer available" and offers nothing.
 *
 * The phone decision is one page-level `down('sm')` read — where this
 * component puts its own popover — never whether app chrome mounts, so it is
 * not a sixth coupled breakpoint gate (Settings UI Pattern rule 5).
 */

import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Drawer from '@mui/material/Drawer';
import Popover from '@mui/material/Popover';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useGraphEvidence } from '../../hooks/useGraphEvidence';
import type { EvidenceLink } from '../../services/graph';
import { formatTimestamp } from '../../utils/playbackIntervals';

export interface EvidenceChipProps {
  evidenceId: string;
  /** 1-based number printed on the chip. */
  index: number;
}

/** The source's human title, whatever its kind. */
export function evidenceTitle(link: EvidenceLink | null | undefined): string | null {
  if (!link) return null;
  if (!link.source.available) return 'Source no longer available';
  switch (link.source.kind) {
    case 'segment':
      return link.source.transcriptTitle ?? 'Transcript';
    case 'note':
      return link.source.noteTitle ?? 'Note';
    case 'import':
      return link.source.sourceIri ?? 'Imported source';
    default:
      return null;
  }
}

function EvidenceBody({
  link,
  isLoading,
  error,
  titleId,
  onGo,
}: {
  link: EvidenceLink | null | undefined;
  isLoading: boolean;
  error: boolean;
  titleId: string;
  onGo: (href: string) => void;
}) {
  if (isLoading) {
    return (
      <Box sx={{ p: 2, width: 280, maxWidth: '100%' }} aria-busy="true">
        <Skeleton width="90%" />
      </Box>
    );
  }
  if (error) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography id={titleId} variant="body2">
          This source could not be loaded.
        </Typography>
      </Box>
    );
  }
  if (!link) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography id={titleId} variant="body2">
          Source no longer available
        </Typography>
      </Box>
    );
  }

  const { source } = link;
  const changed =
    (source.kind === 'segment' && source.textChanged) ||
    (source.kind === 'note' && source.versionChanged);

  let action: ReactNode = null;
  if (source.available && source.href) {
    const href = source.href;
    if (source.kind === 'segment') {
      action = (
        <Button size="small" variant="contained" startIcon={<PlayArrowIcon />} onClick={() => onGo(href)}>
          {source.startMs !== null ? `Play from ${formatTimestamp(source.startMs)}` : 'Open transcript'}
        </Button>
      );
    } else if (source.kind === 'note') {
      action = (
        <Button size="small" variant="contained" startIcon={<DescriptionOutlinedIcon />} onClick={() => onGo(href)}>
          Open note
        </Button>
      );
    }
  }

  return (
    <Box sx={{ p: 2, maxWidth: 420 }}>
      <Typography id={titleId} variant="subtitle2" component="p" sx={{ fontWeight: 600, mb: 1 }}>
        {evidenceTitle(link)}
      </Typography>
      <Box
        component="blockquote"
        sx={{
          m: 0,
          mb: 1.5,
          pl: 1.5,
          borderLeft: 3,
          borderColor: 'divider',
          fontStyle: 'italic',
          color: 'text.secondary',
          overflowWrap: 'anywhere',
        }}
      >
        {link.quote}
      </Box>
      {changed && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
          The source has been edited since this was recorded
        </Typography>
      )}
      {action}
    </Box>
  );
}

export function EvidenceChip({ evidenceId, index }: EvidenceChipProps) {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const navigate = useNavigate();
  const titleId = useId();
  const { data, isLoading, error } = useGraphEvidence(evidenceId);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = Boolean(anchor);

  const title = evidenceTitle(data);
  const label = title ? `Source ${index}: ${title}` : `Source ${index}`;

  const close = () => setAnchor(null);
  const go = (href: string) => {
    close();
    navigate(href);
  };

  const body = (
    <EvidenceBody link={data} isLoading={isLoading} error={error} titleId={titleId} onGo={go} />
  );

  return (
    <>
      <Chip
        // A span, not the default div: chips sit inside running text (<p>).
        component="span"
        size="small"
        label={index}
        clickable
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => setAnchor(event.currentTarget)}
        variant="outlined"
        sx={{ height: 20, minWidth: 24, fontSize: '0.7rem', '& .MuiChip-label': { px: 0.75 } }}
      />
      {isPhone ? (
        <Drawer
          anchor="bottom"
          open={open}
          onClose={close}
          slotProps={{
            paper: {
              sx: { borderTopLeftRadius: 12, borderTopRightRadius: 12, maxHeight: '80vh' },
              role: 'dialog',
              'aria-labelledby': titleId,
            },
          }}
        >
          {body}
        </Drawer>
      ) : (
        <Popover
          open={open}
          anchorEl={anchor}
          onClose={close}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          slotProps={{ paper: { role: 'dialog', 'aria-labelledby': titleId } }}
        >
          {body}
        </Popover>
      )}
    </>
  );
}

/** A row of numbered chips for one statement's evidence ids. */
export function EvidenceChips({ ids }: { ids: readonly string[] }) {
  if (ids.length === 0) return null;
  return (
    <Box component="span" sx={{ display: 'inline-flex', gap: 0.5, flexWrap: 'wrap', verticalAlign: 'middle', ml: 0.5 }}>
      {ids.map((id, index) => (
        <EvidenceChip key={id} evidenceId={id} index={index + 1} />
      ))}
    </Box>
  );
}

export default EvidenceChip;
