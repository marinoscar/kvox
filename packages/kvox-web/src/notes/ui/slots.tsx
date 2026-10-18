// =============================================================================
// Slots: what the app that mounts the notes pages can add to them
// =============================================================================
//
// The notes slice imports only `core`, `transcripts` and `search`. The
// connected-knowledge features of the note page (the review sheet over a note's
// proposal, "Add to graph" on a text selection, the extract dialog) and the
// entity hits above library search belong to another slice (or to the app), so
// the page asks for them through these slots and renders nothing where one is
// absent. A slot is a component the app passes in; the pages never import the
// thing that fills it.
//
// A leaf slot that throws while rendering is contained by `NotesSlotBoundary`:
// it renders nothing and the error is logged, so an optional enhancement can
// never take the note page down with it.
// =============================================================================

import { Component } from 'react';
import type { ComponentType, ReactNode, RefObject } from 'react';

import type { NoteStatus } from '../headless/index.js';

/**
 * The props of the `Provider` slot of {@link NotePageSlots}.
 *
 * @stability experimental
 */
export interface NotePageProviderProps {
  /** The note the route names, or `undefined` while the route has no id. */
  noteId: string | undefined;
  /** The note page. Render it unchanged, inside whatever context the other slots share. */
  children: ReactNode;
}

/**
 * The props of the `HeaderActions` slot of {@link NotePageSlots}.
 *
 * @stability experimental
 */
export interface NoteHeaderActionsProps {
  /** The note the page shows. */
  noteId: string;
}

/**
 * The props of the `ProposalActions` slot of {@link NotePageSlots}.
 *
 * @stability experimental
 */
export interface NoteProposalActionsProps {
  /** The note the page shows. */
  noteId: string;
  /** The note's current version. */
  version: number;
  /** The element holding the rendered body, for a panel that points into it. */
  bodyRef: RefObject<HTMLElement | null>;
  /** The transcript the note ultimately came from, or `null`. */
  originTranscriptId: string | null;
  /**
   * The note's lifecycle status. A panel watches it turn `ready` to follow work
   * the server starts on its own at that moment (an automatic graph extraction, #616).
   */
  status: NoteStatus;
  /** When the note last changed (ISO 8601); with `status`, tells a page opened just after the note turned `ready`. */
  updatedAt: string;
}

/**
 * The props of the `SelectionActions` slot of {@link NotePageSlots}.
 *
 * @stability experimental
 */
export interface NoteSelectionActionsProps {
  /** The note the page shows. */
  noteId: string;
  /** The note's current version. */
  version: number;
  /** The note's markdown body, as stored. */
  markdown: string;
  /** The element holding the rendered body; the selection lives inside it. */
  containerRef: RefObject<HTMLElement | null>;
  /** `false` while the body is being edited or written: a selection is not an action target then. */
  enabled: boolean;
  /** Re-reads the note, for when the slot finds the version it acted on is stale. */
  onReload: () => void;
}

/**
 * The slots of `NotePage`.
 *
 * @remarks
 * Every member is optional and the default renders nothing. A slot that needs
 * state shared with another slot (the web edition's review sheet is opened by a
 * header button and by a selection) keeps it in `Provider`, which wraps the
 * whole page and adds no element of its own. The app's wiring
 * (`apps/web/src/kvox/NotePageWithSlots.tsx`) is the working example.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export interface NotePageSlots {
  /**
   * Wraps the page, loading state included, so the other slots can share
   * state. It must render `children` and nothing around them.
   */
  Provider?: ComponentType<NotePageProviderProps>;
  /**
   * A hook returning the width in pixels of a panel the page makes room for on
   * a wide screen (the web edition's review sheet), or `0` for none. It is
   * called on every render, so it must follow the rules of hooks.
   */
  useAsideWidth?: () => number;
  /** Extra actions in the page header, after the page's own and before the overflow menu. */
  HeaderActions?: ComponentType<NoteHeaderActionsProps>;
  /** A panel over the note's connected-knowledge proposal (review sheet, extract dialog). */
  ProposalActions?: ComponentType<NoteProposalActionsProps>;
  /** An action over a text selection in the rendered body (for example "Add to graph"). */
  SelectionActions?: ComponentType<NoteSelectionActionsProps>;
}

/**
 * The slots of `NotesLibraryView` (and of `NotesPage`, which renders it).
 *
 * @stability experimental
 * @extensionPoint slot
 */
export interface NotesLibrarySlots {
  /**
   * Rendered above the ranked results while the search box holds a query (the
   * web edition shows knowledge-graph entity hits here).
   */
  SearchPrefix?: ComponentType<{
    /** The text in the search box. */
    query: string;
  }>;
}

/**
 * The props of {@link NotesSlotBoundary}.
 *
 * @stability experimental
 */
export interface NotesSlotBoundaryProps {
  /** The slot's name, for the log line. */
  name: string;
  /** The slot component. */
  children?: ReactNode;
}

/**
 * The state of {@link NotesSlotBoundary}.
 *
 * @stability experimental
 */
export interface NotesSlotBoundaryState {
  /** Whether the slot threw. */
  failed: boolean;
}

/**
 * Contains a slot: if it throws while rendering, it renders nothing and the
 * error is logged.
 *
 * @stability experimental
 */
export class NotesSlotBoundary extends Component<NotesSlotBoundaryProps, NotesSlotBoundaryState> {
  /** Starts healthy. */
  override state: NotesSlotBoundaryState = { failed: false };

  /** Marks the slot as failed so the next render draws nothing. */
  static getDerivedStateFromError(): NotesSlotBoundaryState {
    return { failed: true };
  }

  /** Logs the failure; the page keeps working. */
  override componentDidCatch(error: unknown): void {
    console.error(`[kvox-web] the "${this.props.name}" slot of the notes pages threw and was not rendered`, error);
  }

  /** The slot, or nothing. */
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
