/**
 * `/graph/entities/:id` — "everything about Joe" (#373, epic #347; spec §13).
 *
 * ONE SCROLLING COLUMN (`maxWidth: 960`), sections in a fixed order:
 *
 *   1. `EntityHeader` — type, the page's <h1>, aliases, dates, counts, Edit and
 *      (Person + `graph:write`) "Forget this person…".
 *   2. `EntityBriefCard` — the stored digest + the five cited sections (#372).
 *   3. Connections — #374's `NeighborhoodWidget` canvas, then the text list
 *      (the accessible form of the same slice, and all there is without WebGL).
 *   4. Timeline — with the opt-in sensitive-facts switch.
 *   5. Mentions.
 *
 * ASK (#381). With connected knowledge on (`GET /api/ai/config`'s
 * `graphEnabled`), the header's `actions` slot carries "Ask about {label}",
 * opening `EntityAskPanel` — a drawer over the page, scoped to this entity.
 * Its state lives in the URL: `?ask=1` open on a new conversation,
 * `?ask=<conversationId>` on a saved one. Opening PUSHES one history entry
 * (so the back gesture closes the panel), every change after that REPLACES
 * it, and a reload reopens the same conversation.
 *
 * NOT TABS: these are one destination's sequential sections, not parallel
 * content (Settings UI Pattern rule 2's reasoning), and a scrolling page keeps
 * every one reachable on a phone.
 *
 * A 404 is its own state with no Retry and no hint of WHY — the API answers
 * "not yours" and "doesn't exist" identically (#370), and so does this page.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { useCallback, useState } from 'react';
import { Link as RouterLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { EntityAskButton, EntityAskPanel } from '../components/ask/EntityAskPanel';

import { EntityBriefCard } from '../components/graph/EntityBriefCard';
import { EntityConnectionsList } from '../components/graph/EntityConnectionsList';
import { EntityEditDialog } from '../components/graph/EntityEditDialog';
import { EntityHeader } from '../components/graph/EntityHeader';
import { EntityMentionsList } from '../components/graph/EntityMentionsList';
import { EntityPageSkeleton } from '../components/graph/EntityPageSkeleton';
import { EntityTimeline } from '../components/graph/EntityTimeline';
import { ForgetPersonDialog } from '../components/graph/ForgetPersonDialog';
import { NeighborhoodWidget } from '../components/graph/NeighborhoodWidget';
import { GRAPH_NOT_FOUND_MESSAGE } from '../hooks/graphHookUtils';
import { useGraphBrief } from '../hooks/useGraphBrief';
import { useGraphEntity } from '../hooks/useGraphEntity';
import { useGraphOntology } from '../hooks/useGraphAttributeDefs';
import { useAiConfig } from '../hooks/useAiConfig';
import { usePermissions } from '../hooks/usePermissions';
import { entityTypeLabel } from '../utils/graphDisplay';
import type { GraphIndexLocationState } from './GraphIndexPage';

/** The entity page's search parameter for the Ask panel (#381). */
export const ENTITY_ASK_PARAM = 'ask';
/** `?ask=1`: the panel is open on a new conversation. */
export const ENTITY_ASK_NEW = '1';

/** Router state marking a history entry this page pushed to open the panel. */
interface EntityAskLocationState {
  askPanelPushed?: boolean;
}

