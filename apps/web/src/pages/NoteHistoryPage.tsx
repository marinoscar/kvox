/**
 * `/notes/:id/history` — every save, newest first. Issue #57, epic #45.
 *
 * ⚠ SCOPE, STATED PLAINLY. Issue #58 owns this surface: reading one version in
 * full, comparing it with another, restoring it. What #57 needs from it is that
 * the ROUTE exists and works — the note page links here, `destinations.ts` owns
 * the path through its `/notes` prefix, and `AppBar`'s drill-down table titles
 * it — and a route that renders a placeholder is a route nobody can tell is
 * wired up.
 *
 * So this is the real list, over the real endpoint, with the real pagination:
 * `GET /api/notes/{id}/versions` is cursor-paginated and this renders what it
 * returns. It is DELIBERATELY not a stub and deliberately not more than a list
 * — what is missing (the body of a version, the restore) is missing because
 * #58 is where it is designed, not because this was left half-built.
 *
 * ⚠ `author: null` MEANS THE AI. It is a statement, not a missing value — v1 of
 * every note is the provider's own output — so it is rendered as "AI" rather
 * than as "Unknown" or as an empty cell. Getting this wrong would attribute the
 * model's work to nobody, on the one screen whose entire job is saying who
 * wrote what.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { useIsMounted } from '../hooks/useIsMounted';
import { ApiError } from '../services/api';
import { getNoteVersions } from '../services/notes';
import type { NoteVersion } from '../services/notes';
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

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress aria-label="Loading the version history" />
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <Typography variant="h5" component="h1" sx={{ mb: 2 }}>
        Version history
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {!error && versions.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">
            Nothing has been saved for this note yet.
          </Typography>
        </Paper>
      ) : (
        <Paper variant="outlined">
          <List>
            {versions.map((version) => (
              <ListItem key={version.version} divider>
                <ListItemText
                  primary={
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <Typography component="span" variant="body2" sx={{ fontWeight: 600 }}>
                        Version {version.version}
                      </Typography>
                      <Chip size="small" label={KIND_LABELS[version.kind]} />
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
              </ListItem>
            ))}
          </List>
        </Paper>
      )}

      {nextCursor && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button onClick={() => void load(nextCursor)} disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </Box>
      )}
    </Box>
  );
}

export default NoteHistoryPage;
