/**
 * The files of an import batch, built for hundreds of rows (issue #814, epic #811): a
 * virtualized list (`@tanstack/react-virtual`) in a fixed-height scroll box, one 48 px
 * row per file with its path (folder dimmed), type, size, stage, error and actions (open
 * the note, review its proposal, retry an upload). On a phone each file is a small card
 * instead of a row of columns.
 *
 * The rows come in ready-made (`buildImportBatchRows`, then filtered and sorted by the
 * page): this component only draws them.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RateReviewIcon from '@mui/icons-material/RateReview';
import ReplayIcon from '@mui/icons-material/Replay';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { useKvoxHost } from '../../../core/headless/index.js';
import { formatImportBytes } from '../library/format.js';
import type { ImportBatchRow } from '../library/importBatchRows.js';

/**
 * Props of {@link ImportBatchItemTable}.
 *
 * @stability experimental
 */
export interface ImportBatchItemTableProps {
  /** The rows, filtered and sorted. */
  rows: readonly ImportBatchRow[];
  /** The first load is in flight. */
  isLoading: boolean;
  /** The last load's failure. */
  error?: string | null;
  /** What to say when there are no rows. */
  emptyText?: string;
  /** The accessible name of the list. */
  ariaLabel?: string;
  /** Shows a "Review" action on files whose proposal waits for review. */
  canReview?: boolean;
  /** Retries one failed upload; absent hides the action. */
  onRetryUpload?: (path: string) => void;
  /** The scroll box's height in pixels. Default 480. */
  height?: number;
}

/** A row's height on a wide screen. */
export const IMPORT_BATCH_ROW_HEIGHT = 48;
/** A card's height on a phone. */
const CARD_HEIGHT = 92;

const KIND_LABEL: Readonly<Record<string, string>> = {
  pdf: 'PDF',
  docx: 'Word',
  pptx: 'PowerPoint',
  md: 'Markdown',
  txt: 'Text',
};

const COLUMNS = 'minmax(0, 3fr) 88px 72px minmax(0, 1.6fr) minmax(0, 2fr) 76px';

function PathText({ row, to }: { row: ImportBatchRow; to: string | null }) {
  const body = (
    <>
      {row.folder && (
        <Box component="span" sx={{ color: 'text.secondary' }}>
          {row.folder}
        </Box>
      )}
      {row.name}
    </>
  );
  const sx = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 } as const;
  return to ? (
    <Link component={RouterLink} to={to} title={row.path} sx={sx}>
      {body}
    </Link>
  ) : (
    <Typography component="span" variant="body2" title={row.path} sx={sx}>
      {body}
    </Typography>
  );
}

function Actions({
  row,
  noteTo,
  reviewTo,
  onRetryUpload,
}: {
  row: ImportBatchRow;
  noteTo: string | null;
  reviewTo: string | null;
  onRetryUpload: ((path: string) => void) | undefined;
}) {
  const out: ReactNode[] = [];
  if (noteTo) {
    out.push(
      <Tooltip key="note" title="Open note">
        <IconButton size="small" component={RouterLink} to={noteTo} aria-label={`Open note ${row.name}`}>
          <OpenInNewIcon fontSize="small" />
        </IconButton>
      </Tooltip>,
    );
  }
  if (reviewTo) {
    out.push(
      <Tooltip key="review" title="Review">
        <IconButton size="small" component={RouterLink} to={reviewTo} aria-label={`Review ${row.name}`}>
          <RateReviewIcon fontSize="small" />
        </IconButton>
      </Tooltip>,
    );
  }
  if (onRetryUpload && row.upload?.state === 'failed' && !row.item) {
    out.push(
      <Tooltip key="retry" title="Retry upload">
        <IconButton size="small" onClick={() => onRetryUpload(row.path)} aria-label={`Retry upload ${row.name}`}>
          <ReplayIcon fontSize="small" />
        </IconButton>
      </Tooltip>,
    );
  }
  return <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>{out}</Box>;
}

/**
 * The files of an import batch, virtualized.
 *
 * @param props - See {@link ImportBatchItemTableProps}.
 * @returns The list.
 *
 * @stability experimental
 */