export default function GraphEntityPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('graph:write');

  const entity = useGraphEntity(id);
  const brief = useGraphBrief(id);
  const { ontology } = useGraphOntology();

  const [editOpen, setEditOpen] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);

  // --- Ask (#381) -------------------------------------------------------------
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const ai = useAiConfig();
  // Only an explicit `true` offers the action: an older server that does not
  // say, or a failed read, is not a reason to advertise a feature.
  const askEnabled = ai.config?.graphEnabled === true;
  const askParam = searchParams.get(ENTITY_ASK_PARAM);
  const askConversationId = askParam && askParam !== ENTITY_ASK_NEW ? askParam : null;
  const askPushed = Boolean((location.state as EntityAskLocationState | null)?.askPanelPushed);

  const openAsk = useCallback(() => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set(ENTITY_ASK_PARAM, ENTITY_ASK_NEW);
        return next;
      },
      { state: { askPanelPushed: true } satisfies EntityAskLocationState },
    );
  }, [setSearchParams]);

  const changeAskConversation = useCallback(
    (conversationId: string | null) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set(ENTITY_ASK_PARAM, conversationId ?? ENTITY_ASK_NEW);
          return next;
        },
        { replace: true, state: location.state },
      );
    },
    [location.state, setSearchParams],
  );

  const closeAsk = useCallback(() => {
    // Undo our own push, so "back" afterwards leaves the page rather than
    // reopening the panel; a panel opened from a link or a reload has no
    // entry of ours to pop, so it just drops the parameter.
    if (askPushed) {
      navigate(-1);
      return;
    }
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(ENTITY_ASK_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [askPushed, navigate, setSearchParams]);

  let content;
  if (entity.isLoading) {
    content = <EntityPageSkeleton />;
  } else if (entity.notFound) {
    content = (
      <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="h5" component="h1" gutterBottom>
          Not found
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {GRAPH_NOT_FOUND_MESSAGE}.
        </Typography>
        <Button component={RouterLink} to="/graph" variant="contained">
          Back to Knowledge
        </Button>
      </Paper>
    );
  } else if (!entity.data) {
    content = (
      <>
        <Typography variant="h5" component="h1" sx={{ mb: 2 }}>
          Knowledge
        </Typography>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void entity.refresh()}>
              Retry
            </Button>
          }
        >
          {entity.error ?? 'Failed to load this page'}
        </Alert>
      </>
    );
  } else {
    const detail = entity.data;
    content = (
      <>
        <EntityHeader
          entity={detail}
          typeLabel={entityTypeLabel(detail.type, ontology)}
          canEdit={canWrite}
          onEdit={() => setEditOpen(true)}
          onForget={() => setForgetOpen(true)}
          actions={askEnabled ? <EntityAskButton label={detail.label} onClick={openAsk} /> : undefined}
        />

        {brief.data ? (
          <EntityBriefCard brief={brief.data} ontology={ontology} onRefresh={() => void brief.refresh()} />
        ) : brief.error ? (
          <Alert
            severity="error"
            sx={{ mb: 3 }}
            action={
              <Button color="inherit" size="small" onClick={() => void brief.refresh()}>
                Retry
              </Button>
            }
          >
            {brief.error}
          </Alert>
        ) : brief.isLoading ? (
          <Skeleton
            variant="rounded"
            height={220}
            sx={{ mb: 3 }}
            role="status"
            aria-label="Loading the brief"
          />
        ) : null}

        <NeighborhoodWidget entityId={detail.id} entityLabel={detail.label} />
        <EntityConnectionsList entityId={detail.id} entityLabel={detail.label} ontology={ontology} />
        <EntityTimeline entityId={detail.id} ontology={ontology} />
        <EntityMentionsList entityId={detail.id} />

        {askEnabled && (
          <EntityAskPanel
            open={askParam !== null}
            onClose={closeAsk}
            entity={{ id: detail.id, label: detail.label, type: detail.type }}
            conversationId={askConversationId}
            onConversationChange={changeAskConversation}
            config={ai.config}
          />
        )}

        {canWrite && (
          <EntityEditDialog
            open={editOpen}
            entity={detail}
            ontology={ontology}
            onClose={() => setEditOpen(false)}
            onSaved={() => {
              setEditOpen(false);
              void entity.refresh();
              void brief.refresh();
            }}
          />
        )}
        {canWrite && detail.type === 'Person' && (
          <ForgetPersonDialog
            open={forgetOpen}
            entityId={detail.id}
            label={detail.label}
            onClose={() => setForgetOpen(false)}
            onForgotten={() => {
              setForgetOpen(false);
              const state: GraphIndexLocationState = {
                snackbar: `Forgetting ${detail.label}… this takes a few seconds`,
              };
              navigate('/graph', { state });
            }}
          />
        )}
      </>
    );
  }

  return <Box sx={{ maxWidth: 960, mx: 'auto', py: { xs: 2, sm: 3 }, minWidth: 0 }}>{content}</Box>;
}
