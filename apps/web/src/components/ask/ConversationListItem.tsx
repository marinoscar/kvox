/**
 * `ConversationListItem` — one saved conversation in the `/ask` list (#380).
 *
 * The row is a LINK to `/ask/:id` (keyboard: Tab to it, Enter to open); its
 * overflow menu (Rename / Delete) is a separate button beside it, so neither
 * swallows the other's activation. A running turn shows a small spinner.
 */

import MoreVertIcon from '@mui/icons-material/MoreVert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { EntityTypeIcon } from '../graph/entityTypeIcon';
import type { AskConversationSummary } from '../../services/ask';
import { formatRelativeTime } from '../../utils/relativeTime';

export const UNTITLED_CONVERSATION = 'New conversation';

export function conversationTitle(summary: Pick<AskConversationSummary, 'title'>): string {
  return summary.title?.trim() || UNTITLED_CONVERSATION;
}

export function askConversationPath(id: string): string {
  return `/ask/${encodeURIComponent(id)}`;
}

export interface ConversationListItemProps {
  conversation: AskConversationSummary;
  selected: boolean;
  onOpen?: () => void;
  onRename: (conversation: AskConversationSummary) => void;
  onDelete: (conversation: AskConversationSummary) => void;
}

export function ConversationListItem({ conversation, selected, onOpen, onRename, onDelete }: ConversationListItemProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const title = conversationTitle(conversation);

  return (
    <ListItem
      disablePadding
      secondaryAction={
        <IconButton
          edge="end"
          size="small"
          aria-label={`Actions for ${title}`}
          aria-haspopup="menu"
          onClick={(event) => setAnchor(event.currentTarget)}
        >
          <MoreVertIcon fontSize="small" />
        </IconButton>
      }
      sx={{ '& .MuiListItemSecondaryAction-root': { right: 8 } }}
    >
      <ListItemButton
        component={RouterLink}
        to={askConversationPath(conversation.id)}
        selected={selected}
        aria-current={selected ? 'page' : undefined}
        onClick={onOpen}
        sx={{ pr: 6, borderRadius: 1, alignItems: 'flex-start', py: 1 }}
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
            {conversation.running && (
              <CircularProgress size={10} thickness={6} aria-label="Answering" sx={{ flexShrink: 0 }} />
            )}
            <Typography variant="subtitle2" component="span" noWrap sx={{ fontWeight: 600, minWidth: 0 }}>
              {title}
            </Typography>
          </Stack>
          {conversation.lastMessagePreview && (
            <Typography variant="body2" color="text.secondary" noWrap>
              {conversation.lastMessagePreview}
            </Typography>
          )}
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mt: 0.25, minWidth: 0 }}>
            {conversation.scopeEntity && (
              <Chip
                size="small"
                variant="outlined"
                icon={<EntityTypeIcon type={conversation.scopeEntity.type} />}
                label={conversation.scopeEntity.label}
                sx={{ height: 20, maxWidth: 140, '& .MuiChip-label': { px: 0.75 } }}
              />
            )}
            <Typography variant="caption" color="text.secondary" noWrap>
              {formatRelativeTime(conversation.updatedAt)}
            </Typography>
          </Stack>
        </Box>
      </ListItemButton>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        <MenuItem
          onClick={() => {
            setAnchor(null);
            onRename(conversation);
          }}
        >
          Rename
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null);
            onDelete(conversation);
          }}
          sx={{ color: 'error.main' }}
        >
          Delete
        </MenuItem>
      </Menu>
    </ListItem>
  );
}

export default ConversationListItem;