export function ImportBatchItemTable({
  rows,
  isLoading,
  error,
  emptyText = 'No files here.',
  ariaLabel = 'Imported files',
  canReview = false,
  onRetryUpload,
  height = 480,
}: ImportBatchItemTableProps) {
  const host = useKvoxHost();
  const theme = useTheme();
  // Card rows on a phone. A layout read inside this component, not a shell gate.
  const compact = useMediaQuery(theme.breakpoints.down('sm'));
  const rowHeight = compact ? CARD_HEIGHT : IMPORT_BATCH_ROW_HEIGHT;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    getItemKey: (index) => rows[index]?.key ?? index,
    // A first paint before the box is measured (and a render without layout) still shows rows.
    initialRect: { width: 960, height },
  });

  if (isLoading && rows.length === 0) {
    return (
      <Box aria-busy="true" aria-label="Loading files">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} variant="rectangular" height={IMPORT_BATCH_ROW_HEIGHT} sx={{ mb: 1, borderRadius: 1 }} />
        ))}
      </Box>
    );
  }

  const linksFor = (row: ImportBatchRow) => {
    const noteId = row.item?.noteId ?? null;
    const noteTo = noteId ? host.links.note(noteId) : null;
    const waiting = row.item?.proposalId && (row.item.proposalStatus === 'draft' || row.item.stage === 'extracted');
    const reviewTo = canReview && noteId && waiting ? `${host.links.note(noteId)}?review=1` : null;
    return { noteTo, reviewTo };
  };

  const stageChip = (row: ImportBatchRow) => (
    <Chip
      size="small"
      label={row.stageLabel}
      color={row.tone}
      variant={row.tone === 'default' ? 'outlined' : 'filled'}
      sx={{ maxWidth: '100%' }}
    />
  );

  const renderRow = (row: ImportBatchRow, index: number) => {
    const { noteTo, reviewTo } = linksFor(row);
    const kind = row.kind ? KIND_LABEL[row.kind] : '';
    const size = row.size !== null ? formatImportBytes(row.size) : '';
    if (compact) {
      return (
        <Box
          role="listitem"
          sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, py: 1, px: 0.5, height: '100%', borderBottom: 1, borderColor: 'divider', minWidth: 0 }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <PathText row={row} to={noteTo} />
            </Box>
            <Actions row={row} noteTo={null} reviewTo={reviewTo} onRetryUpload={onRetryUpload} />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            {stageChip(row)}
            <Typography variant="caption" color="text.secondary" noWrap>
              {[kind, size].filter(Boolean).join(' · ')}
            </Typography>
          </Box>
          {row.error && (
            <Typography variant="caption" color="error" noWrap title={row.error}>
              {row.error}
            </Typography>
          )}
        </Box>
      );
    }
    return (
      <Box
        role="row"
        aria-rowindex={index + 2}
        sx={{
          display: 'grid',
          gridTemplateColumns: COLUMNS,
          alignItems: 'center',
          columnGap: 1.5,
          px: 1,
          height: '100%',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box role="cell" sx={{ minWidth: 0 }}>
          <PathText row={row} to={noteTo} />
        </Box>
        <Typography role="cell" variant="body2" color="text.secondary" noWrap>
          {kind}
        </Typography>
        <Typography role="cell" variant="body2" color="text.secondary" noWrap>
          {size}
        </Typography>
        <Box role="cell" sx={{ minWidth: 0 }}>
          {stageChip(row)}
        </Box>
        <Typography role="cell" variant="body2" color="error" noWrap title={row.error ?? undefined}>
          {row.error ?? ''}
        </Typography>
        <Box role="cell">
          <Actions row={row} noteTo={noteTo} reviewTo={reviewTo} onRetryUpload={onRetryUpload} />
        </Box>
      </Box>
    );
  };

  const boxHeight = Math.min(height, Math.max(rowHeight, rows.length * rowHeight));
  // Without layout (a hidden tab, a test DOM) the scroll box measures 0 and the virtualizer
  // yields nothing: draw the first screenful instead of an empty list.
  const measured = virtualizer.getVirtualItems();
  const visible =
    measured.length > 0 || rows.length === 0
      ? measured
      : rows.slice(0, Math.ceil(height / rowHeight)).map((row, index) => ({
          key: row.key,
          index,
          start: index * rowHeight,
        }));

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {rows.length === 0 && !error ? (
        <Typography color="text.secondary" sx={{ py: 2 }}>
          {emptyText}
        </Typography>
      ) : (
        <Box
          role={compact ? 'list' : 'table'}
          aria-label={ariaLabel}
          aria-rowcount={compact ? undefined : rows.length + 1}
          sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}
        >
          {!compact && (
            <Box
              role="row"
              aria-rowindex={1}
              sx={{
                display: 'grid',
                gridTemplateColumns: COLUMNS,
                columnGap: 1.5,
                px: 1,
                py: 0.75,
                borderBottom: 1,
                borderColor: 'divider',
                bgcolor: 'action.hover',
              }}
            >
              {['File', 'Type', 'Size', 'Stage', 'Error', ''].map((label, at) => (
                <Typography key={at} role="columnheader" variant="caption" sx={{ fontWeight: 600 }} noWrap>
                  {label || <Box component="span" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Actions</Box>}
                </Typography>
              ))}
            </Box>
          )}
          <Box ref={scrollRef} data-testid="import-batch-scroll" sx={{ height: boxHeight, overflowY: 'auto', position: 'relative' }}>
            <Box role={compact ? undefined : 'rowgroup'} sx={{ position: 'relative', height: virtualizer.getTotalSize() }}>
              {visible.map((virtual) => {
                const row = rows[virtual.index];
                if (!row) return null;
                return (
                  <Box
                    key={virtual.key}
                    data-index={virtual.index}
                    sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: rowHeight, transform: `translateY(${virtual.start}px)` }}
                  >
                    {renderRow(row, virtual.index)}
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}
