/**
 * `EntityHeader` — the entity page's heading block (#373): type chip, the
 * page's only `<h1>` (the entity label — the AppBar title stays "Knowledge"),
 * aliases (≤ 5 + "+n"), first/last seen, counts, and the actions.
 *
 * `actions` is a SLOT for #381's "Ask about …" button; Edit and the overflow
 * menu ("Forget this person…", Person + `graph:write` only) are built in.
 */

import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { ReactNode } from 'react';

import type { GraphEntityDetail } from '../../services/graph';
import { EntityTypeIcon } from './entityTypeIcon';

const MAX_ALIASES = 5;

export interface EntityHeaderProps {
  entity: GraphEntityDetail;
  typeLabel: string;
  canEdit: boolean;
  onEdit: () => void;
  onForget: () => void;
  /** Extra actions (#381 mounts "Ask about …" here). */
  actions?: ReactNode;
}

function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function EntityHeader({ entity, typeLabel, canEdit, onEdit, onForget, actions }: EntityHeaderProps) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const canForget = canEdit && entity.type === 'Person';

  const aliases = entity.aliases.map((alias) => alias.alias);
  const shown = aliases.slice(0, MAX_ALIASES);
  const hidden = aliases.length - shown.length;

  const first = formatDay(entity.firstSeenAt);
  const last = formatDay(entity.lastSeenAt);
  const seen = first && last ? (first === last ? `Seen ${first}` : `${first} – ${last}`) : first ?? last;

  const counts = [
    plural(entity.counts.mentions, 'mention', 'mentions'),
    plural(entity.counts.relations, 'connection', 'connections'),
    plural(entity.counts.openCommitments, 'open commitment', 'open commitments'),
  ].join(' · ');

  return (
    <Box component="header" sx={{ mb: 3 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Box sx={{ minWidth: 0 }}>
          <Chip
            size="small"
            icon={<EntityTypeIcon type={entity.type} fontSize="small" />}
            label={typeLabel}
            variant="outlined"
            sx={{ mb: 1 }}
          />
          <Typography variant="h4" component="h1" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {entity.label}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0, alignItems: 'center' }}>
          {actions}
          {canEdit && (
            <Button variant="outlined" startIcon={<EditOutlinedIcon />} onClick={onEdit}>
              Edit
            </Button>
          )}
          {canForget && (
            <>
              <IconButton
                aria-label={`More actions for ${entity.label}`}
                aria-haspopup="menu"
                onClick={(event) => setMenuAnchor(event.currentTarget)}
              >
                <MoreVertIcon />
              </IconButton>
              <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
                <MenuItem
                  onClick={() => {
                    setMenuAnchor(null);
                    onForget();
                  }}
                  sx={{ color: 'error.main' }}
                >
                  Forget this person…
                </MenuItem>
              </Menu>
            </>
          )}
        </Stack>
      </Stack>

      {shown.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1.5 }} aria-label="Also known as" role="list">
          {shown.map((alias) => (
            <Chip key={alias} size="small" label={alias} role="listitem" />
          ))}
          {hidden > 0 && <Chip size="small" label={`+${hidden}`} role="listitem" aria-label={`${hidden} more names`} />}
        </Box>
      )}

      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
        {[seen, counts].filter(Boolean).join(' · ')}
      </Typography>
    </Box>
  );
}

export default EntityHeader;
