/**
 * The inspector's Evidence tab (GIC-11, #672): the quotes behind the selected
 * node or edge, twenty at a time.
 *
 * What it asks about is decided by the model (`evidenceSubject`): a person
 * fact is never asked about, so for one this tab says so and sends nothing.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';

import type { EvidenceFeedSubject } from '../../../../headless/hooks/useGraphEvidenceFeed.js';
import { useGraphEvidenceFeed } from '../../../../headless/hooks/useGraphEvidenceFeed.js';
import { EvidenceCard } from './EvidenceCard.js';

/** Said instead of listing evidence for a personal fact. */
export const PERSON_FACT_EVIDENCE_COPY = 'Evidence for personal facts is not shown on the canvas.';

/**
 * Props of {@link EvidenceTab}.
 *
 * @stability experimental
 */
export interface EvidenceTabProps {
  /** What to list evidence for; `null` when the selection may not be asked about. */
  subject: EvidenceFeedSubject | null;
  /** Clamp quotes to two lines (the roomy panes). */
  clampQuote: boolean;
  /** A coarse pointer. */
  touch: boolean;
}

/**
 * The quotes behind the selection as cards, with "Show more evidence" for the next twenty.
 *
 * @stability experimental
 */
export function EvidenceTab({ subject, clampQuote, touch }: EvidenceTabProps) {
  const feed = useGraphEvidenceFeed(subject);
  if (!subject) {
    return (
      <Typography variant="body2" color="text.secondary">
        {PERSON_FACT_EVIDENCE_COPY}
      </Typography>
    );
  }
  if (feed.isLoading) {
    return (
      <Box aria-busy sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Skeleton variant="rounded" height={88} />
        <Skeleton variant="rounded" height={88} />
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {feed.error && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={feed.retry}>
              Retry
            </Button>
          }
        >
          {feed.error}
        </Alert>
      )}
      {!feed.error && feed.items.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          No quotes are recorded for this yet.
        </Typography>
      )}
      {feed.items.length > 0 && (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {feed.items.map((link) => (
            <li key={link.id}>
              <EvidenceCard link={link} clampQuote={clampQuote} touch={touch} />
            </li>
          ))}
        </Box>
      )}
      {feed.hasMore && (
        <Button
          onClick={feed.showMore}
          disabled={feed.isLoadingMore}
          startIcon={feed.isLoadingMore ? <CircularProgress size={14} /> : undefined}
          sx={{ alignSelf: 'flex-start', minHeight: touch ? 44 : undefined }}
        >
          Show more evidence
        </Button>
      )}
    </Box>
  );
}
