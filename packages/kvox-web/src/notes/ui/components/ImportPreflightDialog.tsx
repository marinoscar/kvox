/**
 * The "this is what the import will do" dialog of a pick or a drop (issue #813, epic #811):
 * how many files of each type will be imported, their total size, what is skipped and
 * why (grouped, collapsible, virtualized when long), and a line about graph extraction,
 * with "Import N files" and Cancel. Nothing is uploaded before the person says so.
 *
 * While ZIP archives are unpacked it shows their progress instead, with Cancel.
 * A manifest over the batch cap shows the refusal and no import button.
 */

import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';

import { useKvoxHost, useKvoxPermissionCheck } from '../../../core/headless/index.js';
import { NOTE_IMPORT_DEFAULT_MAX_BYTES, NOTE_IMPORT_KINDS } from '../../headless/index.js';
import type {
  NoteImportKind,
  NoteImportManifest,
  NoteImportManifestRejection,
  NoteImportPrepareProgress,
  NoteImportRejectionReason,
} from '../../headless/index.js';
import { formatImportBytes, pluralize } from '../library/format.js';
import { noteImportRejectionHeading, noteImportRejectionText } from '../library/useAdHocNoteImport.js';

/**
 * Props of {@link ImportPreflightDialog}.
 *
 * @stability experimental
 */
export interface ImportPreflightDialogProps {
  /** Shown while `true`. */
  open: boolean;
  /** The files are being prepared (archives unpacked). */
  isPreparing?: boolean;
  /** Where the unpacking stands. */
  preparing?: NoteImportPrepareProgress | null;
  /** What the import would do. */
  manifest: NoteImportManifest | null;
  /** The largest file accepted, for the "too large" sentences. Default 25 MiB. */
  maxBytes?: number;
  /**
   * Whether graph extraction runs on its own for this person. `undefined`: unknown, a
   * general line is shown.
   */
  autoExtract?: boolean;
  /**
   * Show the graph extraction line. Default: when the graph is on for this deployment and
   * the viewer may read it.
   */
  showExtractionNotice?: boolean;
  /** Start the import. */
  onConfirm: () => void;
  /** Stop: nothing is uploaded (and the unpacking stops). */
  onCancel: () => void;
}

const KIND_LABEL: Readonly<Record<NoteImportKind, string>> = {
  pdf: 'PDF',
  docx: 'Word',
  pptx: 'PowerPoint',
  md: 'Markdown',
  txt: 'Text',
};

/** Rows above this many in one group are virtualized. */
const VIRTUALIZE_OVER = 100;
const ROW_HEIGHT = 40;

function SkippedRows({ rows, maxBytes }: { rows: readonly NoteImportManifestRejection[]; maxBytes: number }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualize = rows.length > VIRTUALIZE_OVER;
  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const line = (row: NoteImportManifestRejection) => (
    <>
      <Typography variant="body2" noWrap title={row.path} sx={{ fontWeight: 500 }}>
        {row.path}
      </Typography>
      <Typography variant="caption" color="text.secondary" noWrap component="p">
        {noteImportRejectionText(row.reason, row.size, maxBytes)}
      </Typography>
    </>
  );

  if (!virtualize) {
    return (
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, maxHeight: 240, overflowY: 'auto' }}>
        {rows.map((row, at) => (
          <Box component="li" key={`${row.path}-${at}`} sx={{ py: 0.5, minWidth: 0 }}>
            {line(row)}
          </Box>
        ))}
      </Box>
    );
  }
  return (
    <Box ref={scrollRef} sx={{ height: 240, overflowY: 'auto' }} data-testid="preflight-skipped-scroll">
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, position: 'relative', height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtual) => {
          const row = rows[virtual.index]!;
          return (
            <Box
              component="li"
              key={virtual.key}
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
                transform: `translateY(${virtual.start}px)`,
                minWidth: 0,
              }}
            >
              {line(row)}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/**
 * The skipped files grouped by reason, largest group first.
 *
 * @param rejected - The skipped files.
 * @returns The groups.
 *
 * @stability experimental
 */
export function groupImportRejections(
  rejected: readonly NoteImportManifestRejection[],
): Array<{ reason: NoteImportRejectionReason; rows: NoteImportManifestRejection[] }> {
  const groups = new Map<NoteImportRejectionReason, NoteImportManifestRejection[]>();
  for (const row of rejected) {
    const list = groups.get(row.reason) ?? [];
    list.push(row);
    groups.set(row.reason, list);
  }
  return Array.from(groups, ([reason, rows]) => ({ reason, rows })).sort((a, b) => b.rows.length - a.rows.length);
}

