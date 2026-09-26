/**
 * `EntityAskPanel` — "Ask about Joe" on an entity page (#381, epic #348;
 * spec `docs/specs/ontology.md` §21.5).
 *
 * A TRANSIENT SURFACE OVER THE PAGE, not a section of it: ≥ 600 px a
 * right-anchored temporary drawer 440 px wide, so the entity stays visible
 * beside the answer; < 600 px a bottom sheet at 90vh with a 12 px top radius
 * (the `NameSuggestionsPanel` phone pattern). That is one PAGE-LEVEL
 * `down('sm')` read — where this surface sits — never whether app chrome
 * mounts, so it is not a sixth coupled breakpoint gate (CLAUDE.md, Settings
 * UI Pattern rule 5).
 *
 * SCOPED CONVERSATIONS. Every conversation this panel creates carries
 * `scopeEntityId` (#376), so the agent starts from this entity (#378 makes it
 * `ent1`); the picker lists only this entity's conversations
 * (`GET /api/ask/conversations?scopeEntityId=`). The same conversations
 * appear on `/ask` with their entity chip — one store, two entry points —
 * and "Open in Ask" jumps there.
 *
 * REUSE, NOT A FORK. The thread, composer, streaming, tool steps, citation
 * chips, error copy and model picker are #380's own `AskThread`,
 * `AskComposer`, `useAskConversation` and `useAskConversations`; this file
 * only lays them out in a drawer and decides which conversation is open.
 *
 * THE OWNER HOLDS THE URL. `conversationId` and `onConversationChange` are
 * the entity page's `?ask=` parameter, so a reload reopens the same
 * conversation and the back gesture closes the panel.
 *
 * CLOSING IS SAFE AT ANY MOMENT. The drawer's body mounts only while open, so
 * closing it mid-answer unmounts the stream (the SSE connection closes) while
 * the `ask.respond` job carries on server-side — the stream is a view over
 * durable state (Notes rule 1). Reopening re-reads the conversation and
 * either reattaches to the still-running turn or shows the finished answer.
 */

import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import CloseIcon from '@mui/icons-material/Close';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { AskComposer, askDefaultModel, askModelOptions, recallAskModel, rememberAskModel } from './AskComposer';
import { AskThread } from './AskThread';
import { askComposerAlert } from './askComposerAlert';
import { askConversationPath, conversationTitle } from './ConversationListItem';
import { entityAskSuggestions } from './entityAskSuggestions';
import { useAskConversation } from '../../hooks/useAskConversation';
import { useAskConversations } from '../../hooks/useAskConversations';
import { ApiError } from '../../services/api';
import { postAskMessage } from '../../services/ask';
import type { AiConfig } from '../../services/ai';
import type { AskConversationDetail, AskConversationSummary } from '../../services/ask';
import { formatRelativeTime } from '../../utils/relativeTime';

/** At most this many of the entity's conversations in the picker (#381). */
export const ENTITY_ASK_CONVERSATION_LIMIT = 10;

/** The picker's value for "start a new conversation". */
const NEW_CONVERSATION = '__new__';

export const ENTITY_ASK_GONE_COPY = 'This entity is no longer in your graph';

export interface EntityAskSubject {
  id: string;
  label: string;
  type: string;
}

export function entityAskTitle(label: string): string {
  return `Ask about ${label}`;
}

// =============================================================================
// The header action
// =============================================================================

export interface EntityAskButtonProps {
  label: string;
  onClick: () => void;
}

/**
 * "Ask about {label}" for `EntityHeader`'s `actions` slot — icon-only with the
 * same accessible name on a phone (the page-level read `EntityHeader` itself
 * makes for Edit), so a long name keeps the header row without scrolling.
 */
export function EntityAskButton({ label, onClick }: EntityAskButtonProps) {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const name = entityAskTitle(label);

  if (isPhone) {
    return (
      <IconButton aria-label={name} onClick={onClick}>
        <ChatBubbleOutlineIcon />
      </IconButton>
    );
  }
  return (
    <Button
      variant="outlined"
      startIcon={<ChatBubbleOutlineIcon />}
      onClick={onClick}
      aria-label={name}
      sx={{ maxWidth: 280, textTransform: 'none' }}
    >
      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name}
      </Box>
    </Button>
  );
}

