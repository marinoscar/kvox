/**
 * The body of the review sheet — one branch per state of #367's States table.
 *
 *   loading     first fetch — skeleton rows, `aria-busy`
 *   error       the fetch failed — Retry
 *   empty       nothing extracted from this note yet — Extract (graph:write)
 *   extracting  progress and the model; rows arrive when it settles
 *   failed      the recorded reason — Try again
 *   draft       groups of rows (+ a stale-version notice when the note moved on)
 *   committed   read-only rows, when they were sent, Revert… and Re-extract
 *   reverted / discarded — a notice and Re-extract
 *
 * (`disabled` — the deployment switched the graph off — never reaches here:
 * the entry button is not rendered and the sheet never opens.)
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useMemo } from 'react';

import type { BulkDecision, ProposalDetail } from '../../../services/graph';
import { formatRelativeTime } from '../../../utils/relativeTime';
import { ProposalGroup } from './ProposalGroup';
import type { ProposalRowHandlers } from './ProposalItemRow';
import { groupProposalItems } from './proposalGrouping';
import type { ProposalGroupView } from './proposalGrouping';

export type ReviewState =
  | 'loading'
  | 'error'
  | 'empty'
  | 'extracting'
  | 'failed'
  | 'draft'
  | 'committed'
  | 'reverted'
  | 'discarded';

export function reviewState(detail: ProposalDetail | null | undefined, loadError: string | null): ReviewState {
  if (detail === undefined) return loadError ? 'error' : 'loading';
  if (detail === null) return 'empty';
  return detail.proposal.status;
}

/** A draft extracted from an older version of the note than the current one. */
export function isStale(detail: ProposalDetail | null | undefined): boolean {
  const proposal = detail?.proposal;
  return (
    proposal?.status === 'draft' &&
    proposal.noteVersion !== null &&
    proposal.noteCurrentVersion !== null &&
    proposal.noteVersion < proposal.noteCurrentVersion
  );
}

export interface ProposalReviewContentProps {
  detail: ProposalDetail | null | undefined;
  loadError: string | null;
  canWrite: boolean;
  modelLabel: string | null;
  pendingItemIds: ReadonlySet<string>;
  onRetry: () => void;
  onRequestExtract: (mode: 'extract' | 're-extract') => void;
  onRevert: () => void;
  onBulk: (group: ProposalGroupView, itemIds: string[], decision: BulkDecision) => void;
  rowHandlers: ProposalRowHandlers;
}

export function ProposalReviewContent({
  detail,
  loadError,
  canWrite,
  modelLabel,
  pendingItemIds,
  onRetry,
  onRequestExtract,
  onRevert,
  onBulk,
  rowHandlers,
}: ProposalReviewContentProps) {
  const state = reviewState(detail, loadError);
  const items = useMemo(() => detail?.items ?? [], [detail?.items]);
  const groups = useMemo(() => groupProposalItems(items), [items]);
  const reextract = canWrite ? (
    <Button size="small" onClick={() => onRequestExtract('re-extract')}>
      Re-extract
    </Button>
  ) : null;

  const renderGroups = (readOnly: boolean) =>
    groups.length === 0 ? (
      <Typography variant="body2" color="text.secondary">
        The AI found nothing to add from this note.
      </Typography>
    ) : (
      groups.map((group) => (
        <ProposalGroup
          key={group.key}
          group={group}
          items={items}
          readOnly={readOnly}
          pendingItemIds={pendingItemIds}
          onBulk={onBulk}
          {...rowHandlers}
        />
      ))
    );

  switch (state) {
    case 'loading':
      return (
        <Box aria-busy="true" aria-label="Loading the graph proposal" role="status">
          <Skeleton variant="text" width="60%" />
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} variant="rounded" height={48} sx={{ my: 1 }} />
          ))}
        </Box>
      );
    case 'error':
      return (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={onRetry}>
              Retry
            </Button>
          }
        >
          {loadError}
        </Alert>
      );
    case 'empty':
      return (
        <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <Typography variant="body2">Nothing sent to your graph from this note yet.</Typography>
          {canWrite && (
            <Button variant="contained" size="small" onClick={() => onRequestExtract('extract')}>
              Extract
            </Button>
          )}
        </Stack>
      );
    case 'extracting':
      return (
        <Stack spacing={1}>
          <LinearProgress aria-label="Extracting" />
          <Typography variant="body2">Reading your note and transcript…</Typography>
          {(modelLabel ?? detail?.proposal.model) && (
            <Typography variant="caption" color="text.secondary">
              Using {modelLabel ?? detail?.proposal.model}. You can close this — the proposal will be
              waiting here.
            </Typography>
          )}
        </Stack>
      );
    case 'failed':
      return (
        <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <Alert severity="error" sx={{ width: '100%' }}>
            {detail?.proposal.failure?.message ?? 'The extraction did not finish.'}
          </Alert>
          {canWrite && (
            <Button size="small" onClick={() => onRequestExtract('re-extract')}>
              Try again
            </Button>
          )}
        </Stack>
      );
    case 'committed':
      return (
        <>
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 2 }}
          >
            <Typography variant="body2" sx={{ flexGrow: 1 }}>
              Sent to graph{' '}
              {detail?.proposal.committedAt ? formatRelativeTime(detail.proposal.committedAt).toLowerCase() : ''}
            </Typography>
            {canWrite && (
              <Button size="small" color="error" onClick={onRevert}>
                Revert…
              </Button>
            )}
            {reextract}
          </Stack>
          {renderGroups(true)}
        </>
      );
    case 'reverted':
    case 'discarded':
      return (
        <Alert severity="info" action={reextract ?? undefined}>
          {state === 'reverted'
            ? 'This proposal was reverted — what it added has been removed from your graph.'
            : 'This proposal was discarded. Nothing from it was sent to your graph.'}
        </Alert>
      );
    case 'draft':
    default:
      return (
        <>
          {isStale(detail) && (
            <Alert severity="info" sx={{ mb: 2 }} action={reextract ?? undefined}>
              Made from version {detail?.proposal.noteVersion}; the note is now version{' '}
              {detail?.proposal.noteCurrentVersion}.
            </Alert>
          )}
          {renderGroups(!canWrite)}
        </>
      );
  }
}

export default ProposalReviewContent;
