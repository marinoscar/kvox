/**
 * `/notes/:id/history` — every save, newest first, and a way back. Issues #57
 * and #58, epic #45.
 *
 * #57 landed the LIST over the real endpoint. #58 adds the two things that make
 * a history worth having: reading what a version actually contains, and going
 * back to it.
 *
 * =============================================================================
 * ⚠ `author: null` MEANS THE AI. IT IS A STATEMENT, NOT A MISSING VALUE.
 * =============================================================================
 *
 * Version 1 of every note is the provider's own output (`note.dto.ts`'s own
 * convention, carried across from `transcript_versions`), so a null author is
 * rendered as "AI" rather than as "Unknown" or an empty cell. Getting this
 * wrong would attribute the model's work to nobody, on the one screen whose
 * entire job is saying who wrote what.
 *
 * =============================================================================
 * ⚠ RESTORING DESTROYS NOTHING, AND THE PAGE HAS TO SAY SO
 * =============================================================================
 *
 * `POST /api/notes/{id}/versions/{v}/restore` APPENDS a new version whose body
 * is the old one's. Every version in between — including the one that was
 * current a second ago — stays exactly as it was, and version 1 is always
 * retrievable.
 *
 * A user who does not know that reads "Restore" as "throw away everything since"
 * and does not press it, which makes the version history decorative. So the
 * confirmation says it in words, the success message says it again naming the
 * new version number, and version 1 carries a visible "Original (AI)" label so
 * the thing a user is most afraid of losing is the thing most obviously still
 * there.
 *
 * `baseVersion` MUST EQUAL `currentVersion` on this route — unlike a `PATCH`,
 * which merely checks it — because a restore carries no per-entity expectations
 * of its own, so a stale view means asking to discard edits the caller has never
 * seen. A 409 here is therefore "someone saved while you were reading", and the
 * page says that and re-reads rather than offering a retry that would act on the
 * same stale number.
 *
 * =============================================================================
 * THE PREVIEW IS THE SAME RENDERER THE NOTE PAGE USES
 * =============================================================================
 *
 * `MarkdownView` — `react-markdown`, `remark-gfm`, no raw HTML. A history
 * preview drawn a second way would be a second answer to "what does this note
 * look like", and the whole point of reading a version is to see what it would
 * look like if restored.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import RestoreIcon from '@mui/icons-material/Restore';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';

import { MarkdownView } from '../components/notes/MarkdownView';
import { useIsMounted } from '../hooks/useIsMounted';
import { ApiError } from '../services/api';
import {
  getNoteVersion,
  getNoteVersions,
  noteConflictReason,
  restoreNoteVersion,
} from '../services/notes';
import type { NoteVersion, NoteVersionDetail } from '../services/notes';
import { formatRelativeTime } from '../utils/relativeTime';

/** The three `kind`s a version row can have, as words a reader recognises. */
const KIND_LABELS: Record<NoteVersion['kind'], string> = {
  ai_generated: 'Generated',
  edit: 'Edited',
  restore: 'Restored',
};