// =============================================================================
// The panel
// =============================================================================

export interface EntityAskPanelProps {
  open: boolean;
  onClose: () => void;
  entity: EntityAskSubject;
  /** The open conversation (`?ask=<id>`), or `null` for a new one (`?ask=1`). */
  conversationId: string | null;
  /** The panel opened (or started) a different conversation. */
  onConversationChange: (conversationId: string | null) => void;
  /** `useAiConfig().config` — models, the `graph.agent` default, `keyConfigured`. */
  config: AiConfig | null;
}

export function EntityAskPanel({ open, onClose, entity, conversationId, onConversationChange, config }: EntityAskPanelProps) {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const titleId = useId();

  return (
    <Drawer
      anchor={isPhone ? 'bottom' : 'right'}
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          role: 'dialog',
          'aria-modal': true,
          'aria-labelledby': titleId,
          sx: isPhone
            ? { height: '90vh', borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' }
            : { width: 440, maxWidth: '100vw', height: '100%', overflow: 'hidden' },
        },
      }}
    >
      <EntityAskPanelBody
        titleId={titleId}
        onClose={onClose}
        entity={entity}
        conversationId={conversationId}
        onConversationChange={onConversationChange}
        config={config}
      />
    </Drawer>
  );
}

interface EntityAskPanelBodyProps extends Omit<EntityAskPanelProps, 'open'> {
  titleId: string;
}

