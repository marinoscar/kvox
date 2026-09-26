/**
 * `EntityMentionsList` — the notes and transcripts that mention this entity
 * (#373 over #370's additive mentions route). A source the caller can no
 * longer open (deleted, or a revoked share) stays in the list, disabled, as
 * "No longer available" — it is still true that it was mentioned there.
 */

import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import GraphicEqOutlinedIcon from '@mui/icons-material/GraphicEqOutlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import { useGraphMentions } from '../../hooks/useGraphMentions';
import type { EntityMention } from '../../services/graph';

function mentionHref(mention: EntityMention): string {
  return mention.kind === 'note'
    ? `/notes/${encodeURIComponent(mention.id)}`
    : `/transcripts/${encodeURIComponent(mention.id)}`;
}

function formatDay(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? undefined
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

export function EntityMentionsList({ entityId }: { entityId: string }) {
  const mentions = useGraphMentions(entityId);

  return (
    <Box component="section" aria-labelledby="entity-mentions-title" sx={{ mb: 3 }}>
      <Typography id="entity-mentions-title" variant="h6" component="h2" sx={{ fontWeight: 600, mb: 1 }}>
        Mentions
      </Typography>
      {mentions.isLoading ? (
        <Box aria-busy="true" aria-label="Loading mentions" role="status">
          <Skeleton width="60%" />
          <Skeleton width="40%" />
        </Box>
      ) : mentions.error && mentions.data.length === 0 ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void mentions.refresh()}>
              Retry
            </Button>
          }
        >
          {mentions.error}
        </Alert>
      ) : mentions.data.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Not mentioned anywhere yet.
        </Typography>
      ) : (
        <>
          <List dense disablePadding aria-label="Mentions">
            {mentions.data.map((mention) => {
              const icon =
                mention.kind === 'note' ? <DescriptionOutlinedIcon /> : <GraphicEqOutlinedIcon />;
              const kind = mention.kind === 'note' ? 'Note' : 'Transcript';
              const date = formatDay(mention.occurredAt);
              if (!mention.available) {
                return (
                  <ListItem key={`${mention.kind}-${mention.id}`} disablePadding>
                    <ListItemButton disabled aria-disabled="true">
                      <ListItemIcon>{icon}</ListItemIcon>
                      <ListItemText
                        primary="No longer available"
                        secondary={[kind, date].filter(Boolean).join(' · ')}
                      />
                    </ListItemButton>
                  </ListItem>
                );
              }
              return (
                <ListItem key={`${mention.kind}-${mention.id}`} disablePadding>
                  <ListItemButton component={RouterLink} to={mentionHref(mention)}>
                    <ListItemIcon>{icon}</ListItemIcon>
                    <ListItemText
                      primary={mention.title ?? `Untitled ${kind.toLowerCase()}`}
                      secondary={[kind, date].filter(Boolean).join(' · ')}
                    />
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
          {mentions.nextCursor && (
            <Button
              variant="outlined"
              sx={{ mt: 1 }}
              onClick={() => void mentions.loadMore()}
              disabled={mentions.isLoadingMore}
            >
              {mentions.isLoadingMore ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </>
      )}
    </Box>
  );
}

export default EntityMentionsList;