export function NoteHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const isMounted = useIsMounted();

  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<NoteVersionDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ from: number; to: number } | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      if (!id) return;
      if (cursor) setIsLoadingMore(true);
      try {
        const response = await getNoteVersions(id, cursor ? { cursor } : {});
        if (!isMounted()) return;
        // APPEND on a cursor, REPLACE on a first read — two different
        // operations, and sharing one setter between them is how a "load more"
        // starts truncating the list.
        setVersions((current) => (cursor ? [...current, ...response.items] : response.items));
        setCurrentVersion(response.currentVersion);
        setNextCursor(response.nextCursor);
        setError(null);
      } catch (err) {
        if (!isMounted()) return;
        setError(
          err instanceof ApiError && err.status === 404
            ? 'This note does not exist, or you no longer have access to it'
            : 'Failed to load this note’s history',
        );
      } finally {
        if (!isMounted()) return;
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [id, isMounted],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The selected version's body. A full stored snapshot, so this is one row
  // read — see `NoteVersionDetail`'s own note about why there is no replay.
  useEffect(() => {
    if (!id || selected === null) return;

    let cancelled = false;

    setIsDetailLoading(true);
    setDetailError(null);

    void (async () => {
      try {
        const next = await getNoteVersion(id, selected);
        if (!cancelled) setDetail(next);
      } catch (err) {
        if (cancelled) return;
        setDetail(null);
        setDetailError(
          err instanceof ApiError && err.status === 404
            ? 'That version is no longer available.'
            : 'That version could not be loaded.',
        );
      } finally {
        if (!cancelled) setIsDetailLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, selected]);

  const handleRestore = useCallback(async () => {
    if (!id || confirmRestore === null || currentVersion === null) return;

    setIsRestoring(true);
    setRestoreError(null);

    try {
      const note = await restoreNoteVersion(id, confirmRestore, currentVersion);

      if (!isMounted()) return;

      setRestored({ from: confirmRestore, to: note.currentVersion });
      setConfirmRestore(null);
      setSelected(null);
      setDetail(null);
      // Re-read from the top: the restore APPENDED a row, and the list has to
      // show it or the page would be claiming history is preserved while not
      // showing the proof.
      await load();
    } catch (err) {
      if (!isMounted()) return;

      setRestoreError(
        noteConflictReason(err) === 'stale_base_version'
          ? 'This note was saved again while you were reading. Nothing was restored — the history below has been refreshed, so try again from there.'
          : noteConflictReason(err) === 'already_current'
            ? 'That version is already the current one, so there is nothing to restore.'
            : err instanceof ApiError
              ? err.message
              : 'The restore did not happen.',
      );

      if (noteConflictReason(err) === 'stale_base_version') await load();
    } finally {
      if (isMounted()) setIsRestoring(false);
    }
  }, [confirmRestore, currentVersion, id, isMounted, load]);

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress aria-label="Loading the version history" />
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto' }}>
      <Typography variant="h5" component="h1" sx={{ mb: 1 }}>
        Version history
      </Typography>

      {/* THE PROMISE, STATED BEFORE ANY BUTTON IS PRESSED. See the header. */}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Every save is kept. Restoring an earlier version <strong>adds</strong> it as a new
        version — nothing in this list is ever deleted or overwritten.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {restored && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setRestored(null)}>
          Version {restored.from} is back, saved as version {restored.to}. Everything that was
          here before is still here —{' '}
          <RouterLink to={`/notes/${id ?? ''}`}>open the note</RouterLink>.
        </Alert>
      )}

      {restoreError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {restoreError}
        </Alert>
      )}

      {!error && versions.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">
            Nothing has been saved for this note yet.
          </Typography>
        </Paper>
      ) : (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: 'flex-start' }}>
          <Paper variant="outlined" sx={{ width: { xs: '100%', md: 360 }, flexShrink: 0 }}>
            <List aria-label="Versions, newest first">
              {versions.map((version) => (
                <ListItem key={version.version} divider disablePadding>
                  <ListItemButton
                    selected={selected === version.version}
                    onClick={() => setSelected(version.version)}
                    aria-label={`Read version ${version.version}`}
                  >
                    <ListItemText
                      primary={
                        <Stack
                          direction="row"
                          spacing={1}
                          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                        >
                          <Typography component="span" variant="body2" sx={{ fontWeight: 600 }}>
                            Version {version.version}
                          </Typography>
                          <Chip size="small" label={KIND_LABELS[version.kind]} />
                          {/* ⚠ VERSION 1 IS THE AI'S OWN OUTPUT, and is
                              labelled as such wherever it appears — it is the
                              one version no edit can ever remove. */}
                          {version.version === 1 && (
                            <Chip size="small" variant="outlined" label="Original (AI)" />
                          )}
                          {version.version === currentVersion && (
                            <Chip size="small" color="primary" label="Current" />
                          )}
                        </Stack>
                      }
                      secondary={
                        <>
                          {/* `author: null` IS the AI. See the file header. */}
                          {version.author ? version.author.name : 'AI'}
                          {' · '}
                          {formatRelativeTime(version.createdAt)}
                          {version.summary ? ` · ${version.summary}` : ''}
                          {version.restoredFromVersion !== null
                            ? ` · restored from version ${version.restoredFromVersion}`
                            : ''}
                        </>
                      }
                    />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>

            {nextCursor && (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 1.5 }}>
                <Button onClick={() => void load(nextCursor)} disabled={isLoadingMore}>
                  {isLoadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </Box>
            )}
          </Paper>

          <Paper
            variant="outlined"
            sx={{ flex: 1, minWidth: 0, p: { xs: 2, sm: 3 }, width: { xs: '100%', md: 'auto' } }}
            component="section"
            aria-label="Selected version"
          >
            {selected === null ? (
              <Typography color="text.secondary">
                Choose a version on the left to read exactly what it said.
              </Typography>
            ) : isDetailLoading ? (
              <Stack sx={{ py: 4, alignItems: 'center' }}>
                <CircularProgress aria-label="Loading that version" />
              </Stack>
            ) : detailError ? (
              <Alert severity="error">{detailError}</Alert>
            ) : detail ? (
              <>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1}
                  sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', mb: 2 }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle1" component="h2">
                      Version {detail.version}
                      {detail.version === 1 ? ' — the AI’s original' : ''}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {detail.author ? detail.author.name : 'AI'}
                      {' · '}
                      {formatRelativeTime(detail.createdAt)}
                    </Typography>
                  </Box>
                  {!detail.isCurrent && currentVersion !== null && (
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<RestoreIcon />}
                      onClick={() => setConfirmRestore(detail.version)}
                      sx={{ flexShrink: 0 }}
                    >
                      Restore this version
                    </Button>
                  )}
                </Stack>

                {detail.body.trim() ? (
                  <MarkdownView>{detail.body}</MarkdownView>
                ) : (
                  <Typography color="text.secondary">This version is empty.</Typography>
                )}
              </>
            ) : null}
          </Paper>
        </Stack>
      )}

      <Dialog
        open={confirmRestore !== null}
        onClose={isRestoring ? undefined : () => setConfirmRestore(null)}
        aria-labelledby="note-restore-title"
      >
        <DialogTitle id="note-restore-title">Restore version {confirmRestore}?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            <Typography variant="body2" component="p">
              The note goes back to what it said at version {confirmRestore}.
            </Typography>
            <Typography variant="body2" component="p" sx={{ mt: 1.5 }}>
              {/* THE REASSURANCE, in the place a person is deciding. */}
              <strong>Nothing is deleted.</strong> The restore is recorded as a new version,
              version {currentVersion ?? 0} stays exactly as it is, and you can come back
              here and restore any of them again.
            </Typography>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRestore(null)} disabled={isRestoring}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => void handleRestore()} disabled={isRestoring}>
            {isRestoring ? 'Restoring…' : 'Restore'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default NoteHistoryPage;
