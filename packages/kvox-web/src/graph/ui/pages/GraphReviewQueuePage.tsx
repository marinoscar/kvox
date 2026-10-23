/**
 * `/graph/review-queue` — the Review Queue (#721, epic #708; API #717).
 *
 * WHY IT EXISTS. A person who bulk-imports a notes folder gets one draft
 * extraction proposal per note: hundreds of drafts. Reviewing each in its
 * note's sheet is the careful path and stays available; this page is the fast
 * one. Drafts are grouped by library and import batch, each group shows how
 * many rows the SAFE POLICY would accept and how many need a person, and one
 * button per group accepts the safe rows and commits each note on its own.
 *
 * WHAT "SAFE" MEANS is the server's (`commit-batch`, policy `safe`): it never
 * accepts a sensitive person fact, a closing, a merge, an ambiguous match, a
 * row below the caller's `graph.review.minConfidence`, a flagged row, a row
 * whose other end still waits, or any row of a stale proposal. The page only
 * explains it ("What is safe?") and never decides anything itself.
 *
 * GATES. The route is `graph:read` (`GET /api/graph/review-queue`); the commit
 * button is drawn only for `graph:write` (`POST …/commit-batch`). The API
 * enforces both; the browser only hides the control.
 *
 * FOCUS. `?libraryId=` or `?batchId=` shows that group alone, opened, with a
 * "Show all" link: the Libraries pages link here after an import.
 *
 * ONE COMMIT AT A TIME. The outcome is held by the page, not the group card,
 * because a fully committed group disappears from the refreshed queue and its
 * summary must not disappear with it.
 *
 * No breakpoint read: every responsive choice is a `sx` object.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Popover from '@mui/material/Popover';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useCallback, useId, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';

import { useHasPermission } from '../../../core/headless/index.js';
import type { CommitBatchTarget, ReviewQueueGroup } from '../../headless/clients/reviewQueue.js';
import { REVIEW_QUEUE_MAX_PROPOSALS } from '../../headless/clients/reviewQueue.js';
import { useCommitBatch, useReviewQueue } from '../../headless/hooks/useReviewQueue.js';
import {
  SAFE_POLICY_WAIT_REASON_ORDER,
  countPhrase,
  reviewGroupLabel,
  waitReasonCopy,
} from '../../headless/utils/reviewQueue.js';
import type { CommitBatchSummary } from '../../headless/utils/reviewQueue.js';
import { ReviewQueueGroupCard } from '../components/review/ReviewQueueGroupCard.js';

const SKELETON_GROUPS = 3;

function groupKey(group: ReviewQueueGroup): string {
  return `${group.key.type}:${group.key.id ?? 'other'}`;
}

/**
 * The `/graph/review-queue` page: drafts grouped by library and import, with a
 * safe-policy batch commit per group.
 *
 * @returns The page.
 *
 * @stability experimental
 */
export function GraphReviewQueuePage() {
  const [searchParams] = useSearchParams();
  const canWrite = useHasPermission('graph:write');
  const queue = useReviewQueue();
  const refreshQueue = queue.refresh;
  const onCommitted = useCallback(() => void refreshQueue(), [refreshQueue]);
  const batch = useCommitBatch({ onCommitted });
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const [outcomeLabel, setOutcomeLabel] = useState<string | null>(null);
  const [outcomeTitles, setOutcomeTitles] = useState<ReadonlyMap<string, string>>(new Map());

  const focusLibrary = searchParams.get('libraryId');
  const focusBatch = searchParams.get('batchId');
  const focused = focusLibrary !== null || focusBatch !== null;

  const allGroups = queue.queue?.groups ?? [];
  const groups = focused
    ? allGroups.filter((group) =>
        focusLibrary !== null
          ? group.key.type === 'library' && group.key.id === focusLibrary
          : group.key.type === 'batch' && group.key.id === focusBatch,
      )
    : allGroups;

  const commit = (group: ReviewQueueGroup, target: CommitBatchTarget) => {
    const key = groupKey(group);
    setRunningKey(key);
    setOutcomeLabel(reviewGroupLabel(group.key));
    setOutcomeTitles(new Map(group.proposals.map((p) => [p.proposalId, p.noteTitle?.trim() || 'Untitled note'])));
    void batch.commit(target).finally(() => setRunningKey(null));
  };

  const totals = queue.queue?.totals;

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto', py: { xs: 2, sm: 3 }, minWidth: 0 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ alignItems: { xs: 'flex-start', sm: 'baseline' }, justifyContent: 'space-between', mb: 1 }}
      >
        <Typography variant="h5" component="h1" sx={{ fontWeight: 600 }}>
          Review Queue
        </Typography>
        <Button size="small" component={RouterLink} to="/graph/review">
          Review one by one
        </Button>
      </Stack>

      {totals && totals.proposals > 0 && (
        <Typography variant="subtitle1" component="p" sx={{ fontWeight: 500 }}>
          {[
            countPhrase(totals.proposals, 'draft', 'drafts'),
            countPhrase(totals.safe, 'safe row', 'safe rows'),
            `${totals.waiting.toLocaleString()} need you`,
          ].join(' · ')}
        </Typography>
      )}

      <SafePolicyLine minConfidence={queue.queue?.minConfidence} canEditSettings={canWrite} />

      {batch.state !== 'idle' && batch.state !== 'running' && (
        <CommitOutcome
          label={outcomeLabel}
          titles={outcomeTitles}
          summary={batch.summary}
          error={batch.error}
          onDismiss={batch.reset}
        />
      )}

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

      {queue.queue?.truncated && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {`Showing the first ${REVIEW_QUEUE_MAX_PROPOSALS.toLocaleString()} drafts. Commit or review some to see the rest.`}
        </Alert>
      )}

      {focused && queue.queue && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" component={RouterLink} to="/graph/review-queue">
              Show all
            </Button>
          }
        >
          {groups.length > 0
            ? `Showing ${focusLibrary !== null ? 'one library' : 'one import'}.`
            : `Nothing from this ${focusLibrary !== null ? 'library' : 'import'} is waiting for review.`}
        </Alert>
      )}

      {queue.isLoading && !queue.queue ? (
        <Stack spacing={2} role="status" aria-label="Loading the review queue" aria-busy="true">
          {Array.from({ length: SKELETON_GROUPS }, (_, i) => (
            <Skeleton key={i} variant="rounded" height={96} />
          ))}
        </Stack>
      ) : queue.queue && allGroups.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="body1" component="p" sx={{ fontWeight: 500 }}>
            Nothing to review — your graph is up to date
          </Typography>
          <Typography variant="body2" color="text.secondary" component="p" sx={{ mb: 1.5 }}>
            When you import notes, what the AI finds in them waits here.
          </Typography>
          <Button variant="outlined" component={RouterLink} to="/notes/libraries">
            Go to Libraries
          </Button>
        </Paper>
      ) : (
        <Stack spacing={2}>
          {groups.map((group) => {
            const key = groupKey(group);
            return (
              <ReviewQueueGroupCard
                key={key}
                group={group}
                canCommit={canWrite}
                running={runningKey === key}
                busy={runningKey !== null}
                defaultExpanded={focused}
                onCommit={commit}
              />
            );
          })}
        </Stack>
      )}
    </Box>
  );
}

