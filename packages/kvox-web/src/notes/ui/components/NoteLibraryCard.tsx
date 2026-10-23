/**
 * One note library as a card (issue #720): its name, the folder it is bound to on
 * this device, its file counts, when it was last scanned, its extraction policy, and
 * Rescan / Open. A sync in flight draws its progress inline.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActions from '@mui/material/CardActions';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import FolderIcon from '@mui/icons-material/Folder';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import SyncIcon from '@mui/icons-material/Sync';
import { Link as RouterLink } from 'react-router-dom';

import { formatRelativeTime } from '../../../core/headless/index.js';
import type { KvoxFolderRef } from '../../../core/headless/index.js';
import type { LibrarySyncProgress, NoteLibrary } from '../../headless/index.js';
import { describeSyncProgress, syncProgressPercent } from '../library/format.js';

/**
 * Props of {@link NoteLibraryCard}.
 *
 * @stability experimental
 */
export interface NoteLibraryCardProps {
  /** The library. */
  library: NoteLibrary;
  /** Its folder on this device: `null` when not bound, `undefined` while looking it up. */
  folder: KvoxFolderRef | null | undefined;
  /** The folder must be picked again for every scan (no persistent folder access). */
  repickEachScan: boolean;
  /** The viewer may change the library (`notes:write`). */
  canWrite: boolean;
  /** The progress of this library's sync in flight, if any. */
  progress: LibrarySyncProgress | null;
  /** Another library's sync is in flight: this card's actions wait. */
  busyElsewhere: boolean;
  /** A failure of this library's last sync. */
  error?: string | null;
  /** A link to the import the last sync started. */
  lastBatchId?: string | null;
  /** Rescan the folder. */
  onRescan: () => void;
  /** Bind the library to a folder on this device. */
  onConnect: () => void;
  /** Stop the sync in flight. */
  onStop: () => void;
}

/**
 * The library's link.
 *
 * @param id - The library.
 * @returns `/notes/libraries/:id`.
 *
 * @stability experimental
 */
export function noteLibraryPath(id: string): string {
  return `/notes/libraries/${encodeURIComponent(id)}`;
}

/**
 * A note library card.
 *
 * @param props - See {@link NoteLibraryCardProps}.
 * @returns The card.
 *
 * @stability experimental
 */
export function NoteLibraryCard({
  library,
  folder,
  repickEachScan,
  canWrite,
  progress,
  busyElsewhere,
  error,
  lastBatchId,
  onRescan,
  onConnect,
  onStop,
}: NoteLibraryCardProps) {
  const syncing = progress !== null;
  const { counts } = library;
  const titleId = `library-${library.id}-title`;
  const percent = progress ? syncProgressPercent(progress) : undefined;

  return (
    <Card variant="outlined" component="article" aria-labelledby={titleId}>
      <CardContent sx={{ pb: 1 }}>
        <Typography id={titleId} variant="h6" component="h2" sx={{ wordBreak: 'break-word' }}>
          <Link component={RouterLink} to={noteLibraryPath(library.id)} underline="hover" color="inherit">
            {library.name}
          </Link>
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: 'text.secondary', mt: 0.5 }}>
          {folder ? <FolderIcon fontSize="small" aria-hidden /> : <LinkOffIcon fontSize="small" aria-hidden />}
          <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
            {folder === undefined
              ? 'Looking for the folder…'
              : folder
                ? folder.name
                : repickEachScan
                  ? 'Pick the folder again to rescan (this browser forgets folders on reload)'
                  : 'Folder not connected on this device'}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1.5 }} aria-label="Files">
          <Chip size="small" label={`${counts.imported.toLocaleString()} imported`} />
          {counts.pending > 0 && <Chip size="small" label={`${counts.pending.toLocaleString()} pending`} />}
          {counts.failed > 0 && <Chip size="small" color="error" variant="outlined" label={`${counts.failed.toLocaleString()} failed`} />}
          {counts.missing > 0 && <Chip size="small" color="warning" variant="outlined" label={`${counts.missing.toLocaleString()} missing`} />}
          {counts.diverged > 0 && <Chip size="small" color="warning" variant="outlined" label={`${counts.diverged.toLocaleString()} diverged`} />}
          {counts.unsupported > 0 && <Chip size="small" variant="outlined" label={`${counts.unsupported.toLocaleString()} unsupported`} />}
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mt: 1.5 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mr: 'auto' }}>
            {library.lastScanAt ? `Last scanned ${formatRelativeTime(library.lastScanAt)}` : 'Never scanned'}
          </Typography>
          {library.autoExtract && <Chip size="small" color="primary" variant="outlined" label="Auto-extract" />}
          {library.autoCommit && <Chip size="small" color="secondary" variant="outlined" label="Auto-commit" />}
        </Box>
        {progress && (
          <Box sx={{ mt: 1.5 }} role="status" aria-live="polite">
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              {describeSyncProgress(progress)}
            </Typography>
            <LinearProgress
              variant={percent === undefined ? 'indeterminate' : 'determinate'}
              {...(percent === undefined ? {} : { value: percent })}
              aria-label={`Syncing ${library.name}`}
            />
          </Box>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {error}
          </Alert>
        )}
        {!syncing && lastBatchId && (
          <Typography variant="body2" sx={{ mt: 1 }}>
            <Link component={RouterLink} to={`/notes/import-batches/${encodeURIComponent(lastBatchId)}`}>
              View the last import
            </Link>
          </Typography>
        )}
      </CardContent>
      <CardActions sx={{ px: 2, pb: 1.5, flexWrap: 'wrap', gap: 1 }}>
        {canWrite &&
          (syncing ? (
            <Button size="small" onClick={onStop}>
              Stop
            </Button>
          ) : folder === null && !repickEachScan ? (
            <Button size="small" variant="contained" onClick={onConnect} disabled={busyElsewhere}>
              Connect folder
            </Button>
          ) : (
            <Button
              size="small"
              variant="contained"
              startIcon={<SyncIcon />}
              onClick={onRescan}
              disabled={busyElsewhere || folder === undefined}
              aria-label={`Rescan ${library.name}`}
            >
              Rescan
            </Button>
          ))}
        <Button size="small" component={RouterLink} to={noteLibraryPath(library.id)} aria-label={`Open ${library.name}`}>
          Open
        </Button>
      </CardActions>
    </Card>
  );
}
