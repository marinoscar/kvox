/**
 * What the web edition adds to the notes pages (issue #502, epic #498).
 *
 * The notes slice imports only `core`, `transcripts` and `search`. The
 * connected-knowledge features of the note page (the review sheet over a note's
 * proposal, "Add to graph" on a selection, the extract dialog, the `?review=1`
 * deep link) and the entity hits above library search belong to the graph UI,
 * which still lives in this app until issue 7.5, so they are filled in here.
 *
 * ONE PROVIDER, FOUR SLOTS. The header button, the sheet, the selection action
 * and the extract dialog all act on the same proposal and the same "is the sheet
 * open" flag, so `NotePageProvider` holds that state once for the page and the
 * slots read it. It also reads `GET /api/ai-tasks/config` ONCE and hands it to
 * the page as its AI access, so the page makes the request it always made and no
 * second one.
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePermissions } from '@marinoscar/platform-web/identity/headless';
import type {
  NoteHeaderActionsProps,
  NotePageProviderProps,
  NotePageSlots,
  NoteProposalActionsProps,
  NoteSelectionActionsProps,
  NotesAiAccess,
  NotesAiState,
  NotesLibrarySlots,
} from '@marinoscar/kvox-web/notes/ui';

import { AiKeyRequired } from '../components/ai/AiKeyRequired';
import { EntitySearchHits } from '../components/graph/EntitySearchHits';
import { GraphReviewButton } from '../components/graph/GraphReviewButton';
import { ExtractDialog } from '../components/graph/guide/ExtractDialog';
import { GuidanceSummary } from '../components/graph/guide/GuidanceSummary';
import { userDecisionCount } from '../components/graph/guide/guidance';
import {
  ProposalReviewSheet,
  REVIEW_SHEET_WIDTH,
} from '../components/graph/review/ProposalReviewSheet';
import { GraphSelectionAdd } from '../components/graph/selection/GraphSelectionAdd';
import { resolveNoteSelection } from '../components/graph/selection/resolvers';
import { useAiTasksConfig } from '../hooks/useAiTasksConfig';
import { useGraphProposal } from '../hooks/useGraphProposal';
import { useNotesAiState } from './noteAiAccess';

type ExtractMode = 'extract' | 're-extract';

/** What the page-wide provider shares with the slots. */
interface NotePageGraphState {
  /** The AI availability, read once for the page. */
  ai: NotesAiState;
  /**
   * The proposal review sheet (#367). Visible only to `graph:read` on a
   * deployment with connected knowledge switched on; `graphEnabled` undefined
   * (an older API) reads as "not on", so the page is unchanged.
   */
  graphVisible: boolean;
  /** `graph:write`: the extract dialog and "Add to graph". */
  canWriteGraph: boolean;
  /** The proposal, read here so the button's badge and the sheet share one request and one poll. */
  proposal: ReturnType<typeof useGraphProposal>;
  reviewOpen: boolean;
  setReviewOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  /** #368: the extract / re-extract dialog, mounted only while open. */
  extractMode: ExtractMode | null;
  setExtractMode: (mode: ExtractMode | null) => void;
  /** #368: the row "Add to graph" just created, scrolled to in the sheet. */
  focusItemId: string | null;
  setFocusItemId: (id: string | null) => void;
}

const NotePageGraphContext = createContext<NotePageGraphState | null>(null);

function useNotePageGraph(): NotePageGraphState | null {
  return useContext(NotePageGraphContext);
}

/** Wraps the note page: holds the graph state once and reads the AI config once. */
function NotePageProvider({ noteId, children }: NotePageProviderProps): ReactNode {
  const { hasPermission } = usePermissions();
  const aiRead = useAiTasksConfig();
  const ai = useNotesAiState(aiRead);
  const graphVisible = hasPermission('graph:read') && aiRead.config?.graphEnabled === true;
  const canWriteGraph = hasPermission('graph:write');
  const proposal = useGraphProposal(
    { noteId: noteId ?? '' },
    { enabled: graphVisible && Boolean(noteId) },
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const [extractMode, setExtractMode] = useState<ExtractMode | null>(null);
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const reviewRequested = searchParams.get('review') === '1';
  const isAiLoading = aiRead.isLoading;

  /** `?review=1` opens the sheet once, then leaves the URL (`replace`). */
  useEffect(() => {
    if (!reviewRequested || isAiLoading) return;
    if (graphVisible) setReviewOpen(true);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('review');
        return next;
      },
      { replace: true },
    );
  }, [graphVisible, isAiLoading, reviewRequested, setSearchParams]);

  // `/notes/a` -> `/notes/b` must not carry a's open sheet over to b.
  useEffect(() => {
    setReviewOpen(false);
  }, [noteId]);

  const value = useMemo<NotePageGraphState>(
    () => ({
      ai,
      graphVisible,
      canWriteGraph,
      proposal,
      reviewOpen,
      setReviewOpen,
      extractMode,
      setExtractMode,
      focusItemId,
      setFocusItemId,
    }),
    [ai, canWriteGraph, extractMode, focusItemId, graphVisible, proposal, reviewOpen],
  );

  return <NotePageGraphContext.Provider value={value}>{children}</NotePageGraphContext.Provider>;
}

