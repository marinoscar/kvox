/**
 * The files of an import batch, one row each (issue #720): the path, what the import
 * does with it (new, changed, missing), where it stands in the pipeline, a link to the
 * note it made, a sentence for a failure, and a warning when the note was edited since
 * the last import. Paginated with "Show more"; the server pages by cursor.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import Skeleton from '@mui/material/Skeleton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import DescriptionIcon from '@mui/icons-material/Description';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import HubIcon from '@mui/icons-material/Hub';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import RateReviewIcon from '@mui/icons-material/RateReview';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import type { SvgIconComponent } from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';

import { useKvoxHost } from '../../../core/headless/index.js';
import { describeNoteImportFailure } from '../../headless/index.js';
import type { NoteImportBatchItem, NoteImportItemStage } from '../../headless/index.js';

/**
 * Props of {@link ImportBatchItemList}.
 *
 * @stability experimental
 */
export interface ImportBatchItemListProps {
  /** The rows loaded so far. */
  items: readonly NoteImportBatchItem[];
  /** The first page is loading. */
  isLoading: boolean;
  /** The last load's failure. */
  error?: string | null;
  /** More rows exist. */
  hasMore?: boolean;
  /** A further page is loading. */
  isLoadingMore?: boolean;
  /** Loads the next page. */
  onLoadMore?: () => void;
  /** What to say when there are no rows. */
  emptyText?: string;
  /** The accessible name of the list. */
  ariaLabel?: string;
}

interface StagePresentation {
  label: string;
  Icon: SvgIconComponent;
  color: 'action' | 'primary' | 'success' | 'warning' | 'error' | 'info';
}

const STAGES: Readonly<Record<NoteImportItemStage, StagePresentation>> = {
  uploaded: { label: 'Uploaded, waiting to be read', Icon: CloudDoneIcon, color: 'action' },
  parsed: { label: 'Imported as a note', Icon: DescriptionIcon, color: 'primary' },
  formatting: { label: 'Formatting the note', Icon: AutoAwesomeIcon, color: 'info' },
  indexed: { label: 'Imported and searchable', Icon: DescriptionIcon, color: 'primary' },
  extracting: { label: 'Extracting knowledge', Icon: AutoAwesomeIcon, color: 'info' },
  extracted: { label: 'Waiting for your review', Icon: RateReviewIcon, color: 'warning' },
  in_graph: { label: 'In the knowledge graph', Icon: HubIcon, color: 'success' },
  failed: { label: 'Failed', Icon: ErrorOutlineIcon, color: 'error' },
};

/**
 * The words for a stage.
 *
 * @param stage - The item's stage.
 * @returns The label.
 *
 * @stability experimental
 */
export function importStageLabel(stage: NoteImportItemStage): string {
  return STAGES[stage]?.label ?? 'Imported';
}

function presentationOf(item: NoteImportBatchItem): StagePresentation {
  if (item.status === 'missing') return { label: 'No longer in the folder', Icon: LinkOffIcon, color: 'warning' };
  if (item.status === 'skipped') return { label: 'Unchanged, skipped', Icon: SkipNextIcon, color: 'action' };
  if (item.status === 'queued' || item.status === 'importing') {
    return { label: item.status === 'importing' ? 'Importing' : 'Queued', Icon: CloudDoneIcon, color: 'action' };
  }
  return STAGES[item.stage] ?? STAGES.parsed;
}

const ACTION_LABEL: Readonly<Record<string, string>> = { new: 'New', changed: 'Changed', missing: 'Missing' };

/**
 * The files of an import batch.
 *
 * @param props - See {@link ImportBatchItemListProps}.
 * @returns The list.
 *
 * @stability experimental
 */
export function ImportBatchItemList({
  items,
  isLoading,
  error,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  emptyText = 'No files here.',
  ariaLabel = 'Imported files',
}: ImportBatchItemListProps) {
  const host = useKvoxHost();

  if (isLoading && items.length === 0) {
    return (
      <Box aria-busy="true" aria-label="Loading files">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} variant="rectangular" height={56} sx={{ mb: 1, borderRadius: 1 }} />
        ))}
      </Box>
    );
  }

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {items.length === 0 && !error ? (
        <Typography color="text.secondary" sx={{ py: 2 }}>
          {emptyText}
        </Typography>
      ) : (
        <List aria-label={ariaLabel} disablePadding>
          {items.map((item) => {
            const { label, Icon, color } = presentationOf(item);
            const failure = item.status === 'failed' ? describeNoteImportFailure(item.failureReason ?? 'internal_error') : null;
            const path = item.path ?? item.filename;
            return (
              <ListItem
                key={item.id}
                divider
                alignItems="flex-start"
                sx={{ px: { xs: 0.5, sm: 1 }, py: 1.25, gap: 1 }}
              >
                <ListItemIcon sx={{ minWidth: 32, mt: 0.25 }}>
                  <Tooltip title={label}>
                    {item.stage === 'extracting' && item.status === 'imported' ? (
                      <CircularProgress size={20} aria-label={label} />
                    ) : (
                      <Icon color={color} aria-label={label} role="img" fontSize="small" />
                    )}
                  </Tooltip>
                </ListItemIcon>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    {item.noteId ? (
                      <Link
                        component={RouterLink}
                        to={host.links.note(item.noteId)}
                        sx={{ fontWeight: 500, wordBreak: 'break-word' }}
                      >
                        {path}
                      </Link>
                    ) : (
                      <Typography component="span" sx={{ fontWeight: 500, wordBreak: 'break-word' }}>
                        {path}
                      </Typography>
                    )}
                    <Chip size="small" variant="outlined" label={ACTION_LABEL[item.action] ?? item.action} />
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    {label}
                  </Typography>
                  {failure && (
                    <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
                      {failure}
                    </Typography>
                  )}
                  {item.diverged && (
                    <Alert severity="warning" variant="outlined" sx={{ mt: 0.75, py: 0 }}>
                      You edited this note after it was imported, and the file has changed too. The file’s text is
                      now the latest version; your edit is kept as an earlier one.
                      {item.noteId && (
                        <>
                          {' '}
                          <Link component={RouterLink} to={`${host.links.note(item.noteId)}/history`}>
                            Compare versions
                          </Link>
                        </>
                      )}
                    </Alert>
                  )}
                </Box>
              </ListItem>
            );
          })}
        </List>
      )}
      {hasMore && onLoadMore && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.5 }}>
          <Button onClick={onLoadMore} disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading…' : 'Show more'}
          </Button>
        </Box>
      )}
    </Box>
  );
}
