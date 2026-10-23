/**
 * The knowledge-first cards of Home (#721, epic #708): Ask, the Review Queue,
 * the note libraries, the graph and the recent imports.
 *
 * KVox Desktop's value is the knowledge graph and Ask over notes the person
 * imports in bulk, so its Home leads with them. Each card is one listed
 * section (`ask`, `reviewQueue`, `libraries`, `graphStats`, `recentImports`);
 * `KvoxHomePage` decides which to mount from the viewer's permissions and the
 * host's `graph` switch, and lays them out in {@link KnowledgeHomeGrid}.
 *
 * A CARD NEVER SHOWS AN ERROR BOX. Home is the landing page: a read that
 * fails renders the card as nothing (the libraries card included), the rule
 * every Home section follows.
 *
 * No breakpoint read: the grid's columns are a `sx` breakpoint object.
 */

import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import SendIcon from '@mui/icons-material/Send';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import type { ChipProps } from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { NoteImportBatch, NoteImportBatchStatus, NoteLibrary } from '@marinoscar/kvox-contract/notes';
import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import {
  ASK_CONTENT_MAX_CHARS,
  askSendErrorCopy,
  createAskConversation,
  postAskMessage,
} from '../../../ask/headless/index.js';
import type { AskConversationDetail } from '../../../ask/headless/index.js';
import { formatRelativeTime, useKvoxHost } from '../../../core/headless/index.js';
import { countPhrase, useGraphEntities, useGraphOverview, useReviewQueue } from '../../../graph/headless/index.js';
import { entityPath } from '../../../graph/ui/index.js';
import { summarizeLibraries } from '../../headless/imports.js';
import type { UseHomeImportsResult } from '../../headless/imports.js';

/**
 * How many recently changed entities the graph card lists.
 *
 * @stability experimental
 */
export const HOME_GRAPH_RECENT_LIMIT = 5;

/** The frame every knowledge card shares: a titled, outlined section. */
function HomeCard({
  title,
  action,
  children,
  wide = false,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const headingId = useId();
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      sx={{ p: 2, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, gridColumn: wide ? '1 / -1' : undefined }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', minWidth: 0 }}>
        <Typography id={headingId} variant="h6" component="h2" sx={{ fontWeight: 600 }} noWrap>
          {title}
        </Typography>
        {action}
      </Stack>
      {children}
    </Paper>
  );
}

function CardSkeleton({ label }: { label: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }} aria-busy="true" aria-label={label}>
      <Skeleton width="40%" height={32} />
      <Skeleton width="70%" />
    </Paper>
  );
}

/**
 * The layout of the knowledge cards: one column on a phone, two from `md`; the
 * Ask box spans the row.
 *
 * @param props - The cards.
 * @returns The grid, or nothing when it has no card.
 *
 * @stability experimental
 */
export function KnowledgeHomeGrid({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
        gap: 2,
        mb: { xs: 3, sm: 4 },
      }}
    >
      {children}
    </Box>
  );
}

// =============================================================================
// Ask
// =============================================================================

/**
 * What the Ask page reads from the navigation state: the conversation as it
 * stands after the first question (`AskLocationState` of the ask slice).
 */
interface AskSeedState {
  askSeed: AskConversationDetail;
}

/**
 * Home's question box. Sending creates a conversation, asks the question and
 * opens it in Ask (`host.links.conversation`), where the answer streams in; a
 * refused question keeps its text and says why (the ask slice's own copy).
 *
 * @returns The card.
 *
 * @stability experimental
 */
