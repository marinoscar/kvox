/**
 * `EntityMergedFromList` — the entity page's "Merged from" section (#765): the
 * entities merged INTO this one that still stand merged, newest first, each
 * with Undo when the merge is still reversible and the viewer may write.
 *
 * Renders nothing when there is no standing merge: most entities have none,
 * and an empty heading would only add noise.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';

import type { EntityMergeRow } from '../../headless/clients/graph.js';

export interface EntityMergedFromListProps {
  merges: readonly EntityMergeRow[];
  /** The viewer holds `graph:write`. */
  canUndo: boolean;
  /** An undo is in flight: every Undo is disabled. */
  busy?: boolean;
  onUndo: (row: EntityMergeRow) => void;
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

export function EntityMergedFromList({ merges, canUndo, busy, onUndo }: EntityMergedFromListProps) {
  const standing = merges.filter((row) => row.reversedAt === null);
  if (standing.length === 0) return null;

  return (
    <Box component="section" aria-labelledby="entity-merged-from-title" sx={{ mb: 3 }}>
      <Typography id="entity-merged-from-title" variant="h6" component="h2" sx={{ fontWeight: 600, mb: 1 }}>
        Merged from
      </Typography>
      <List dense disablePadding aria-label="Merged from">
        {standing.map((row) => {
          const day = formatDay(row.createdAt);
          return (
            <ListItem
              key={row.mergeId}
              disableGutters
              secondaryAction={
                canUndo && row.reversible ? (
                  <Button
                    size="small"
                    onClick={() => onUndo(row)}
                    disabled={busy}
                    aria-label={`Undo merge of ${row.mergedEntity.label}`}
                  >
                    Undo
                  </Button>
                ) : undefined
              }
            >
              <ListItemText
                primary={row.mergedEntity.label}
                secondary={
                  row.reversible
                    ? day && `Merged ${day}`
                    : `${day ? `Merged ${day}. ` : ''}Can no longer be undone from here.`
                }
                sx={{ pr: canUndo && row.reversible ? 8 : 0 }}
              />
            </ListItem>
          );
        })}
      </List>
    </Box>
  );
}
