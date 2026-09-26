/**
 * `/ask` and `/ask/:conversationId` — Ask, the read-only agent over the
 * caller's own knowledge graph (#380, epic #348; spec `docs/specs/ontology.md`
 * §21.5).
 *
 * OWNED BY THE `home` DESTINATION, with no bottom-bar tab of its own (the bar
 * is at its four-tab ceiling by design — CLAUDE.md, Navigation Destination
 * Model). Reached from Home's Knowledge section. Gated on `graph:read` in
 * `App.tsx`; the whole page is behind `GET /api/ai/config`'s `graphEnabled`
 * — with it off, an info state and no composer.
 *
 * LAYOUT. ≥ 600 px: the saved conversations in a 280 px left pane that scrolls
 * on its own, beside the thread. < 600 px: the thread full width, and a
 * "Conversations" button opening the list in a temporary drawer. That is one
 * PAGE-LEVEL `down('sm')` read — where this page puts its own list — never
 * whether app chrome mounts, so it is not a sixth coupled breakpoint gate
 * (CLAUDE.md, Settings UI Pattern rule 5). The page's height mirrors
 * `Layout`'s own padding (`pb: { xs: 10, sm: 3 }`) so the composer sits
 * above the phone's bottom bar rather than under it, and the thread scrolls
 * inside the page instead of the document growing.
 *
 * SENDING from `/ask` creates the conversation, posts the question, and
 * replaces the URL with `/ask/:id`, handing both new rows over in router
 * state so they render at once. If the post is refused (a 409), the empty
 * conversation just created is reused by the next attempt rather than a
 * second one being made, and the typed text stays in the box.
 */

import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router-dom';

import { AskComposer, askDefaultModel, askModelOptions, recallAskModel, rememberAskModel } from '../components/ask/AskComposer';
import { AskEmptyState } from '../components/ask/AskEmptyState';
import { AskThread } from '../components/ask/AskThread';
import { ConversationList } from '../components/ask/ConversationList';
import { askConversationPath, conversationTitle } from '../components/ask/ConversationListItem';
import { DeleteConversationDialog } from '../components/ask/DeleteConversationDialog';
import { RenameConversationDialog } from '../components/ask/RenameConversationDialog';
import { askComposerAlert } from '../components/ask/askComposerAlert';
import { ASK_DISABLED_COPY } from '../components/ask/askErrorCopy';
import { EntityTypeIcon } from '../components/graph/entityTypeIcon';
import { entityPath } from '../components/graph/EntityListRow';
import { useAiConfig } from '../hooks/useAiConfig';
import { useAskConversation } from '../hooks/useAskConversation';
import { useAskConversations } from '../hooks/useAskConversations';
import { postAskMessage } from '../services/ask';
import type { AiConfig } from '../services/ai';
import type { AskConversationDetail, AskConversationSummary } from '../services/ask';

/** How `/ask` hands a just-created conversation's rows to `/ask/:id`. */
export interface AskLocationState {
  askSeed?: AskConversationDetail;
}

/**
 * The page's height: the viewport less the AppBar (56/64 px) and `<main>`'s
 * own padding (24 px top; 80 px bottom on a phone, clearing the bottom bar,
 * 24 px otherwise). Mirrors `Layout`, never gates anything.
 */
const PAGE_HEIGHT = { xs: 'calc(100dvh - 160px)', sm: 'calc(100dvh - 112px)' } as const;

export default function AskPage() {
  const ai = useAiConfig();
  const config = ai.config;

  if (ai.isLoading) return <AskPageSkeleton />;

  // `undefined` means an older server that does not say — "unknown", never
  // "off" (services/ai.ts). Only an explicit `false` turns the page off.
  if (config?.graphEnabled === false) {
    return (
      <Box sx={{ maxWidth: 720 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600, mb: 2 }}>
          Ask
        </Typography>
        <Alert severity="info">
          {ASK_DISABLED_COPY}. An administrator can turn on connected knowledge in the AI settings.
        </Alert>
      </Box>
    );
  }

  return <AskWorkspace config={config} />;
}

function AskPageSkeleton() {
  return (
    <Box sx={{ display: 'flex', gap: 2, height: PAGE_HEIGHT, minHeight: 360 }} aria-busy="true" aria-label="Loading Ask">
      <Skeleton variant="rounded" sx={{ width: 280, height: '100%', display: { xs: 'none', sm: 'block' } }} />
      <Box sx={{ flex: 1 }}>
        <Skeleton width={160} height={48} />
        <ThreadSkeleton />
      </Box>
    </Box>
  );
}

function ThreadSkeleton() {
  return (
    <Stack spacing={2} sx={{ py: 2 }} aria-busy="true" aria-label="Loading conversation">
      <Skeleton variant="rounded" height={40} sx={{ alignSelf: 'flex-end', width: '45%' }} />
      <Skeleton variant="rounded" height={96} sx={{ width: '80%' }} />
      <Skeleton variant="rounded" height={40} sx={{ alignSelf: 'flex-end', width: '35%' }} />
    </Stack>
  );
}