/** The one-line explanation of the safe policy and its "What is safe?" popover. */
function SafePolicyLine({ minConfidence, canEditSettings }: { minConfidence: number | undefined; canEditSettings: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const popoverId = useId();
  const titleId = useId();
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" color="text.secondary" component="p">
        &quot;Accept &amp; commit safe rows&quot; accepts only what needs no judgement and commits each note on its own.
        Everything else stays here for you.{' '}
        <Link
          component="button"
          type="button"
          variant="body2"
          onClick={(event) => setAnchor(event.currentTarget)}
          aria-haspopup="dialog"
          aria-controls={anchor ? popoverId : undefined}
          aria-expanded={anchor !== null}
          sx={{ verticalAlign: 'baseline' }}
        >
          What is safe?
        </Link>
      </Typography>
      <Popover
        id={popoverId}
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { role: 'dialog', 'aria-labelledby': titleId, sx: { maxWidth: 420, p: 2 } } }}
      >
        <Typography id={titleId} variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
          What is safe?
        </Typography>
        <Typography variant="body2" component="p">
          A row is safe when the AI is confident and nothing about it needs your judgement. These always wait for you:
        </Typography>
        <List dense disablePadding aria-label="Why a row waits for you">
          {SAFE_POLICY_WAIT_REASON_ORDER.map((reason) => {
            const copy = waitReasonCopy(reason, minConfidence);
            return (
              <ListItem key={reason} disableGutters>
                <ListItemText primary={copy.title} secondary={copy.body} />
              </ListItem>
            );
          })}
        </List>
        <Typography variant="body2" component="p" color="text.secondary">
          A note that changed after it was read is stale and is never committed in a batch.
        </Typography>
        {canEditSettings && (
          <Link component={RouterLink} to="/settings/knowledge-graph" variant="body2">
            Change your minimum confidence
          </Link>
        )}
      </Popover>
    </Box>
  );
}

/** What the last batch commit did. */
function CommitOutcome({
  label,
  titles,
  summary,
  error,
  onDismiss,
}: {
  label: string | null;
  titles: ReadonlyMap<string, string>;
  summary: CommitBatchSummary | null;
  error: string | null;
  onDismiss: () => void;
}) {
  if (error || !summary) {
    return (
      <Alert severity="error" sx={{ mb: 2 }} onClose={onDismiss}>
        {error ?? 'Could not commit the safe rows'}
      </Alert>
    );
  }
  const severity = summary.failures.length > 0 ? 'warning' : 'success';
  const parts = [
    `Committed ${countPhrase(summary.committed, 'note', 'notes')}`,
    `${countPhrase(summary.waiting, 'row', 'rows')} waiting for you`,
    ...(summary.stale > 0 ? [`${summary.stale.toLocaleString()} skipped (stale)`] : []),
    ...(summary.skipped > 0 ? [`${summary.skipped.toLocaleString()} skipped`] : []),
    ...(summary.failures.length > 0 ? [`${summary.failures.length.toLocaleString()} failed`] : []),
  ];
  return (
    <Alert severity={severity} sx={{ mb: 2 }} onClose={onDismiss} role="status">
      {label && <AlertTitle>{label}</AlertTitle>}
      <Typography variant="body2" component="p">
        {`${parts.join(' · ')}.`}
      </Typography>
      {summary.remainders > 0 && (
        <Typography variant="body2" component="p">
          {`The rows waiting for you are in ${countPhrase(summary.remainders, 'new draft', 'new drafts')} in this queue.`}
        </Typography>
      )}
      {summary.failures.length > 0 && (
        <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }} aria-label="Failed notes">
          {summary.failures.map((failure) => (
            <li key={failure.proposalId}>
              <Typography variant="body2">
                {`${titles.get(failure.proposalId) ?? 'A note'}: ${failure.message}`}
              </Typography>
            </li>
          ))}
        </Box>
      )}
    </Alert>
  );
}
