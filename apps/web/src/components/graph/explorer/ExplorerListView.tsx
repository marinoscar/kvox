/**
 * `ExplorerListView` — the explorer as a list (#374; spec §22.2).
 *
 * Two jobs: the ACCESSIBLE view of everything the canvas shows (every canvas
 * action — expand, open, hide — is a real button here), and the ONLY view when
 * the browser has no WebGL. Nodes are grouped by type, the seeds' groups
 * first; within a group, seeds first, then nearest, then best connected
 * (`explorerModel.toListModel`).
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import { EntityTypeIcon } from '../entityTypeIcon';
import { CAP_TOOLTIP } from './ExplorerSidePanel';
import type { ExplorerListRow } from './explorerModel';

export interface ExplorerListViewProps {
  rows: ExplorerListRow[];
  typeLabel: (type: string) => string;
  atCap: boolean;
  expandingId: string | null;
  onExpand: (id: string) => void;
  onHide: (id: string) => void;
}

interface Group {
  type: string;
  rows: ExplorerListRow[];
}

/** Group in the rows' own order, so the seeds' types lead. */
export function groupRows(rows: readonly ExplorerListRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const group = groups.get(row.type) ?? { type: row.type, rows: [] };
    group.rows.push(row);
    groups.set(row.type, group);
  }
  return [...groups.values()];
}

export function ExplorerListView({
  rows,
  typeLabel,
  atCap,
  expandingId,
  onExpand,
  onHide,
}: ExplorerListViewProps) {
  if (rows.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          Nothing to show with these filters.
        </Typography>
      </Paper>
    );
  }

  return (
    <Box component="section" aria-label="Graph as a list" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {groupRows(rows).map((group) => {
        const headingId = `explorer-group-${group.type}`;
        return (
          <Paper key={group.type} variant="outlined">
            <Typography
              id={headingId}
              variant="subtitle2"
              component="h2"
              sx={{ px: 2, pt: 1.5, pb: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}
            >
              <EntityTypeIcon type={group.type} fontSize="small" sx={{ color: 'text.secondary' }} />
              {typeLabel(group.type)} ({group.rows.length})
            </Typography>
            <List aria-labelledby={headingId} dense disablePadding>
              {group.rows.map((row) => (
                <ListRow
                  key={row.id}
                  row={row}
                  atCap={atCap}
                  expanding={expandingId === row.id}
                  onExpand={onExpand}
                  onHide={onHide}
                />
              ))}
            </List>
          </Paper>
        );
      })}
    </Box>
  );
}

function ListRow({
  row,
  atCap,
  expanding,
  onExpand,
  onHide,
}: {
  row: ExplorerListRow;
  atCap: boolean;
  expanding: boolean;
  onExpand: (id: string) => void;
  onHide: (id: string) => void;
}) {
  const expandLabel = `Expand ${row.label}`;
  const expandButton = (
    <Button
      size="small"
      onClick={() => onExpand(row.id)}
      disabled={atCap || expanding}
      aria-label={expandLabel}
    >
      {expanding ? 'Expanding…' : 'Expand'}
    </Button>
  );
  return (
    <ListItem
      divider
      sx={{
        flexWrap: 'wrap',
        columnGap: 1,
        py: 1,
        px: 2,
      }}
    >
      <ListItemText
        sx={{ flex: '1 1 200px', minWidth: 0 }}
        primary={
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <span>{row.label}</span>
            {row.isSeed && <Chip size="small" variant="outlined" label="Starting point" />}
          </Box>
        }
        secondary={row.degree === 1 ? '1 connection' : `${row.degree} connections`}
      />
      <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
        {atCap ? (
          <Tooltip title={CAP_TOOLTIP}>
            <span>{expandButton}</span>
          </Tooltip>
        ) : (
          expandButton
        )}
        {row.nodeKind === 'entity' && (
          <Button
            size="small"
            component={RouterLink}
            to={`/graph/entities/${encodeURIComponent(row.id)}`}
            aria-label={`Open ${row.label}'s page`}
          >
            Open page
          </Button>
        )}
        {!row.isSeed && (
          <Button size="small" onClick={() => onHide(row.id)} aria-label={`Hide ${row.label}`}>
            Hide
          </Button>
        )}
      </Box>
    </ListItem>
  );
}
