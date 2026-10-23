/**
 * The "this is what a rescan will do" dialog (issue #720): how many files are new,
 * changed and missing, how much will be uploaded, and roughly how many tokens an AI
 * extraction would read, with Start and Cancel. Nothing is uploaded before Start.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';

import type { LibrarySyncPlan } from '../../headless/index.js';
import { formatImportBytes, formatTokenEstimate, pluralize } from '../library/format.js';

/**
 * Props of {@link ScanConfirmDialog}.
 *
 * @stability experimental
 */
export interface ScanConfirmDialogProps {
  /** Shown while `true` and a plan is given. */
  open: boolean;
  /** What the scan found. */
  plan: LibrarySyncPlan | null;
  /** The library's name, for the title. */
  libraryName?: string;
  /** Whether the library extracts graph proposals automatically: the token line reads differently. */
  autoExtract?: boolean;
  /** Start uploading. */
  onConfirm: () => void;
  /** Stop: nothing is uploaded. */
  onCancel: () => void;
}

/**
 * The summary line: `42 new, 3 changed, 1 missing`.
 *
 * @param plan - What the scan found.
 * @returns The line.
 *
 * @stability experimental
 */
export function scanPlanSummary(plan: LibrarySyncPlan): string {
  const parts = [`${plan.newCount.toLocaleString()} new`, `${plan.changedCount.toLocaleString()} changed`];
  if (plan.missingCount > 0) parts.push(`${plan.missingCount.toLocaleString()} missing`);
  return parts.join(', ');
}

/**
 * Asks before a library sync uploads anything.
 *
 * @param props - See {@link ScanConfirmDialogProps}.
 * @returns The dialog.
 *
 * @stability experimental
 */
export function ScanConfirmDialog({
  open,
  plan,
  libraryName,
  autoExtract,
  onConfirm,
  onCancel,
}: ScanConfirmDialogProps) {
  if (!plan) return null;
  const { estimate } = plan;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      aria-labelledby="scan-confirm-title"
      aria-describedby="scan-confirm-summary"
      maxWidth="xs"
      fullWidth
      // Near the full width of a phone without a media query (see the app's breakpoint-gate guard).
      slotProps={{ paper: { sx: { m: { xs: 1, sm: 4 }, width: { xs: 'calc(100% - 16px)', sm: undefined } } } }}
    >
      <DialogTitle id="scan-confirm-title">
        {libraryName ? `Import from “${libraryName}”?` : 'Import these notes?'}
      </DialogTitle>
      <DialogContent>
        <Typography id="scan-confirm-summary" variant="h6" component="p" sx={{ mb: 1 }}>
          {scanPlanSummary(plan)}
        </Typography>
        <DialogContentText component="div">
          <Box component="ul" sx={{ pl: 2.5, my: 0 }}>
            <li>
              About {pluralize(estimate.files, 'file')} to upload, {formatImportBytes(estimate.bytes)} in all.
            </li>
            <li>
              {autoExtract === false
                ? `Extracting knowledge from them later would read about ${formatTokenEstimate(estimate.approxInputTokens)} tokens with your AI key.`
                : `~${formatTokenEstimate(estimate.approxInputTokens)} tokens of AI extraction, on your own AI key.`}
            </li>
            {plan.unchangedCount > 0 && <li>{pluralize(plan.unchangedCount, 'file')} unchanged, skipped.</li>}
            {plan.missingCount > 0 && (
              <li>
                {pluralize(plan.missingCount, 'file')} no longer in the folder. Their notes are kept and marked
                as missing.
              </li>
            )}
          </Box>
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" onClick={onConfirm} autoFocus>
          Start import
        </Button>
      </DialogActions>
    </Dialog>
  );
}