export function HomeAskCard() {
  const host = useKvoxHost();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const question = text.trim();
  const canSend = !sending && question.length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    setSending(true);
    setSendError(null);
    try {
      const created = await createAskConversation(host);
      const result = await postAskMessage(host, created.id, { content: question });
      const askSeed: AskConversationDetail = {
        id: created.id,
        title: created.title ?? question.slice(0, 80),
        scopeEntity: created.scopeEntity,
        running: true,
        createdAt: created.createdAt,
        updatedAt: result.userMessage.createdAt,
        messages: [result.userMessage, result.assistantMessage],
        hasEarlier: false,
      };
      navigate(host.links.conversation(created.id), { state: { askSeed } satisfies AskSeedState });
    } catch (err) {
      setSendError(err);
      setSending(false);
    }
  };

  const copy = sendError ? askSendErrorCopy(sendError) : null;

  return (
    <HomeCard
      title="Ask your knowledge"
      wide
      action={
        <Button size="small" component={RouterLink} to="/ask" endIcon={<ChevronRightIcon />}>
          Conversations
        </Button>
      }
    >
      {copy && (
        <Alert severity="warning" onClose={() => setSendError(null)}>
          {copy.message}
          {copy.link && (
            <>
              {' '}
              <Link component={RouterLink} to={copy.link.to}>
                {copy.link.label}
              </Link>
            </>
          )}
        </Alert>
      )}
      <Box component="form" onSubmit={(event: FormEvent) => void submit(event)} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <TextField
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Ask about the people, projects and decisions in your notes…"
          fullWidth
          size="small"
          disabled={sending}
          slotProps={{ htmlInput: { maxLength: ASK_CONTENT_MAX_CHARS, 'aria-label': 'Your question' } }}
        />
        <IconButton type="submit" color="primary" aria-label="Ask" disabled={!canSend}>
          {sending ? <CircularProgress size={20} aria-hidden /> : <SendIcon />}
        </IconButton>
      </Box>
    </HomeCard>
  );
}

// =============================================================================
// Review Queue
// =============================================================================

/**
 * Drafts waiting for review and the rows a batch commit would accept, with a
 * way into the Review Queue. Nothing on a failed read.
 *
 * @returns The card, or nothing.
 *
 * @stability experimental
 */
export function ReviewQueueHomeCard() {
  const { queue, isLoading, error } = useReviewQueue();
  if (isLoading && !queue) return <CardSkeleton label="Loading the review queue" />;
  if (error || !queue) return null;
  const { totals } = queue;
  return (
    <HomeCard title="Review Queue">
      {totals.proposals === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Nothing to review — your graph is up to date.
        </Typography>
      ) : (
        <>
          <Typography variant="body1" component="p" sx={{ fontWeight: 500 }}>
            {`${countPhrase(totals.proposals, 'draft', 'drafts')} waiting${queue.truncated ? ' (or more)' : ''}`}
          </Typography>
          <Typography variant="body2" color="text.secondary" component="p">
            {`${countPhrase(totals.safe, 'safe row', 'safe rows')} · ${totals.waiting.toLocaleString()} need you`}
          </Typography>
        </>
      )}
      <Box sx={{ mt: 'auto' }}>
        <Button
          variant={totals.proposals > 0 ? 'contained' : 'outlined'}
          component={RouterLink}
          to="/graph/review-queue"
          sx={{ minHeight: 44 }}
        >
          Open Review Queue
        </Button>
      </Box>
    </HomeCard>
  );
}

// =============================================================================
// Libraries
// =============================================================================

/**
 * The note libraries at a glance: how many, files imported, failures and the
 * last sync, or "Add your notes folder" when there is none.
 *
 * @param props - The libraries read Home already made.
 * @returns The card, or nothing when the read failed.
 *
 * @stability experimental
 */
export function LibrariesHomeCard({ imports }: { imports: UseHomeImportsResult }) {
  if (imports.isLoading && !imports.libraries) return <CardSkeleton label="Loading your libraries" />;
  if (imports.librariesFailed || !imports.libraries) return null;
  const libraries: NoteLibrary[] = imports.libraries;

  if (libraries.length === 0) {
    return (
      <HomeCard title="Libraries">
        <Typography variant="body2" color="text.secondary">
          Bring in the notes you already have. Every file becomes a note, and what it mentions joins your graph.
        </Typography>
        <Box sx={{ mt: 'auto' }}>
          <Button variant="contained" component={RouterLink} to="/notes/libraries" sx={{ minHeight: 44 }}>
            Add your notes folder
          </Button>
        </Box>
      </HomeCard>
    );
  }

  const summary = summarizeLibraries(libraries);
  return (
    <HomeCard title="Libraries">
      <Typography variant="body1" component="p" sx={{ fontWeight: 500 }}>
        {`${countPhrase(summary.libraries, 'library', 'libraries')} · ${countPhrase(summary.imported, 'file imported', 'files imported')}`}
      </Typography>
      <Typography variant="body2" color="text.secondary" component="p">
        {[
          ...(summary.failed > 0 ? [countPhrase(summary.failed, 'failure', 'failures')] : []),
          summary.lastSync ? `Last sync ${formatRelativeTime(summary.lastSync)}` : 'Not synced yet',
        ].join(' · ')}
      </Typography>
      <Box sx={{ mt: 'auto' }}>
        <Button variant="outlined" component={RouterLink} to="/notes/libraries" sx={{ minHeight: 44 }}>
          Open Libraries
        </Button>
      </Box>
    </HomeCard>
  );
}

