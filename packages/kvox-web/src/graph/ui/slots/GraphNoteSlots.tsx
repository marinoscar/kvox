// =============================================================================
// The connected-knowledge members of the note page's slots
// =============================================================================
//
// ONE PROVIDER, FOUR SLOTS. The header button, the review sheet, the selection
// action and the extract dialog all act on the same proposal and the same "is
// the sheet open" flag, so `GraphNotePageProvider` holds that state once for the
// page and the slots read it. Every slot returns `null` when connected knowledge
// is off or the viewer lacks the permission, so a host can wire them
// unconditionally.
//
// FOLLOWING AN AUTOMATIC EXTRACTION (#616). With graph auto-extraction on, the
// server creates the note's proposal right after the note turns `ready`, after
// the page's first read answered `null`. `ProposalActions` reports the note's
// status to the provider; on the in-flight -> `ready` edge (or when the page
// opens just after it) the provider asks `useGraphProposal` to keep re-reading
// for `NOTE_EXTRACTION_FOLLOW_MS`, so the sheet shows the extraction instead of
// offering Extract.
// =============================================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useHasPermission, useKvoxHost } from '../../../core/headless/index.js';
import type {
  NoteHeaderActionsProps,
  NotePageProviderProps,
  NotePageSlots,
  NoteProposalActionsProps,
  NoteSelectionActionsProps,
  NotesLibrarySlots,
} from '../../../notes/ui/index.js';
import { isNoteInFlight } from '../../../notes/headless/index.js';
import type { NoteStatus } from '../../../notes/headless/index.js';
import { NOTE_EXTRACTION_FOLLOW_MS, useGraphProposal } from '../../headless/hooks/useGraphProposal.js';
import { userDecisionCount } from '../../headless/utils/guidance.js';
import { resolveNoteSelection } from '../../headless/utils/resolvers.js';
import { GraphReviewButton } from '../components/GraphReviewButton.js';
import { ExtractDialog } from '../components/guide/ExtractDialog.js';
import { GuidanceSummary } from '../components/guide/GuidanceSummary.js';
import {
  ProposalReviewSheet,
  REVIEW_SHEET_WIDTH,
} from '../components/review/ProposalReviewSheet.js';
import { GraphSelectionAdd } from '../components/selection/GraphSelectionAdd.js';
import { GraphSearchPrefix } from './GraphSearchPrefix.js';

type ExtractMode = 'extract' | 're-extract';

/** What the page-wide provider shares with the slots. */
interface NotePageGraphState {
  /**
   * The proposal review sheet (#367). Visible only to `graph:read` on a
   * deployment with connected knowledge switched on; `graphEnabled` undefined
   * (an older API, or not known yet) reads as "not on", so the page is unchanged.
   */
  graphVisible: boolean;
  /** `graph:write`: the extract dialog and "Add to graph". */
  canWriteGraph: boolean;
  /** The proposal, read here so the button's badge and the sheet share one request and one poll. */
  proposal: ReturnType<typeof useGraphProposal>;
  /** Whether the review sheet is open. */
  reviewOpen: boolean;
  /** Opens or closes the review sheet. */
  setReviewOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  /** #368: the extract / re-extract dialog, mounted only while open. */
  extractMode: ExtractMode | null;
  /** Opens or closes the extract dialog. */
  setExtractMode: (mode: ExtractMode | null) => void;
  /** #368: the row "Add to graph" just created, scrolled to in the sheet. */
  focusItemId: string | null;
  /** Records the row to scroll to. */
  setFocusItemId: (id: string | null) => void;
  /**
   * #616: the note's status as the page last saw it. When it turns `ready`
   * (or the page opened just after it did), the proposal is re-read for
   * `NOTE_EXTRACTION_FOLLOW_MS` to pick up an automatic extraction.
   */
  reportNote: (note: { status: NoteStatus; updatedAt: string }) => void;
}

const NotePageGraphContext = createContext<NotePageGraphState | null>(null);

function useNotePageGraph(): NotePageGraphState | null {
  return useContext(NotePageGraphContext);
}

/**
 * The props of {@link GraphNotePageProvider}.
 *
 * @stability experimental
 */
export interface GraphNotePageProviderProps extends NotePageProviderProps {
  /**
   * Whether the host has settled what it knows about the deployment
   * (`features()`), default `true`. The `?review=1` deep link opens the sheet
   * once, after this turns `true`; a host whose switch loads asynchronously
   * passes `false` until it has.
   */
  ready?: boolean;
}

