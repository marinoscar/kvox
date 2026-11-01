/**
 * `EntityHeader` — the entity page's heading block (#373): type chip, the
 * page's only `<h1>` (the entity label — the AppBar title stays "Knowledge"),
 * "Also known as" with every alias (five shown, a "+n" that expands; with
 * `graph:write`, clicking a name opens the edit dialog, where aliases are
 * managed — #765), first/last seen, counts, and the actions.
 *
 * `actions` is a SLOT for #381's "Ask about …" button; Edit and the overflow
 * menu are built in, both for `graph:write` only (hidden, like Edit, from a
 * read-only viewer): "Merge into…" for every type (#765) and "Forget this
 * person…" for a Person.
 */

import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import MergeIcon from '@mui/icons-material/Merge';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { GraphEntityDetail } from '../../headless/clients/graph.js';
import { EntityTypeIcon } from './entityTypeIcon.js';
import { formatDate, useDisplayTimeZone } from '@marinoscar/platform-web/timezone/headless';

const MAX_ALIASES = 5;

export interface EntityHeaderProps {
  entity: GraphEntityDetail;
  typeLabel: string;
  canEdit: boolean;
  onEdit: () => void;
  onForget: () => void;
  /** Opens the "Merge into…" dialog. */
  onMerge: () => void;
  /** Extra actions (#381 mounts "Ask about …" here). */
  actions?: ReactNode;
}

/** The day in the reader's display zone, or `null` when absent or unparseable. */
function formatDay(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const text = formatDate(iso, { dateStyle: 'medium', timeZone, fallback: '' });
  return text === '' ? null : text;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function EntityHeader({ entity, typeLabel, canEdit, onEdit, onForget, onMerge, actions }: EntityHeaderProps) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const zone = useDisplayTimeZone();
  // Page-level read (not a sixth breakpoint gate): on a phone the Edit button
  // folds to an icon so a long name keeps the row without horizontal scroll.
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const canForget = canEdit && entity.type === 'Person';

  const [showAllAliases, setShowAllAliases] = useState(false);
  useEffect(() => setShowAllAliases(false), [entity.id]);

  const aliases = entity.aliases.map((alias) => alias.alias);
  const shown = showAllAliases ? aliases : aliases.slice(0, MAX_ALIASES);
  const hidden = aliases.length - shown.length;

  const first = formatDay(entity.firstSeenAt, zone);
  const last = formatDay(entity.lastSeenAt, zone);
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
          {canEdit &&
            (isPhone ? (
              <IconButton aria-label="Edit" onClick={onEdit}>
                <EditOutlinedIcon />
              </IconButton>
            ) : (
              <Button variant="outlined" startIcon={<EditOutlinedIcon />} onClick={onEdit}>
                Edit
              </Button>
            ))}
          {canEdit && (
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
                    onMerge();
                  }}
                >
                  <ListItemIcon>
                    <MergeIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>Merge into…</ListItemText>
                </MenuItem>
                {canForget && (
                  <MenuItem
                    onClick={() => {
                      setMenuAnchor(null);
                      onForget();
                    }}
                    sx={{ color: 'error.main' }}
                  >
                    Forget this person…
                  </MenuItem>
                )}
              </Menu>
            </>
          )}
        </Stack>
      </Stack>

      {aliases.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75, mt: 1.5 }}>
          <Typography variant="body2" color="text.secondary" component="span">
            Also known as
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }} aria-label="Also known as" role="list">
            {shown.map((alias) => (
              <Box key={alias} component="span" role="listitem" sx={{ display: 'inline-flex' }}>
                {canEdit ? (
                  <Chip size="small" label={alias} onClick={onEdit} aria-label={`${alias} (edit names)`} />
                ) : (
                  <Chip size="small" label={alias} />
                )}
              </Box>
            ))}
            {hidden > 0 && (
              <Box component="span" role="listitem" sx={{ display: 'inline-flex' }}>
                <Chip
                  size="small"
                  variant="outlined"
                  label={`+${hidden}`}
                  aria-label={`Show ${hidden} more ${hidden === 1 ? 'name' : 'names'}`}
                  aria-expanded={false}
                  onClick={() => setShowAllAliases(true)}
                />
              </Box>
            )}
            {showAllAliases && aliases.length > MAX_ALIASES && (
              <Box component="span" role="listitem" sx={{ display: 'inline-flex' }}>
                <Chip
                  size="small"
                  variant="outlined"
                  label="Show fewer"
                  aria-expanded
                  onClick={() => setShowAllAliases(false)}
                />
              </Box>
            )}
          </Box>
        </Box>
      )}

      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
        {[seen, counts].filter(Boolean).join(' · ')}
      </Typography>
    </Box>
  );
}