// =============================================================================
// Graph
// =============================================================================

/**
 * The graph's size (entities and relations, from the overview snapshot) and
 * the entities that changed last. Nothing when both reads failed.
 *
 * @returns The card, or nothing.
 *
 * @stability experimental
 */
export function GraphStatsHomeCard() {
  const overview = useGraphOverview();
  const recent = useGraphEntities({ sort: 'updated', limit: HOME_GRAPH_RECENT_LIMIT });

  if (overview.isLoading && recent.isLoading) return <CardSkeleton label="Loading your graph" />;
  const snapshot = overview.error ? null : overview.overview;
  const entities = recent.error ? [] : recent.data.slice(0, HOME_GRAPH_RECENT_LIMIT);
  if (!snapshot && entities.length === 0 && (overview.error || recent.error)) return null;

  return (
    <HomeCard
      title="Your graph"
      action={
        <Button size="small" component={RouterLink} to="/graph/explore" endIcon={<ChevronRightIcon />}>
          Explore
        </Button>
      }
    >
      {snapshot && (
        <Typography variant="body1" component="p" sx={{ fontWeight: 500 }}>
          {`${countPhrase(snapshot.nodeCount, 'entity', 'entities')} · ${countPhrase(snapshot.edgeCount, 'relation', 'relations')}`}
        </Typography>
      )}
      {entities.length > 0 ? (
        <Box component="ul" aria-label="Recently changed" sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {entities.map((entity) => (
            <Box component="li" key={entity.id} sx={{ py: 0.25, minWidth: 0 }}>
              <Link component={RouterLink} to={entityPath(entity.id)} variant="body2" noWrap sx={{ display: 'block' }}>
                {entity.label}
              </Link>
            </Box>
          ))}
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Nothing in your graph yet. Review what the AI found in your notes to add to it.
        </Typography>
      )}
    </HomeCard>
  );
}

// =============================================================================
// Recent imports
// =============================================================================

const BATCH_STATUS: Record<NoteImportBatchStatus, { label: string; color: ChipProps['color'] }> = {
  scanning: { label: 'Scanning', color: 'info' },
  running: { label: 'Importing', color: 'info' },
  completed: { label: 'Done', color: 'success' },
  completed_with_errors: { label: 'Some failed', color: 'warning' },
  cancelled: { label: 'Cancelled', color: 'default' },
};

function batchLabel(batch: NoteImportBatch, libraries: readonly NoteLibrary[] | null): string {
  const library = batch.libraryId ? libraries?.find((l) => l.id === batch.libraryId) : undefined;
  if (library) return library.name;
  const at = new Date(batch.createdAt);
  if (Number.isNaN(at.getTime())) return 'Import';
  return `Import of ${at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * The latest import batches with their status, each linking to its page.
 * Nothing when there is no batch or the read failed.
 *
 * @param props - The batches read Home already made.
 * @returns The card, or nothing.
 *
 * @stability experimental
 */
export function RecentImportsHomeCard({ imports }: { imports: UseHomeImportsResult }) {
  if (imports.isLoading && !imports.batches) return <CardSkeleton label="Loading your recent imports" />;
  if (imports.batchesFailed || !imports.batches || imports.batches.length === 0) return null;
  return (
    <HomeCard title="Recent imports">
      <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {imports.batches.map((batch) => {
          const status = BATCH_STATUS[batch.status] ?? { label: batch.status, color: 'default' as const };
          const counts = batch.counts;
          return (
            <Box
              component="li"
              key={batch.id}
              sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5, minWidth: 0 }}
            >
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Link
                  component={RouterLink}
                  to={`/notes/import-batches/${encodeURIComponent(batch.id)}`}
                  variant="body2"
                  noWrap
                  sx={{ display: 'block' }}
                >
                  {batchLabel(batch, imports.libraries)}
                </Link>
                {counts && (
                  <Typography variant="caption" color="text.secondary" noWrap component="p">
                    {`${(counts.imported ?? 0).toLocaleString()} imported${counts.failed ? ` · ${counts.failed.toLocaleString()} failed` : ''}`}
                  </Typography>
                )}
              </Box>
              <Chip size="small" label={status.label} color={status.color} variant="outlined" />
            </Box>
          );
        })}
      </Box>
    </HomeCard>
  );
}
