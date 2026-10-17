/**
 * `EntityListRow` — one entity on the `/graph` index (#373).
 *
 * The whole row is ONE link to the entity page: avatar (initials + a small
 * type badge), label, type chip, first alias, "Seen <relative>", mention count.
 */

import Avatar from '@mui/material/Avatar';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import ListItem from '@mui/material/ListItem';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import type { GraphEntitySummary } from '../../headless/clients/graph.js';
import { initials } from '../../headless/utils/graphDisplay.js';
import { formatRelativeTime } from '../../../core/headless/index.js';
import { EntityTypeIcon } from './entityTypeIcon.js';

/**
 * Props of {@link EntityListRow}.
 *
 * @stability experimental
 */
export interface EntityListRowProps {
  /** The entity to show. */
  entity: GraphEntitySummary;
  /** The type's singular label from the ontology. */
  typeLabel: string;
}

/**
 * The app path of an entity's page, `/graph/entities/:id`, with the id encoded.
 *
 * @stability experimental
 */
export function entityPath(id: string): string {
  return `/graph/entities/${encodeURIComponent(id)}`;
}

/**
 * One row of the entity index: type icon or initials, label, aliases, mention count and last-seen date, linking to the entity page.
 *
 * @stability experimental
 */
export function EntityListRow({ entity, typeLabel }: EntityListRowProps) {
  const alias = entity.aliases[0];
  const secondary = [
    alias ? `Also “${alias}”` : null,
    entity.lastSeenAt ? `Seen ${formatRelativeTime(entity.lastSeenAt)}` : null,
    `${entity.mentionCount} ${entity.mentionCount === 1 ? 'mention' : 'mentions'}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <ListItem disablePadding>
      <ListItemButton component={RouterLink} to={entityPath(entity.id)} sx={{ borderRadius: 1 }}>
        <ListItemAvatar>
          <Badge
            overlap="circular"
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            badgeContent={
              <Box
                aria-hidden
                sx={{
                  bgcolor: 'background.paper',
                  borderRadius: '50%',
                  display: 'flex',
                  p: '1px',
                  color: 'text.secondary',
                }}
              >
                <EntityTypeIcon type={entity.type} sx={{ fontSize: 14 }} />
              </Box>
            }
          >
            <Avatar aria-hidden sx={{ bgcolor: 'primary.main', color: 'primary.contrastText' }}>
              {initials(entity.label)}
            </Avatar>
          </Badge>
        </ListItemAvatar>
        <ListItemText
          primary={
            <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
              <Typography component="span" variant="body1" noWrap sx={{ fontWeight: 600, minWidth: 0 }}>
                {entity.label}
              </Typography>
              <Chip size="small" label={typeLabel} variant="outlined" sx={{ flexShrink: 0 }} />
            </Box>
          }
          secondary={secondary}
          slotProps={{ secondary: { noWrap: true } }}
          sx={{ minWidth: 0 }}
        />
      </ListItemButton>
    </ListItem>
  );
}

