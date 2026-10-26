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
 *      On a Person with `graph:write`, the list offers the manual relation
 *      edits (#586): "Set manager", "Set employer", "Add role", and Remove.
 *   4. Timeline — with the opt-in sensitive-facts switch.
 *   5. Mentions.
 *   6. Merged from (#765) — the entities merged into this one, with Undo.
 *
 * MERGE (#765). "Merge into…" in the header's menu (`graph:write`) opens
 * `MergeEntityDialog`. After a merge the page REPLACES its history entry with
 * the survivor's page (the merged one is a tombstone now) and shows "Merged"
 * with Undo; the snackbar travels in router state (`EntityMergeLocationState`)
 * so it survives the route change. Undo reverses the merge and opens the
 * restored entity. A tombstone's own URL (`mergedIntoId` set) redirects,
 * replacing, to its survivor.
 *
 * ASK (#381). With connected knowledge on (`host.features().graphEnabled`), the
 * header's `actions` slot carries the host's Ask action, opening the host's Ask
 * panel — a drawer over the page, scoped to this entity.
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
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { EntityBriefCard } from '../components/EntityBriefCard.js';
import { EntityConnectionsList } from '../components/EntityConnectionsList.js';
import { EntityEditDialog } from '../components/EntityEditDialog.js';
import { EntityHeader } from '../components/EntityHeader.js';
import { EntityMentionsList } from '../components/EntityMentionsList.js';
import { EntityMergedFromList } from '../components/EntityMergedFromList.js';
import { MergeEntityDialog } from '../components/MergeEntityDialog.js';
import type { MergeOutcome } from '../components/MergeEntityDialog.js';
import { EntityPageSkeleton } from '../components/EntityPageSkeleton.js';
import { EntityTimeline } from '../components/EntityTimeline.js';
import { ForgetPersonDialog } from '../components/ForgetPersonDialog.js';
import { NeighborhoodWidget } from '../components/NeighborhoodWidget.js';
import { GRAPH_NOT_FOUND_MESSAGE } from '../../headless/hooks/graphHookUtils.js';
import { useGraphBrief } from '../../headless/hooks/useGraphBrief.js';
import { useGraphEntity } from '../../headless/hooks/useGraphEntity.js';
import { useEntityMergeActions, useEntityMerges } from '../../headless/hooks/useEntityMerges.js';
import type { EntityMergeRow } from '../../headless/clients/graph.js';
import { useGraphEffectiveOntology } from '../../headless/hooks/useGraphAttributeDefs.js';
import { entityTypeLabel } from '../../headless/utils/graphDisplay.js';
import type { GraphIndexLocationState } from './GraphIndexPage.js';

import { useHasPermission, useKvoxHost } from '../../../core/headless/index.js';
import type { ComponentType } from 'react';

/**
 * The entity page's search parameter for the Ask panel (#381).
 *
 * @stability experimental
 */
export const ENTITY_ASK_PARAM = 'ask';
/**
 * `?ask=1`: the panel is open on a new conversation.
 *
 * @stability experimental
 */
export const ENTITY_ASK_NEW = '1';

/** Router state marking a history entry this page pushed to open the panel. */
interface EntityAskLocationState {
  askPanelPushed?: boolean;
}

/** The one-shot snackbar a merge or an undo hands to the next entity page (#765). */
type EntityMergeSnack =
  | { kind: 'merged'; mergeId: string; mergedLabel: string }
  | { kind: 'message'; text: string };

/** Router state carrying {@link EntityMergeSnack} across the navigation. */
interface EntityMergeLocationState {
  mergeSnack?: EntityMergeSnack;
}

/**
 * The props of the `AskButton` slot of {@link GraphEntityPageSlots}.
 *
 * @stability experimental
 */
export interface GraphEntityAskButtonProps {
  /** The entity the page shows. */
  entityId: string;
  /** The entity's label. */
  entityLabel: string;
  /** Opens the Ask panel (the page owns the `?ask=` parameter). */
  onClick: () => void;
}

/**
 * The props of the `AskPanel` slot of {@link GraphEntityPageSlots}.
 *
 * @remarks
 * The page keeps the open state and the conversation in its `?ask=` search
 * parameter, so a reload reopens the same conversation and the back gesture
 * closes the panel; the slot only draws the panel and reports changes.
 *
 * @stability experimental
 */
export interface GraphEntityAskPanelProps {
  /** The entity the page shows. */
  entityId: string;
  /** The entity's label. */
  entityLabel: string;
  /** The entity's type key (`Person`, `Organization`, ...). */
  entityType: string;
  /** Whether the panel is open. */
  open: boolean;
  /** Closes the panel. */
  onClose: () => void;
  /** The conversation `?ask=` names, or `null` for a new one. */
  conversationId: string | null;
  /** Reports the conversation the panel switched to (`null`: a new one). */
  onConversationChange: (conversationId: string | null) => void;
  /**
   * The graph selection the question starts from (the explorer's "Ask about this selection", GIC-17).
   * Sent with every question the panel asks. They are starting handles only: the agent still retrieves evidence through its tools.
   */
  scope?: GraphEntityAskScope;
}

/**
 * The graph selection an Ask question starts from.
 *
 * @stability experimental
 */
export interface GraphEntityAskScope {
  /** Entities the question is about. */
  entityIds: string[];
  /** Evidence ids of the selected edge or path; may be empty. */
  evidenceIds: string[];
}

/**
 * The slots of {@link GraphEntityPage}: the "Ask about this entity" action and
 * its panel belong to the ask slice, which depends on this one, so the host
 * supplies them.
 *
 * @remarks
 * Both are optional and render only while `host.features().graphEnabled` is
 * `true`. Without them the page has no Ask action.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export interface GraphEntityPageSlots {
  /** The action in the entity header. */
  AskButton?: ComponentType<GraphEntityAskButtonProps>;
  /** The panel the action opens. */
  AskPanel?: ComponentType<GraphEntityAskPanelProps>;
}

/**
 * The props of {@link GraphEntityPage}.
 *
 * @stability experimental
 */
export interface GraphEntityPageProps {
  /** What the host adds to the page (the Ask action and panel). */
  slots?: GraphEntityPageSlots;
}

/**
 * `/graph/entities/:id`: one entity's page.
 *
 * @param props - See {@link GraphEntityPageProps}.
 * @returns The page.
 *
 * @stability experimental
 */
export function GraphEntityPage({ slots }: GraphEntityPageProps = {}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const canWrite = useHasPermission('graph:write');

  const entity = useGraphEntity(id);
  const brief = useGraphBrief(id);
  const { ontology } = useGraphEffectiveOntology();

  const merges = useEntityMerges(id);
  const mergeActions = useEntityMergeActions();

  const [editOpen, setEditOpen] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeSnack, setMergeSnack] = useState<EntityMergeSnack | null>(null);
  // #767: the merge worked but "Also add these names to my synonyms" did not.
  const [synonymsNotice, setSynonymsNotice] = useState<string | null>(null);
  // Bumped by a manual relation edit (#586): the neighbourhood canvas re-reads.
  const [relationsVersion, setRelationsVersion] = useState(0);

  // --- Ask (#381) -------------------------------------------------------------
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  // Only an explicit `true` offers the action: an older server that does not
  // say, or a failed read, is not a reason to advertise a feature.
  const askEnabled = useKvoxHost().features().graphEnabled === true;
  const AskButton = slots?.AskButton;
  const AskPanel = slots?.AskPanel;
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

  // --- Merge (#765) -----------------------------------------------------------
  // A tombstone's URL (an old link, a bookmark) goes to the survivor, replacing.
  const mergedIntoId = entity.data?.mergedIntoId ?? null;
  useEffect(() => {
    if (mergedIntoId) navigate(`/graph/entities/${mergedIntoId}`, { replace: true });
  }, [mergedIntoId, navigate]);

  // Consume the one-shot snackbar a merge or undo handed over, so a reload or
  // Back does not show it again.
  const handedSnack = (location.state as EntityMergeLocationState | null)?.mergeSnack;
  useEffect(() => {
    if (!handedSnack) return;
    setMergeSnack(handedSnack);
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
  }, [handedSnack, location.pathname, location.search, navigate]);

  const goToEntity = useCallback(
    (entityId: string, snack: EntityMergeSnack, replace: boolean) => {
      const state: EntityMergeLocationState = { mergeSnack: snack };
      navigate(`/graph/entities/${entityId}`, { replace, state });
    },
    [navigate],
  );

  const reloadAll = useCallback(() => {
    void entity.refresh();
    void brief.refresh();
    void merges.refresh();
    setRelationsVersion((n) => n + 1);
  }, [brief, entity, merges]);

  const onMerged = useCallback(
    ({ result, merged, synonymsError }: MergeOutcome) => {
      setMergeOpen(false);
      if (synonymsError) setSynonymsNotice(synonymsError);
      const snack: EntityMergeSnack = { kind: 'merged', mergeId: result.merge.id, mergedLabel: merged.label };
      if (result.merge.survivorId === id) {
        // This page's entity survived: stay, and read it again.
        setMergeSnack(snack);
        reloadAll();
      } else {
        // This page's entity is a tombstone now: replace its history entry.
        goToEntity(result.merge.survivorId, snack, true);
      }
    },
    [goToEntity, id, reloadAll],
  );

  const undoMerge = useCallback(
    async (mergeId: string) => {
      setMergeSnack(null);
      const reversed = await mergeActions.reverse(mergeId);
      if (!reversed) return;
      goToEntity(reversed.restored.id, { kind: 'message', text: `Merge undone. “${reversed.restored.label}” is back.` }, false);
    },
    [goToEntity, mergeActions],
  );

  const undoListedMerge = useCallback(
    async (row: EntityMergeRow) => {
      const reversed = await mergeActions.reverse(row.mergeId);
      if (!reversed) return;
      setMergeSnack({ kind: 'message', text: `Merge undone. “${reversed.restored.label}” is back.` });
      reloadAll();
    },
    [mergeActions, reloadAll],
  );

  let content;
  if (entity.isLoading || mergedIntoId) {
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
          onMerge={() => setMergeOpen(true)}
          actions={
            askEnabled && AskButton ? (
              <AskButton entityId={detail.id} entityLabel={detail.label} onClick={openAsk} />
            ) : undefined
          }
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

        <NeighborhoodWidget key={`${detail.id}:${relationsVersion}`} entityId={detail.id} entityLabel={detail.label} />
        <EntityConnectionsList
          entityId={detail.id}
          entityLabel={detail.label}
          ontology={ontology}
          entityType={detail.type}
          canEdit={canWrite}
          onChanged={() => {
            setRelationsVersion((n) => n + 1);
            void brief.refresh();
          }}
        />
        <EntityTimeline entityId={detail.id} ontology={ontology} />
        <EntityMentionsList entityId={detail.id} />
        <EntityMergedFromList
          merges={merges.data}
          canUndo={canWrite}
          busy={mergeActions.isSaving}
          onUndo={(row) => void undoListedMerge(row)}
        />

        {askEnabled && AskPanel && (
          <AskPanel
            open={askParam !== null}
            onClose={closeAsk}
            entityId={detail.id}
            entityLabel={detail.label}
            entityType={detail.type}
            conversationId={askConversationId}
            onConversationChange={changeAskConversation}
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
        {canWrite && (
          <MergeEntityDialog
            open={mergeOpen}
            entity={detail}
            typeLabel={entityTypeLabel(detail.type, ontology)}
            onClose={() => setMergeOpen(false)}
            onMerged={onMerged}
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

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto', py: { xs: 2, sm: 3 }, minWidth: 0 }}>
      {content}
      <Snackbar
        open={Boolean(mergeSnack)}
        autoHideDuration={mergeSnack?.kind === 'merged' ? 10000 : 6000}
        onClose={(_event, reason) => {
          if (reason !== 'clickaway') setMergeSnack(null);
        }}
        message={mergeSnack ? (mergeSnack.kind === 'merged' ? 'Merged' : mergeSnack.text) : undefined}
        action={
          mergeSnack?.kind === 'merged' ? (
            <Button
              color="inherit"
              size="small"
              disabled={mergeActions.isSaving}
              onClick={() => void undoMerge(mergeSnack.mergeId)}
            >
              Undo
            </Button>
          ) : undefined
        }
      />
      <Snackbar
        open={synonymsNotice !== null}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        autoHideDuration={8000}
        onClose={(_event, reason) => {
          if (reason !== 'clickaway') setSynonymsNotice(null);
        }}
      >
        <Alert severity="warning" onClose={() => setSynonymsNotice(null)} sx={{ width: '100%' }}>
          {synonymsNotice}
        </Alert>
      </Snackbar>
      <Snackbar
        open={Boolean(mergeActions.error)}
        autoHideDuration={8000}
        onClose={(_event, reason) => {
          if (reason !== 'clickaway') mergeActions.clearError();
        }}
      >
        <Alert severity="error" onClose={mergeActions.clearError} sx={{ width: '100%' }}>
          {mergeActions.error}
        </Alert>
      </Snackbar>
    </Box>
  );
}