/**
 * Asks before an ad-hoc import uploads anything.
 *
 * @param props - See {@link ImportPreflightDialogProps}.
 * @returns The dialog.
 *
 * @stability experimental
 */
export function ImportPreflightDialog({
  open,
  isPreparing = false,
  preparing = null,
  manifest,
  maxBytes = NOTE_IMPORT_DEFAULT_MAX_BYTES,
  autoExtract,
  showExtractionNotice,
  onConfirm,
  onCancel,
}: ImportPreflightDialogProps) {
  const host = useKvoxHost();
  const hasPermission = useKvoxPermissionCheck();
  const groups = useMemo(() => groupImportRejections(manifest?.rejected ?? []), [manifest]);
  const graphOn = showExtractionNotice ?? (host.features().graphEnabled !== false && hasPermission('graph:read'));
  const count = manifest?.accepted.length ?? 0;
  const preparingPercent =
    preparing && preparing.totalBytes > 0 ? Math.round((preparing.bytesRead / preparing.totalBytes) * 100) : null;

  return (
    <Dialog
      open={open && (isPreparing || manifest !== null)}
      onClose={onCancel}
      aria-labelledby="import-preflight-title"
      maxWidth="sm"
      fullWidth
      // Near the full width of a phone without a media query (see the app's breakpoint-gate guard).
      slotProps={{ paper: { sx: { m: { xs: 1, sm: 4 }, width: { xs: 'calc(100% - 16px)', sm: undefined } } } }}
    >
      <DialogTitle id="import-preflight-title">{isPreparing ? 'Reading your files' : 'Import these files?'}</DialogTitle>
      <DialogContent>
        {isPreparing ? (
          <Box role="status" aria-live="polite">
            <Typography sx={{ mb: 1 }}>
              {preparing
                ? `Unpacking ${preparing.archive}${preparing.archiveCount > 1 ? ` (${preparing.archiveIndex} of ${preparing.archiveCount})` : ''}…`
                : 'Checking the files…'}
            </Typography>
            <LinearProgress
              aria-label="Unpacking"
              {...(preparingPercent !== null ? { variant: 'determinate' as const, value: preparingPercent } : {})}
            />
          </Box>
        ) : manifest ? (
          <>
            <Typography id="import-preflight-summary" variant="h6" component="p" sx={{ mb: 1 }}>
              {pluralize(count, 'file')} · {formatImportBytes(manifest.totalBytes)}
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mb: 2 }} aria-label="Files by type">
              {NOTE_IMPORT_KINDS.filter((kind) => manifest.counts[kind] > 0).map((kind) => (
                <Chip
                  key={kind}
                  size="small"
                  variant="outlined"
                  label={`${KIND_LABEL[kind]} ${manifest.counts[kind].toLocaleString()}`}
                />
              ))}
            </Stack>

            {manifest.refusal && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {manifest.refusal.message}
              </Alert>
            )}

            {groups.length > 0 && (
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" component="h3" sx={{ mb: 0.5 }}>
                  {pluralize(manifest.rejected.length, 'file')} skipped
                </Typography>
                {groups.map(({ reason, rows }) => (
                  <Accordion key={reason} disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: true } }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Typography variant="body2">
                        {noteImportRejectionHeading(reason)} ({rows.length.toLocaleString()})
                      </Typography>
                    </AccordionSummary>
                    <AccordionDetails sx={{ pt: 0 }}>
                      <SkippedRows rows={rows} maxBytes={maxBytes} />
                    </AccordionDetails>
                  </Accordion>
                ))}
              </Box>
            )}

            {graphOn && !manifest.refusal && (
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start', color: 'text.secondary' }}>
                <InfoOutlinedIcon fontSize="small" sx={{ mt: '2px' }} aria-hidden="true" />
                <Typography variant="body2" component="p">
                  {autoExtract === false
                    ? 'Knowledge extraction is off for you. The notes are imported; you can extract from them later.'
                    : 'After import, knowledge is extracted from each note at low priority, on your own AI key. Results wait for you in the Review Queue.'}
                </Typography>
              </Stack>
            )}
          </>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        {!isPreparing && manifest && !manifest.refusal && (
          <Button variant="contained" onClick={onConfirm} autoFocus disabled={count === 0}>
            {`Import ${pluralize(count, 'file')}`}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
