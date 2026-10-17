/**
 * `ConversationList` — the saved Ask conversations (#380): the left pane on
 * ≥ 600 px, a temporary drawer on a phone. "New conversation" opens `/ask`
 * with the composer focused.
 */

import AddIcon from '@mui/icons-material/Add';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';

import type { AskConversationSummary } from '../../headless/index.js';
import { ConversationListItem } from './ConversationListItem.js';

/**
 * Props of {@link ConversationList}.
 *
 * @stability experimental
 */
export interface ConversationListProps {
  /** The conversations, newest first. */
  items: readonly AskConversationSummary[];
  /** The open conversation, highlighted. */
  selectedId: string | null;
  /** The first page is loading. */
  isLoading: boolean;
  /** A load failure's copy, or `null`. */
  error: string | null;
  /** More pages exist. */
  hasMore: boolean;
  /** A later page is loading. */
  isLoadingMore: boolean;
  /** "Show more" was pressed. */
  onLoadMore: () => void;
  /** "Try again" was pressed after a failed load. */
  onRetry: () => void;
  /** "New conversation" was pressed. */
  onNew: () => void;
  /** A row was followed (the phone drawer closes on it). */
  onOpen?: () => void;
  /** A row's "Rename" was chosen. */
  onRename: (conversation: AskConversationSummary) => void;
  /** A row's "Delete" was chosen. */
  onDelete: (conversation: AskConversationSummary) => void;
}

/**
 * The saved Ask conversations: the left pane on 600 px and up, a drawer's
 * content on a phone.
 *
 * @param props - See {@link ConversationListProps}.
 * @returns The list.
 *
 * @stability experimental
 */
export function ConversationList({
  items,
  selectedId,
  isLoading,
  error,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onRetry,
  onNew,
  onOpen,
  onRename,
  onDelete,
}: ConversationListProps) {
  return (
    <Box component="nav" aria-label="Conversations" sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <Box sx={{ p: 1 }}>
        <Button fullWidth variant="contained" startIcon={<AddIcon />} onClick={onNew}>
          New conversation
        </Button>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 0.5 }}>
        {isLoading ? (
          <Box sx={{ px: 1.5 }} aria-busy="true" aria-label="Loading conversations">
            {[0, 1, 2, 3].map((row) => (
              <Box key={row} sx={{ py: 1 }}>
                <Skeleton width="70%" />
                <Skeleton width="90%" />
              </Box>
            ))}
          </Box>
        ) : error && items.length === 0 ? (
          <Alert
            severity="error"
            sx={{ m: 1 }}
            action={
              <Button color="inherit" size="small" onClick={onRetry}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        ) : items.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1.5 }}>
            No saved conversations yet.
          </Typography>
        ) : (
          <List dense disablePadding>
            {items.map((conversation) => (
              <ConversationListItem
                key={conversation.id}
                conversation={conversation}
                selected={conversation.id === selectedId}
                onOpen={onOpen}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
          </List>
        )}
        {hasMore && !isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
            <Button size="small" onClick={onLoadMore} disabled={isLoadingMore}>
              Load more
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  );
}

