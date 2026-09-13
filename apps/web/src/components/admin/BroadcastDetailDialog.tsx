/**
 * One broadcast, read-only (issue #325, epic #319).
 *
 * WHY A DIALOG AND NOT A COLUMN. The body is up to 2,000 characters of
 * paragraphed prose. A table cell can hold a truncated line of it and a tooltip
 * can hold a little more, but neither can show an operator the thing they
 * actually came to check — what was said, on which channels, to how many
 * people, and whether it landed. So the list stays scannable and this is where
 * a row opens.
 *
 * READ-ONLY, WITH NO EDIT PATH, and that is a property of the feature rather
 * than a shortcut. Content is frozen at compose time to match the
 * `notifications` table's own render-at-write-time contract: rows already
 * dispatched carry the old text forever, so "editing" a half-sent broadcast
 * would produce one announcement that said two different things. Cancel and
 * recreate expresses the same intent without racing the fan-out, and both of
 * those actions live on the row, not here.
 */

import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { BroadcastDetail } from '../../services/broadcasts';
import {
  STATUS_CHIP_COLOR,
  channelLabel,
  formatDateTime,
  formatProgress,
  isCriticalBroadcast,
} from '../../pages/Admin/broadcastsTable';

interface BroadcastDetailDialogProps {
  open: boolean;
  /** `null` while the detail read is in flight, or when it failed. */
  broadcast: BroadcastDetail | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
}

/** One label/value row of the summary grid. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ minWidth: 180, flexGrow: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Box sx={{ mt: 0.25 }}>{children}</Box>
    </Box>
  );
}

export function BroadcastDetailDialog({
  open,
  broadcast,
  isLoading,
  error,
  onClose,
}: BroadcastDetailDialogProps) {
  const theme = useTheme();
  // The same `down('sm')` compact-window read `SettingsHub.tsx` and `AppBar.tsx`
  // use — one of the five coupled breakpoint gates CLAUDE.md rule 5 names. A
  // dialog holding 2,000 characters of body text is a full screen on a phone or
  // it is a scroll trap.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      fullScreen={isCompactWindow}
      aria-labelledby="broadcast-detail-title"
    >
      <DialogTitle id="broadcast-detail-title">Broadcast</DialogTitle>
      <DialogContent dividers>
        {isLoading && (
          <Stack sx={{ py: 4, alignItems: 'center' }}>
            <CircularProgress size={28} />
          </Stack>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {broadcast && (
          <Stack spacing={3}>
            <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Field label="Status">
                <Chip
                  label={broadcast.status}
                  size="small"
                  color={STATUS_CHIP_COLOR[broadcast.status]}
                />
              </Field>
              <Field label="Importance">
                <Typography variant="body2">
                  {isCriticalBroadcast(broadcast) ? 'Cannot be muted' : 'Normal'}
                </Typography>
              </Field>
              <Field label="Channels">
                <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {broadcast.channels.map((channel) => (
                    <Chip
                      key={channel}
                      label={channelLabel(channel)}
                      size="small"
                      variant="outlined"
                    />
                  ))}
                </Stack>
              </Field>
              <Field label="Progress">
                <Typography variant="body2">{formatProgress(broadcast)}</Typography>
              </Field>
            </Stack>

            <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Field label="Scheduled for">
                <Typography variant="body2">
                  {broadcast.scheduledFor
                    ? formatDateTime(broadcast.scheduledFor)
                    : 'Immediately'}
                </Typography>
              </Field>
              <Field label="Started">
                <Typography variant="body2">{formatDateTime(broadcast.startedAt)}</Typography>
              </Field>
              <Field label="Finished">
                <Typography variant="body2">{formatDateTime(broadcast.finishedAt)}</Typography>
              </Field>
              <Field label="Canceled">
                <Typography variant="body2">{formatDateTime(broadcast.canceledAt)}</Typography>
              </Field>
              <Field label="Audience frozen at">
                {/* The instant membership stopped moving. Without it, "who got
                    this?" has no answer that survives a user being created or
                    deactivated an hour later. */}
                <Typography variant="body2">
                  {formatDateTime(broadcast.audienceCutoff)}
                </Typography>
              </Field>
              <Field label="Event key">
                <Typography variant="body2">{broadcast.eventKey}</Typography>
              </Field>
            </Stack>

            <Divider />

            {/* ---------------------------------------------------------------
                THE COMPOSED CONTENT — what recipients were actually sent.
                Rendered as plain TEXT, never as markup: the body is escaped by
                every channel on the way out, so HTML typed into the composer
                reached recipients as literal characters, and it must read the
                same here.
                ------------------------------------------------------------ */}
            <Box>
              <Typography variant="overline" color="text.secondary">
                Content
              </Typography>
              <Typography variant="h6" sx={{ mt: 0.5 }}>
                {broadcast.title}
              </Typography>
              {broadcast.body.split(/\n{2,}/).map((paragraph, index) => (
                <Typography
                  // Index keys: paragraphs have no id and this list is static
                  // for the life of the dialog — the row is frozen content.
                  key={index}
                  variant="body2"
                  sx={{ mt: 1, whiteSpace: 'pre-wrap' }}
                >
                  {paragraph}
                </Typography>
              ))}
              {broadcast.link && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                  Call to action: {broadcast.ctaLabel ?? 'View'} → {broadcast.link}
                </Typography>
              )}
            </Box>

            {broadcast.lastError && (
              <Alert severity="error">
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                  {broadcast.lastError}
                </Typography>
              </Alert>
            )}

            <Divider />

            {/* ---------------------------------------------------------------
                THE DELIVERY BREAKDOWN — approximate, and labelled so nobody
                reads it as a receipt.
                ------------------------------------------------------------ */}
            <Box>
              <Typography variant="overline" color="text.secondary">
                Approximate delivery attempts
              </Typography>
              {/* The caveat is stated ABOVE the numbers rather than in a
                  footnote, because the numbers are the thing being caveated.
                  Delivery rows carry no broadcast id, so the API attributes them
                  by event key and time window: a second broadcast raised under
                  the same key during this one's send contributes to these
                  totals, and nothing can separate them. Calling this a delivery
                  report would make an operator treat a shortfall as evidence of
                  a bug. */}
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Counted from delivery records written while this broadcast was sending, matched
                by event key and time window — not per recipient. Another broadcast sent under
                the same event key during this window is counted here too. Treat these as an
                estimate, not a receipt.
              </Typography>

              {broadcast.approximateDeliveryAttempts.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                  Nothing recorded yet.
                </Typography>
              ) : (
                <Box sx={{ overflowX: 'auto', mt: 1 }}>
                  <Table size="small" aria-label="Approximate delivery attempts">
                    <TableHead>
                      <TableRow>
                        <TableCell>Channel</TableCell>
                        <TableCell>Outcome</TableCell>
                        <TableCell align="right">Records</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {broadcast.approximateDeliveryAttempts.map((entry) => (
                        <TableRow key={`${entry.channel}:${entry.status}`}>
                          <TableCell>{channelLabel(entry.channel)}</TableCell>
                          <TableCell>{entry.status}</TableCell>
                          <TableCell align="right">{entry.count}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              )}
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export default BroadcastDetailDialog;
