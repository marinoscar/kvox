/**
 * One group of the Review Queue (#721): a library, an import batch, or the
 * notes imported outside any batch. Its counts, the "Accept & commit safe
 * rows" button with the confirmation that summarises what will happen, and an
 * expandable table of its drafts, each linking to its note and to the
 * existing per-proposal review (the note page's review sheet, `?review=1`).
 *
 * The commit itself is the page's (one at a time, so its outcome survives the
 * group disappearing from the refreshed queue); this card only asks for it.
 *
 * No breakpoint read: the header stacks by `sx`, and the table scrolls inside
 * its own container on a phone rather than widening the page.
 */

import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useId, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { useKvoxHost } from '../../../../core/headless/index.js';
import type { CommitBatchTarget, ReviewQueueGroup } from '../../../headless/clients/reviewQueue.js';
import { countPhrase, reviewGroupLabel } from '../../../headless/utils/reviewQueue.js';
import { visuallyHidden } from '../../visuallyHidden.js';

/**
 * The batch-commit target of a group: its library, its batch, or (for the
 * notes outside any batch) its non-stale proposals. `null` when nothing in it
 * can be committed.
 *
 * @param group - The group.
 * @returns The target, or `null`.
 *
 * @stability experimental
 */
export function reviewGroupTarget(group: ReviewQueueGroup): CommitBatchTarget | null {
  if (group.key.type === 'library' && group.key.id) return { libraryId: group.key.id };
  if (group.key.type === 'batch' && group.key.id) return { batchId: group.key.id };
  const ids = group.proposals.filter((p) => !p.stale).map((p) => p.proposalId);
  return ids.length > 0 ? { proposalIds: ids } : null;
}

/**
 * Props of {@link ReviewQueueGroupCard}.
 *
 * @stability experimental
 */
export interface ReviewQueueGroupCardProps {
  /** The group. */
  group: ReviewQueueGroup;
  /** The viewer holds `graph:write`: the commit button is drawn. */
  canCommit: boolean;
  /** This group's commit is running. */
  running: boolean;
  /** Another commit is running: the button is disabled. */
  busy: boolean;
  /** The proposal table starts open (the group the page was focused on). */
  defaultExpanded?: boolean;
  /** Asks the page to commit the group's safe rows. */
  onCommit: (group: ReviewQueueGroup, target: CommitBatchTarget) => void;
}

/**
 * One group of the Review Queue with its batch commit and its drafts.
 *
 * @param props - See {@link ReviewQueueGroupCardProps}.
 * @returns The card.
 *
 * @stability experimental
 */
export function ReviewQueueGroupCard(props: ReviewQueueGroupCardProps) {
  const { group, canCommit, running, busy, defaultExpanded = false, onCommit } = props;
  const host = useKvoxHost();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [confirming, setConfirming] = useState(false);
  const headingId = useId();
  const tableId = useId();

  const label = reviewGroupLabel(group.key);
  const { totals } = group;
  const committable = totals.proposals - totals.stale;
  const target = reviewGroupTarget(group);
  const canPress = target !== null && totals.safe > 0 && committable > 0;

  const counts = [
    countPhrase(totals.proposals, 'draft', 'drafts'),
    countPhrase(totals.safe, 'safe row', 'safe rows'),
    `${totals.waiting.toLocaleString()} need you`,
    ...(totals.stale > 0 ? [`${totals.stale.toLocaleString()} stale`] : []),
  ].join(' · ');

  return (
    <Paper component="section" variant="outlined" aria-labelledby={headingId} sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'center' },
          gap: { xs: 1, sm: 2 },
        }}
      >
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Typography id={headingId} variant="h6" component="h2" noWrap sx={{ fontWeight: 600 }}>
              {label}
            </Typography>
            {group.key.type !== 'other' && (
              <Chip size="small" variant="outlined" label={group.key.type === 'library' ? 'Library' : 'Import'} />
            )}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {counts}
          </Typography>
        </Box>
        {canCommit && (
          <Button
            variant="contained"
            disabled={!canPress || busy}
            onClick={() => setConfirming(true)}
            sx={{ minHeight: 44, flexShrink: 0 }}
            aria-label={`Accept & commit safe rows of ${label}`}
          >
            Accept &amp; commit safe rows
          </Button>
        )}
      </Box>

      {running && (
        <Box role="status" aria-live="polite" sx={{ mt: 1.5 }}>
          <LinearProgress aria-label={`Committing the safe rows of ${label}`} />
          <Typography variant="caption" color="text.secondary">
            Committing the safe rows of {countPhrase(committable, 'note', 'notes')}…
          </Typography>
        </Box>
      )}

      <Button
        size="small"
        onClick={() => setExpanded((open) => !open)}
        endIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        aria-expanded={expanded}
        aria-controls={tableId}
        sx={{ mt: 1 }}
      >
        {expanded ? 'Hide notes' : `Show ${countPhrase(group.proposals.length, 'note', 'notes')}`}
      </Button>

      <Collapse in={expanded} id={tableId} unmountOnExit>
        <TableContainer sx={{ mt: 1, overflowX: 'auto' }}>
          <Table size="small" aria-label={`Drafts of ${label}`}>
            <TableHead>
              <TableRow>
                <TableCell>Note</TableCell>
                <TableCell align="right">Version</TableCell>
                <TableCell align="right">Safe</TableCell>
                <TableCell align="right">Waiting</TableCell>
                <TableCell align="right">
                  <Box component="span" sx={visuallyHidden}>
                    Action
                  </Box>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {group.proposals.map((proposal) => {
                const title = proposal.noteTitle?.trim() || 'Untitled note';
                const notePath = proposal.noteId ? host.links.note(proposal.noteId) : null;
                return (
                  <TableRow key={proposal.proposalId}>
                    <TableCell sx={{ maxWidth: 320 }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
                        {notePath ? (
                          <Link component={RouterLink} to={notePath} noWrap>
                            {title}
                          </Link>
                        ) : (
                          <Typography variant="body2" noWrap>
                            {title}
                          </Typography>
                        )}
                        {proposal.stale && (
                          <Chip
                            size="small"
                            color="warning"
                            label="Stale"
                            title="The note changed after it was read; a batch commit skips it."
                          />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">{proposal.noteVersion ?? '—'}</TableCell>
                    <TableCell align="right">{proposal.counts.safe.toLocaleString()}</TableCell>
                    <TableCell align="right">{proposal.counts.waiting.toLocaleString()}</TableCell>
                    <TableCell align="right">
                      {notePath && (
                        <Button
                          size="small"
                          component={RouterLink}
                          to={`${notePath}?review=1`}
                          aria-label={`Review ${title}`}
                        >
                          Review
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Collapse>

      <Dialog open={confirming} onClose={() => setConfirming(false)} aria-labelledby={`${headingId}-confirm`}>
        <DialogTitle id={`${headingId}-confirm`}>Accept &amp; commit safe rows?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            <Typography variant="body1" component="p" sx={{ mb: 1 }}>
              {`${label}: ${countPhrase(totals.safe, 'safe row', 'safe rows')} across ${countPhrase(committable, 'note', 'notes')} will be accepted, and each note is committed to your graph on its own.`}
            </Typography>
            <Typography variant="body2" component="p">
              {`${countPhrase(totals.waiting, 'row stays', 'rows stay')} here for you to review.`}
              {totals.stale > 0 ? ` ${countPhrase(totals.stale, 'stale note is', 'stale notes are')} skipped.` : ''}
            </Typography>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              setConfirming(false);
              if (target) onCommit(group, target);
            }}
          >
            Accept &amp; commit
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