/** At `lg` and up the note moves aside for the review sheet; below it the sheet overlays. */
function useAsideWidth(): number {
  const graph = useNotePageGraph();
  return graph?.graphVisible && graph.reviewOpen ? REVIEW_SHEET_WIDTH : 0;
}

/** The review button in the page header (#367). */
function HeaderActions(_props: NoteHeaderActionsProps) {
  const graph = useNotePageGraph();
  if (!graph?.graphVisible) return null;
  const { proposal, reviewOpen, setReviewOpen } = graph;
  return (
    <GraphReviewButton
      summary={proposal.detail === undefined ? undefined : (proposal.detail?.proposal ?? null)}
      open={reviewOpen}
      onClick={() => setReviewOpen((value) => !value)}
    />
  );
}

/** The review sheet (#367) and the extract / re-extract dialog (#368). */
function ProposalActions({ noteId, bodyRef, originTranscriptId }: NoteProposalActionsProps) {
  const graph = useNotePageGraph();
  if (!graph?.graphVisible) return null;
  const { proposal, reviewOpen, setReviewOpen, extractMode, setExtractMode, focusItemId, canWriteGraph } =
    graph;
  return (
    <>
      <ProposalReviewSheet
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        source={{ noteId }}
        proposal={proposal}
        noteBodyRef={bodyRef}
        originTranscriptId={originTranscriptId}
        focusItemId={focusItemId}
        onRequestExtract={canWriteGraph ? (mode) => setExtractMode(mode) : undefined}
        headerSlot={
          <GuidanceSummary
            guidance={proposal.detail?.proposal.userGuidance}
            items={proposal.detail?.items}
            onEdit={canWriteGraph ? () => setExtractMode('re-extract') : undefined}
          />
        }
      />
      {canWriteGraph && extractMode && (
        <ExtractDialog
          open
          onClose={() => setExtractMode(null)}
          noteId={noteId}
          mode={extractMode}
          initialGuidance={proposal.detail?.proposal.userGuidance ?? null}
          pendingDecisions={
            proposal.detail?.proposal.status === 'draft'
              ? userDecisionCount(proposal.detail.items)
              : 0
          }
          items={proposal.detail?.items}
          submit={(_noteId, body) => proposal.requestExtract(body)}
          onStarted={() => setReviewOpen(true)}
        />
      )}
    </>
  );
}

/** #368: "Add to graph" from a selection in the rendered body. */
function SelectionActions({
  noteId,
  version,
  markdown,
  containerRef,
  enabled,
  onReload,
}: NoteSelectionActionsProps) {
  const graph = useNotePageGraph();
  if (!graph?.graphVisible || !graph.canWriteGraph) return null;
  const { proposal, setExtractMode, setFocusItemId, setReviewOpen } = graph;
  return (
    <GraphSelectionAdd
      containerRef={containerRef}
      enabled={enabled}
      resolve={(range, container) =>
        resolveNoteSelection(range, container, {
          noteId,
          noteVersion: version,
          markdown,
        })
      }
      target={{
        kind: 'note',
        detail: proposal.detail,
        onExtract: () => setExtractMode(proposal.detail ? 're-extract' : 'extract'),
      }}
      onReload={onReload}
      onAdded={(result) => {
        setFocusItemId(result.item.id);
        void proposal.refresh();
        setReviewOpen(true);
      }}
    />
  );
}

/** The slots of the note page. */
export const appNotePageSlots: NotePageSlots = {
  Provider: NotePageProvider,
  useAsideWidth,
  HeaderActions,
  ProposalActions,
  SelectionActions,
};

function useNotePageAiState(): NotesAiState {
  const graph = useNotePageGraph();
  if (!graph) throw new Error('The note page AI access needs the note page provider above it');
  return graph.ai;
}

/**
 * The note page's AI access: the one the page-wide provider already read, so
 * `GET /api/ai-tasks/config` is requested once per page. Only valid under
 * {@link appNotePageSlots}`.Provider`.
 */
export const appNotePageAiAccess: NotesAiAccess = {
  useAiState: useNotePageAiState,
  KeyRequired: AiKeyRequired,
};

/** The slot of the notes library: knowledge-graph entity hits above the ranked results (#373). */
export const appNotesLibrarySlots: NotesLibrarySlots = {
  SearchPrefix: EntitySearchHits,
};