function AskWorkspace({ config }: { config: AiConfig | null }) {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ conversationId?: string }>();
  const id = params.conversationId ?? null;
  const seed = (location.state as AskLocationState | null)?.askSeed ?? null;

  const list = useAskConversations();
  const refreshList = list.refresh;
  const detail = useAskConversation(id, {
    seed,
    onTurnSettled: () => {
      void refreshList();
    },
  });

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [renaming, setRenaming] = useState<AskConversationSummary | null>(null);
  const [deleting, setDeleting] = useState<AskConversationSummary | null>(null);
  // A conversation created for a first question whose post was refused.
  const createdButUnsent = useRef<AskConversationSummary | null>(null);

  const models = askModelOptions(config);
  const defaultModel = askDefaultModel(config);

  // A different conversation starts with a clean alert.
  useEffect(() => {
    setSendError(null);
  }, [id]);

  const askNew = useCallback(
    async (content: string, model: string | undefined): Promise<boolean> => {
      let created = createdButUnsent.current;
      try {
        if (!created) {
          created = await list.create();
          createdButUnsent.current = created;
        }
        if (model) rememberAskModel(created.id, model);
        const result = await postAskMessage(created.id, { content, model });
        createdButUnsent.current = null;
        const askSeed: AskConversationDetail = {
          id: created.id,
          title: created.title ?? content.slice(0, 80),
          scopeEntity: created.scopeEntity,
          running: true,
          createdAt: created.createdAt,
          updatedAt: result.userMessage.createdAt,
          messages: [result.userMessage, result.assistantMessage],
          hasEarlier: false,
        };
        navigate(askConversationPath(created.id), { replace: true, state: { askSeed } satisfies AskLocationState });
        void list.refresh();
        return true;
      } catch (err) {
        setSendError(err);
        return false;
      }
    },
    [list, navigate],
  );

  const send = useCallback(
    async (content: string, model: string | undefined): Promise<boolean> => {
      setSendError(null);
      if (!id) return askNew(content, model);
      try {
        await detail.send(content, model);
        void list.refresh();
        return true;
      } catch (err) {
        setSendError(err);
        return false;
      }
    },
    [askNew, detail, id, list],
  );

  const retry = useCallback(
    (question: string) => {
      const remembered = recallAskModel(id);
      void send(question, remembered && remembered !== defaultModel ? remembered : undefined);
    },
    [defaultModel, id, send],
  );

  const startNew = () => {
    setDrawerOpen(false);
    setSendError(null);
    setFocusKey((key) => key + 1);
    if (id) navigate('/ask');
  };

  const listPane = (
    <ConversationList
      items={list.items}
      selectedId={id}
      isLoading={list.isLoading}
      error={list.error}
      hasMore={list.nextCursor !== null}
      isLoadingMore={list.isLoadingMore}
      onLoadMore={() => void list.loadMore()}
      onRetry={() => void list.refresh()}
      onNew={startNew}
      onOpen={() => setDrawerOpen(false)}
      onRename={setRenaming}
      onDelete={setDeleting}
    />
  );

  const conversation = detail.conversation;
  const heading = id && conversation ? conversationTitle(conversation) : 'Ask';

  let body: ReactNode;
  if (!id) {
    body = (
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <AskEmptyState onAsk={(question) => void send(question, undefined)} />
      </Box>
    );
  } else if (detail.notFound) {
    body = (
      <Box sx={{ flex: 1, py: 4 }}>
        <Typography variant="h6" component="p" sx={{ mb: 1 }}>
          This conversation doesn&apos;t exist
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          It may have been deleted.
        </Typography>
        <Button component={RouterLink} to="/ask" variant="outlined">
          Back to Ask
        </Button>
      </Box>
    );
  } else if (detail.isLoading && !conversation) {
    body = (
      <Box sx={{ flex: 1 }}>
        <ThreadSkeleton />
      </Box>
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

  const alert = askComposerAlert({ sendError, onDismiss: () => setSendError(null), config });

  const showComposer = !detail.notFound && !(id && detail.error && !conversation);

  return (
    <Box sx={{ display: 'flex', gap: 2, height: PAGE_HEIGHT, minHeight: 360, minWidth: 0 }}>
      {!isPhone && (
        <Paper variant="outlined" sx={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {listPane}
        </Paper>
      )}

      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1, minWidth: 0 }}>
          {isPhone && (
            <IconButton aria-label="Conversations" onClick={() => setDrawerOpen(true)} edge="start">
              <ForumOutlinedIcon />
            </IconButton>
          )}
          <Typography
            variant={isPhone ? 'h5' : 'h4'}
            component="h1"
            noWrap
            sx={{ fontWeight: 600, minWidth: 0, flex: 1 }}
          >
            {heading}
          </Typography>
          {conversation?.scopeEntity && (
            <Chip
              component={RouterLink}
              to={entityPath(conversation.scopeEntity.id)}
              clickable
              size="small"
              variant="outlined"
              icon={<EntityTypeIcon type={conversation.scopeEntity.type} />}
              label={conversation.scopeEntity.label}
              sx={{ maxWidth: 160, flexShrink: 0 }}
            />
          )}
        </Stack>

        {body}

        {showComposer && (
          <AskComposer
            onSend={send}
            running={detail.running}
            disabled={Boolean(id) && detail.isLoading && !conversation}
            models={models}
            defaultModel={defaultModel}
            conversationId={id}
            alert={alert}
            autoFocus={!id}
            focusKey={focusKey}
          />
        )}
      </Box>

      {isPhone && (
        <Drawer
          anchor="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          slotProps={{ paper: { sx: { width: 300, maxWidth: '85vw' } } }}
        >
          {listPane}
        </Drawer>
      )}

      <RenameConversationDialog
        open={renaming !== null}
        initialTitle={renaming?.title ?? null}
        onClose={() => setRenaming(null)}
        onRename={async (title) => {
          if (!renaming) return;
          await list.rename(renaming.id, title);
          if (renaming.id === id) void detail.refresh();
        }}
      />
      <DeleteConversationDialog
        open={deleting !== null}
        title={deleting?.title ?? null}
        onClose={() => setDeleting(null)}
        onDelete={async () => {
          if (!deleting) return;
          await list.remove(deleting.id);
          if (createdButUnsent.current?.id === deleting.id) createdButUnsent.current = null;
          if (deleting.id === id) navigate('/ask', { replace: true });
        }}
      />
    </Box>
  );
}
