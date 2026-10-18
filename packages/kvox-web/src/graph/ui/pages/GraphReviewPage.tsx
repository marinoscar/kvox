/**
 * `/graph/review` — what is waiting for review (spec §8, §19.5).
 *
 * Every DRAFT proposal of the caller, newest first, a page at a time
 * (`useGraphReviewQueue`: `GET /api/graph/proposals?status=draft`, "Load
 * more" while there is a next cursor). Each row is ONE LINK whose accessible
 * name starts with the source's title:
 *
 *   - a note extraction → the note page with its review sheet open
 *     (`host.links.note(noteId)` + `?review=1`), named after the note;
 *   - an import → `/graph/imports/:id`, named after the uploaded file.
 *
 * The secondary line counts the rows still undecided and in total. Nothing
 * waiting is the empty state "Nothing to review". A `resolution` proposal has
 * no review page of its own, so it is not listed.
 *
 * Owned by the `knowledge` destination (its `/graph` prefix). Gated on
 * `graph:read` like the other read routes; the pages it links to gate the
 * writes.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import type { KvoxLinks } from '../../../core/headless/index.js';
import { useKvoxHost } from '../../../core/headless/index.js';
import { importStatsOf } from '../../headless/clients/graph.js';
import type { ProposalSummary } from '../../headless/clients/graph.js';
import { useGraphReviewQueue } from '../../headless/hooks/useGraphReviewQueue.js';

const SKELETON_ROWS = 4;

/**
 * Where a waiting proposal is reviewed.
 *
 * @stability experimental
 */
export interface ReviewTarget {
  /** The path of the page that reviews it. */
  href: string;
  /** The source's title: the note's, or the imported file's name. */
  title: string;
}

/**
 * Where a waiting proposal is reviewed, and what it is called.
 *
 * @param proposal - A draft proposal.
 * @param links - The host's path builders.
 * @returns The review page's path and the source's title, or `null` for a proposal with no review page.
 *
 * @stability experimental
 */
export function reviewTarget(proposal: ProposalSummary, links: KvoxLinks): ReviewTarget | null {
  if (proposal.kind === 'import') {
    return {
      href: `/graph/imports/${encodeURIComponent(proposal.id)}`,
      title: importStatsOf(proposal).filename ?? 'Import',
    };
  }
  if (proposal.kind === 'extraction' && proposal.noteId) {
    return {
      href: `${links.note(proposal.noteId)}?review=1`,
      title: proposal.noteTitle?.trim() || 'Untitled note',
    };
  }
  return null;
}

function countsLine(proposal: ProposalSummary): string {
  const { pending, total } = proposal.counts;
  const items = `${total} ${total === 1 ? 'item' : 'items'}`;
  return pending > 0 && pending !== total ? `${pending} to decide · ${items}` : items;
}

/**
 * The `/graph/review` page: the proposals waiting for review.
 *
 * @returns The page.
 *
 * @stability experimental
 */
export function GraphReviewPage() {
  const host = useKvoxHost();
  const queue = useGraphReviewQueue();
  const rows = queue.items.flatMap((proposal) => {
    const target = reviewTarget(proposal, host.links);
    return target ? [{ proposal, ...target }] : [];
  });

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto', py: { xs: 2, sm: 3 }, minWidth: 0 }}>
      <Typography variant="h5" component="h1" sx={{ fontWeight: 600, mb: 2 }}>
        Review
      </Typography>

      {queue.error && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => void queue.refresh()}>
              Retry
            </Button>
          }
        >
          {queue.error}
        </Alert>
      )}

      {queue.isLoading ? (
        <Box role="status" aria-label="Loading what is waiting for review" aria-busy="true">
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <Skeleton key={i} height={56} />
          ))}
        </Box>
      ) : rows.length === 0 && !queue.error ? (
        <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="body1">Nothing to review</Typography>
          <Typography variant="body2" color="text.secondary">
            What the AI finds in a note, and every graph you import, waits here until you send it to
            your graph.
          </Typography>
        </Paper>
      ) : (
        <>
          <List aria-label="Waiting for review" disablePadding>
            {rows.map(({ proposal, href, title }) => (
              <ListItem key={proposal.id} disablePadding divider>
                <ListItemButton component={RouterLink} to={href}>
                  <ListItemText
                    primary={title}
                    secondary={`${countsLine(proposal)} · ${new Date(
                      proposal.createdAt
                    ).toLocaleDateString(undefined, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}`}
                    slotProps={{ primary: { noWrap: true } }}
                  />
                  <Chip
                    size="small"
                    label={proposal.kind === 'import' ? 'Import' : 'Note'}
                    sx={{ ml: 1 }}
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
          {queue.hasMore && (
            <Box sx={{ mt: 2, textAlign: 'center' }}>
              <Button onClick={() => void queue.loadMore()} disabled={queue.isLoadingMore}>
                Load more
              </Button>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