/**
 * Wraps the note page: holds the proposal and the open/closed state of the
 * review sheet and the extract dialog once, so the other graph slots share them.
 * Also opens the sheet for the `?review=1` link and then drops the parameter.
 * Fills the `Provider` slot of the note page.
 *
 * @param props - See {@link GraphNotePageProviderProps}.
 * @returns The page, inside the shared state.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export function GraphNotePageProvider({
  noteId,
  children,
  ready = true,
}: GraphNotePageProviderProps): ReactNode {
  const graphEnabled = useKvoxHost().features().graphEnabled === true;
  const canReadGraph = useHasPermission('graph:read');
  const canWriteGraph = useHasPermission('graph:write');
  const graphVisible = canReadGraph && graphEnabled;
  // Keyed by note, so `/notes/a` -> `/notes/b` drops a's wait without an effect
  // racing the slot's report (children's effects run before this provider's).
  const [awaitState, setAwaitState] = useState<{ noteId: string | undefined; until: number } | null>(null);
  const awaitUntil = awaitState && awaitState.noteId === noteId ? awaitState.until : undefined;
  const proposal = useGraphProposal(
    { noteId: noteId ?? '' },
    { enabled: graphVisible && Boolean(noteId), awaitUntil },
  );
  // Read through refs so `reportNote` keeps a stable identity.
  const refreshRef = useRef(proposal.refresh);
  refreshRef.current = proposal.refresh;
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  const lastSeen = useRef<{ noteId: string | undefined; status: NoteStatus } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [extractMode, setExtractMode] = useState<ExtractMode | null>(null);
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const reviewRequested = searchParams.get('review') === '1';

  /** `?review=1` opens the sheet once, then leaves the URL (`replace`). */
  useEffect(() => {
    if (!reviewRequested || !ready) return;
    if (graphVisible) setReviewOpen(true);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('review');
        return next;
      },
      { replace: true },
    );
  }, [graphVisible, ready, reviewRequested, setSearchParams]);

  // `/notes/a` -> `/notes/b` must not carry a's open sheet over to b. Not on the
  // first render: that would undo the `?review=1` effect above, which runs first.
  const shownNoteId = useRef(noteId);
  useEffect(() => {
    if (shownNoteId.current === noteId) return;
    shownNoteId.current = noteId;
    setReviewOpen(false);
  }, [noteId]);

  /**
   * #616: follow the extraction the server starts when the note turns `ready`.
   * The in-flight-to-`ready` edge waits from now; a first sight of a note that
   * turned `ready` moments ago (opened from the notification) waits out the
   * rest of the window.
   */
  const reportNote = useCallback((note: { status: NoteStatus; updatedAt: string }) => {
    const current = noteIdRef.current;
    // A report about another note than the last one starts over.
    const seen = lastSeen.current;
    const previous = seen && seen.noteId === current ? seen.status : undefined;
    lastSeen.current = { noteId: current, status: note.status };
    // In flight: only recorded, so the turn to `ready` is seen as an edge.
    if (note.status !== 'ready') return;
    if (previous !== undefined && isNoteInFlight(previous)) {
      setAwaitState({ noteId: current, until: Date.now() + NOTE_EXTRACTION_FOLLOW_MS });
      void refreshRef.current();
      return;
    }
    if (previous === undefined) {
      const until = Date.parse(note.updatedAt) + NOTE_EXTRACTION_FOLLOW_MS;
      if (until > Date.now()) setAwaitState({ noteId: current, until });
    }
  }, []);

  const value = useMemo<NotePageGraphState>(
    () => ({
      graphVisible,
      canWriteGraph,
      proposal,
      reviewOpen,
      setReviewOpen,
      extractMode,
      setExtractMode,
      focusItemId,
      setFocusItemId,
      reportNote,
    }),
    [canWriteGraph, extractMode, focusItemId, graphVisible, proposal, reportNote, reviewOpen],
  );

  return <NotePageGraphContext.Provider value={value}>{children}</NotePageGraphContext.Provider>;
}

/**
 * At `lg` and up the note moves aside for the review sheet; below it the sheet
 * overlays. Fills the `useAsideWidth` slot of the note page.
 *
 * @returns The width in pixels of the open sheet, or `0`.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export function useGraphNoteAsideWidth(): number {
  const graph = useNotePageGraph();
  return graph?.graphVisible && graph.reviewOpen ? REVIEW_SHEET_WIDTH : 0;
}

/**
 * The review button in the note page's header (#367). Fills the `HeaderActions` slot.
 *
 * @param _props - The note the page shows.
 * @returns The button, or nothing.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export function GraphNoteHeaderActions(_props: NoteHeaderActionsProps) {
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

/**
 * The review sheet (#367) and the extract / re-extract dialog (#368). Fills the
 * `ProposalActions` slot of the note page.
 *
 * @param props - The note, its body element, the transcript it came from, and its status.
 * @returns The sheet and dialog, or nothing.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export function GraphNoteProposalActions({
  noteId,
  bodyRef,
  originTranscriptId,
  status,
  updatedAt,
}: NoteProposalActionsProps) {
  const graph = useNotePageGraph();
  const graphVisible = graph?.graphVisible === true;
  const reportNote = graph?.reportNote;
  // #616: before the early return (rules of hooks); reported only when the sheet can show.
  useEffect(() => {
    if (graphVisible) reportNote?.({ status, updatedAt });
  }, [graphVisible, reportNote, status, updatedAt]);
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

/**
 * #368: "Add to graph" from a selection in the rendered note body. Fills the
 * `SelectionActions` slot of the note page.
 *
 * @param props - The note, its version and body, and the element the selection lives in.
 * @returns The selection action, or nothing.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export function GraphNoteSelectionActions({
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

/**
 * Every graph member of the note page's slots, ready to use as `slots` of
 * `NotePage`, or to spread into the host's own.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export const graphNotePageSlots: NotePageSlots = {
  Provider: GraphNotePageProvider,
  useAsideWidth: useGraphNoteAsideWidth,
  HeaderActions: GraphNoteHeaderActions,
  ProposalActions: GraphNoteProposalActions,
  SelectionActions: GraphNoteSelectionActions,
};

/**
 * The graph member of the notes library's slots: entity hits above the ranked
 * results.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export const graphNotesLibrarySlots: NotesLibrarySlots = {
  SearchPrefix: GraphSearchPrefix,
};
