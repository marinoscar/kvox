/**
 * "Waiting for review" — graph drafts nobody has looked at yet (#368, epic
 * #346; ontology.md §19). Without it a draft is discoverable only by opening
 * the note it came from.
 *
 * WHEN IT RENDERS: the page mounts it only for `graph:read`; it then asks
 * `GET /api/ai/config` whether connected knowledge is on, and only then
 * lists `GET /api/graph/proposals?status=draft&limit=5`. No drafts → nothing
 * at all (a heading over nothing is the one thing a Home section must never
 * be, `NeedsAttention`'s rule). A failed read → nothing either: Home never
 * shows a graph error (logged in development only).
 *
 * The list is refreshed every 60 s through `useVisiblePolling`, paused in a
 * hidden tab. An extraction draft opens its note's review sheet
 * (`/notes/:id?review=1`); a `resolution` proposal has no note, so its sheet
 * opens here on Home, addressed by `?review=<proposalId>` and cleared on close.
 *
 * NO BREAKPOINT READ: rows stack by `sx` alone, like every Home section
 * (`HomePage`'s header). The review sheet it opens reads `down('sm')` for
 * its own shape — the sheet's rule, not a Home gate — and mounts only while
 * open.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAiConfig } from '../../hooks/useAiConfig';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';
import { listProposals } from '../../services/graph';
import type { ProposalSummary } from '../../services/graph';
import { formatRelativeTime } from '../../utils/relativeTime';
import { ProposalReviewSheet } from '../graph/review/ProposalReviewSheet';

export const GRAPH_REVIEW_POLL_MS = 60_000;
export const GRAPH_REVIEW_LIMIT = 5;

function rowTitle(proposal: ProposalSummary): string {
  if (proposal.kind === 'resolution') return 'Possible duplicates in your graph';
  return proposal.noteTitle ?? 'Untitled note';
}

export function GraphReviewCard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isMounted = useIsMounted();
  const { config } = useAiConfig();
  const graphOn = config?.graphEnabled === true;

  const [drafts, setDrafts] = useState<ProposalSummary[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await listProposals({ status: 'draft', limit: GRAPH_REVIEW_LIMIT });
      if (!isMounted()) return;
      setDrafts(result.items);
      setMore(result.nextCursor !== null);
      setFailed(false);
    } catch (err) {
      if (!isMounted()) return;
      setFailed(true);
      if (import.meta.env.DEV) console.warn('Waiting for review: the drafts could not be read', err);
    }
  }, [isMounted]);

  useEffect(() => {
    if (graphOn) void load();
  }, [graphOn, load]);
  useVisiblePolling(() => void load(), graphOn ? GRAPH_REVIEW_POLL_MS : 0);

  const sheetProposalId = searchParams.get('review');
  const closeSheet = () => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('review');
        return next;
      },
      { replace: true },
    );
    void load();
  };

  const sheet =
    graphOn && sheetProposalId ? (
      <ProposalReviewSheet open onClose={closeSheet} source={{ proposalId: sheetProposalId }} />
    ) : null;

  if (!graphOn || failed) return sheet;

  if (drafts === null) {
    return (
      <Box sx={{ mb: { xs: 3, sm: 4 } }}>
        <Skeleton variant="text" width={220} height={32} aria-label="Loading drafts waiting for review" />
      </Box>
    );
  }

  if (drafts.length === 0) return sheet;

  const open = (proposal: ProposalSummary) => {
    if (proposal.kind !== 'resolution' && proposal.noteId) {
      navigate(`/notes/${proposal.noteId}?review=1`);
      return;
    }
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('review', proposal.id);
        return next;
      },
      { replace: false },
    );
  };

  return (
    <Box component="section" aria-labelledby="home-graph-review" sx={{ mb: { xs: 3, sm: 4 } }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', flexWrap: 'wrap', mb: 1.5 }}>
        <Typography id="home-graph-review" variant="h6" component="h2" sx={{ fontWeight: 600 }}>
          Waiting for review
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {`${drafts.length}${more ? '+' : ''} ${drafts.length === 1 && !more ? 'draft' : 'drafts'}`}
        </Typography>
      </Stack>

      <Stack component="ul" spacing={1.5} sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {drafts.map((proposal) => {
          const title = rowTitle(proposal);
          return (
            <Card key={proposal.id} variant="outlined" component="li" sx={{ listStyle: 'none' }}>
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: { xs: 'column', sm: 'row' },
                  alignItems: { xs: 'stretch', sm: 'center' },
                  gap: { xs: 1, sm: 2 },
                  p: 1.75,
                  minWidth: 0,
                }}
              >
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" component="h3" noWrap sx={{ fontWeight: 600 }}>
                    {title}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="p">
                    {`${proposal.counts.pending} to review · ${formatRelativeTime(proposal.createdAt)}`}
                  </Typography>
                </Box>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => open(proposal)}
                  aria-label={`Review ${title}`}
                  sx={{ minHeight: 44, flexShrink: 0 }}
                >
                  Review
                </Button>
              </Box>
            </Card>
          );
        })}
      </Stack>
      {sheet}
    </Box>
  );
}

export default GraphReviewCard;