function EntityAskPanelBody({
  titleId,
  onClose,
  entity,
  conversationId,
  onConversationChange,
  config,
}: EntityAskPanelBodyProps) {
  const [seed, setSeed] = useState<AskConversationDetail | null>(null);
  const [sendError, setSendError] = useState<unknown>(null);
  const [entityGone, setEntityGone] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  // A scoped conversation created for a first question whose post was refused:
  // the next attempt reuses it rather than creating a second, empty one.
  const createdButUnsent = useRef<AskConversationSummary | null>(null);
  // Whether the picker may still default to the newest conversation. Any
  // choice the user makes (a pick, "New conversation", a send) ends it.
  const mayAutoPick = useRef(conversationId === null);

  const list = useAskConversations({ scopeEntityId: entity.id, limit: ENTITY_ASK_CONVERSATION_LIMIT });
  const refreshList = list.refresh;
  const detail = useAskConversation(conversationId, {
    seed,
    onTurnSettled: () => {
      void refreshList();
    },
  });

  const models = askModelOptions(config);
  const defaultModel = askDefaultModel(config);

  const choose = useCallback(
    (next: string | null) => {
      mayAutoPick.current = false;
      setSendError(null);
      if (next === null) setFocusKey((key) => key + 1);
      if (next !== conversationId) onConversationChange(next);
    },
    [conversationId, onConversationChange],
  );

  // "New conversation" is the default only while the entity has none: once
  // the list answers, an unchosen panel opens the newest one.
  useEffect(() => {
    if (!mayAutoPick.current || list.isLoading) return;
    mayAutoPick.current = false;
    if (conversationId === null && !list.error && list.items.length > 0) {
      onConversationChange(list.items[0].id);
    }
  }, [conversationId, list.error, list.isLoading, list.items, onConversationChange]);

  // A conversation id in the URL that belongs to a DIFFERENT entity is not
  // this panel's to show: fall back to a new, scoped one.
  const loadedScope = detail.conversation?.id === conversationId ? detail.conversation?.scopeEntity : undefined;
  useEffect(() => {
    if (loadedScope && loadedScope.id !== entity.id) onConversationChange(null);
  }, [entity.id, loadedScope, onConversationChange]);

  const askNew = useCallback(
    async (content: string, model: string | undefined): Promise<boolean> => {
      let created = createdButUnsent.current;
      try {
        if (!created) {
          try {
            created = await list.create();
          } catch (err) {
            // #376: a scope entity that is not the caller's readable entity —
            // merged or forgotten since this page loaded — is a 404.
            if (err instanceof ApiError && err.status === 404) {
              setEntityGone(true);
              return false;
            }
            throw err;
          }
          createdButUnsent.current = created;
        }
        if (model) rememberAskModel(created.id, model);
        const result = await postAskMessage(created.id, { content, model });
        createdButUnsent.current = null;
        setSeed({
          id: created.id,
          title: created.title ?? content.slice(0, 80),
          scopeEntity: created.scopeEntity,
          running: true,
          createdAt: created.createdAt,
          updatedAt: result.userMessage.createdAt,
          messages: [result.userMessage, result.assistantMessage],
          hasEarlier: false,
        });
        onConversationChange(created.id);
        void list.refresh();
        return true;
      } catch (err) {
        setSendError(err);
        return false;
      }
    },
    [list, onConversationChange],
  );

  const send = useCallback(
    async (content: string, model: string | undefined): Promise<boolean> => {
      mayAutoPick.current = false;
      setSendError(null);
      if (!conversationId) return askNew(content, model);
      try {
        await detail.send(content, model);
        void list.refresh();
        return true;
      } catch (err) {
        setSendError(err);
        return false;
      }
    },
    [askNew, conversationId, detail, list],
  );

  const retry = useCallback(
    (question: string) => {
      const remembered = recallAskModel(conversationId);
      void send(question, remembered && remembered !== defaultModel ? remembered : undefined);
    },
    [conversationId, defaultModel, send],
  );

  const conversation = detail.conversation?.id === conversationId ? detail.conversation : null;
  const title = entityAskTitle(entity.label);

  // --- the body ---------------------------------------------------------------
  let body: ReactNode;
  if (entityGone) {
    body = (
      <Box sx={{ flex: 1, py: 2 }}>
        <Alert severity="error">{ENTITY_ASK_GONE_COPY}.</Alert>
      </Box>
    );
  } else if (!conversationId) {
    body = (
      <EntityAskEmptyState
        entity={entity}
        loading={list.isLoading && mayAutoPick.current}
        onAsk={(question) => void send(question, undefined)}
      />
    );
  } else if (detail.notFound) {
    body = (
      <Box sx={{ flex: 1, py: 3 }}>
        <Typography variant="subtitle1" component="p" sx={{ mb: 1 }}>
          This conversation doesn&apos;t exist
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          It may have been deleted.
        </Typography>
        <Button variant="outlined" onClick={() => choose(null)}>
          Start a new conversation
        </Button>
      </Box>
    );
  } else if (detail.isLoading && !conversation) {
    body = (
      <Stack spacing={2} sx={{ flex: 1, py: 2 }} aria-busy="true" aria-label="Loading conversation">
        <Skeleton variant="rounded" height={40} sx={{ alignSelf: 'flex-end', width: '55%' }} />
        <Skeleton variant="rounded" height={96} sx={{ width: '85%' }} />
      </Stack>
    );
  } else if (detail.error && !conversation) {
    body = (
      <Box sx={{ flex: 1, py: 2 }}>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void detail.refresh()}>
              Retry
            </Button>
          }
        >
          {detail.error}
        </Alert>
      </Box>
    );
  } else {
    body = (
      <AskThread
        messages={conversation?.messages ?? []}
        hasEarlier={conversation?.hasEarlier ?? false}
        isLoadingEarlier={detail.isLoadingEarlier}
        onLoadEarlier={() => void detail.loadEarlier()}
        stream={detail.stream}
        onRetry={retry}
        retryDisabled={detail.running}
      />
    );
  }

  const showComposer =
    !entityGone && !(conversationId && (detail.notFound || (detail.error && !conversation)));
  const alert = askComposerAlert({ sendError, onDismiss: () => setSendError(null), config });

  // --- the picker -------------------------------------------------------------
  const pickerItems = [...list.items];
  if (conversationId && !pickerItems.some((row) => row.id === conversationId) && conversation) {
    // Opened from the URL, or older than the first page: still selectable.
    pickerItems.push({ ...conversation, lastMessagePreview: null });
  }
  const pickerValue =
    conversationId && pickerItems.some((row) => row.id === conversationId) ? conversationId : NEW_CONVERSATION;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', px: 2, pt: 1.5, pb: 1, borderBottom: 1, borderColor: 'divider' }}
      >
        <Typography id={titleId} variant="h6" component="h2" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: 600 }}>
          {title}
        </Typography>
        {conversationId && conversation && (
          <Button
            component={RouterLink}
            to={askConversationPath(conversationId)}
            size="small"
            endIcon={<OpenInNewIcon fontSize="small" />}
            sx={{ flexShrink: 0, textTransform: 'none' }}
          >
            Open in Ask
          </Button>
        )}
        <IconButton aria-label="Close" onClick={onClose} edge="end">
          <CloseIcon />
        </IconButton>
      </Stack>

      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, px: 2, pt: 1.5, pb: 1.5 }}>
        {!entityGone && (
          <ConversationPicker
            items={pickerItems}
            value={pickerValue}
            disabled={list.isLoading && pickerItems.length === 0}
            onChange={(value) => choose(value === NEW_CONVERSATION ? null : value)}
          />
        )}
        {list.error && !entityGone && (
          <Alert
            severity="warning"
            sx={{ mt: 1 }}
            action={
              <Button color="inherit" size="small" onClick={() => void list.refresh()}>
                Retry
              </Button>
            }
          >
            {list.error}
          </Alert>
        )}

        {body}

        {showComposer && (
          <Box sx={{ pb: 'env(safe-area-inset-bottom)' }}>
            <AskComposer
              onSend={send}
              running={detail.running}
              disabled={Boolean(conversationId) && detail.isLoading && !conversation}
              models={models}
              defaultModel={defaultModel}
              conversationId={conversationId}
              alert={alert}
              autoFocus
              focusKey={focusKey}
              placeholder={`Ask about ${entity.label}…`}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}

// =============================================================================
// Pieces
// =============================================================================

interface ConversationPickerProps {
  items: readonly AskConversationSummary[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

function ConversationPicker({ items, value, disabled, onChange }: ConversationPickerProps) {
  const labelId = useId();
  const titleOf = (id: string) => {
    const row = items.find((item) => item.id === id);
    return row ? conversationTitle(row) : 'New conversation';
  };

  return (
    <FormControl size="small" fullWidth disabled={disabled}>
      <InputLabel id={labelId}>Conversation</InputLabel>
      <Select
        labelId={labelId}
        label="Conversation"
        value={value}
        onChange={(event) => onChange(String(event.target.value))}
        renderValue={(selected) => (
          <Box component="span" sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {titleOf(String(selected))}
          </Box>
        )}
        MenuProps={{ slotProps: { paper: { sx: { maxHeight: 360 } } } }}
      >
        <MenuItem value={NEW_CONVERSATION}>New conversation</MenuItem>
        {items.map((item) => (
          <MenuItem key={item.id} value={item.id} sx={{ display: 'block', maxWidth: 400 }}>
            <Typography variant="body2" noWrap>
              {conversationTitle(item)}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="span">
              {item.running ? 'Answering… · ' : ''}
              {formatRelativeTime(item.updatedAt)}
            </Typography>
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

interface EntityAskEmptyStateProps {
  entity: EntityAskSubject;
  /** The picker has not answered yet (it may still open an existing one). */
  loading: boolean;
  onAsk: (question: string) => void;
}

function EntityAskEmptyState({ entity, loading, onAsk }: EntityAskEmptyStateProps) {
  const suggestions = entityAskSuggestions(entity);
  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', py: 3 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Answers start from {entity.label} and come only from your own reviewed notes and transcripts, with a source
        for every claim.
      </Typography>
      <Stack
        spacing={1}
        component="ul"
        aria-label="Suggested questions"
        sx={{ listStyle: 'none', p: 0, m: 0 }}
      >
        {suggestions.map((question) => (
          <Box component="li" key={question}>
            <Button
              variant="outlined"
              fullWidth
              disabled={loading}
              onClick={() => onAsk(question)}
              sx={{ justifyContent: 'flex-start', textTransform: 'none', textAlign: 'left' }}
            >
              {question}
            </Button>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

export default EntityAskPanel;
