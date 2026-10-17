// =============================================================================
// Slots: what the app that mounts the transcripts pages can add to them
// =============================================================================
//
// The transcripts slice imports only `core`, `transcription` and `search`. The
// notes list under a transcript, the knowledge-graph person links on a speaker
// and the "Add to graph" action on a text selection belong to other slices (or
// to the app), so the page asks for them through these slots and renders
// nothing where one is absent. A slot is a component (or, for two of them, a
// small object) the app passes in; the pages never import the thing that fills
// it.
//
// A slot that throws while rendering is contained by {@link SlotBoundary}: it
// renders nothing and the error is logged, so an optional enhancement can never
// take the transcript page down with it.
// =============================================================================

import { Component } from 'react';
import type { ComponentType, ReactNode, RefObject } from 'react';

import type { TranscriptSegment } from '../headless/clients/transcripts.js';

/**
 * What a speaker-people slot returns: the speakers of one transcript that are a
 * known person in the viewer's connected knowledge, and how to open that person.
 *
 * @stability experimental
 */
export interface TranscriptSpeakerPeople {
  /** `speakerId` to the id of the person the speaker is identified as. */
  entityIds: Readonly<Record<string, string>>;
  /** Opens the page of one person. */
  open: (entityId: string) => void;
}

/**
 * The props of the "selection actions" slot.
 *
 * @stability experimental
 */
export interface TranscriptSelectionActionsProps {
  /** The transcript the selection is in. */
  transcriptId: string;
  /** The element holding the rendered segments; the selection lives inside it. */
  containerRef: RefObject<HTMLElement | null>;
  /** The segments as shown, so a selection can be resolved to a segment span. */
  segments: readonly TranscriptSegment[];
  /** `false` while a line is being edited: a selection inside a text box is not an action target. */
  enabled: boolean;
}

/**
 * The slots of {@link TranscriptPage}.
 *
 * @remarks
 * Every member is optional and the default renders nothing. The app's wiring
 * (`apps/web/src/kvox/TranscriptPageWithSlots.tsx`) is the working example.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export interface TranscriptPageSlots {
  /**
   * The notes made from this transcript, drawn below the speakers (wide) or
   * below the transcript (narrow). Rendered only for a viewer who holds
   * `notes:read` and once the transcript's content has arrived.
   */
  NotesSection?: ComponentType<{
    /** The transcript the notes were made from. */
    transcriptId: string;
  }>;
  /**
   * A hook that tells which speakers are a person in the viewer's graph. The
   * speaker chips draw an "Open the person's page" button for each entry. It
   * is called on every render of the page, so it must follow the rules of
   * hooks; `enabled` is `false` until the transcript is ready.
   */
  useSpeakerPeople?: (transcriptId: string | undefined, enabled: boolean) => TranscriptSpeakerPeople | null;
  /**
   * An action over a text selection inside one line (for example "Add to
   * graph"). Rendered once the transcript is ready.
   */
  SelectionActions?: ComponentType<TranscriptSelectionActionsProps>;
  /**
   * Extra actions in the page header, after the page's own. Rendered for a
   * transcript that has loaded.
   */
  HeaderActions?: ComponentType<{
    /** The transcript the page shows. */
    transcriptId: string;
  }>;
}

/**
 * The slots of {@link TranscriptsLibraryView} (and of `TranscriptsPage`, which
 * renders it).
 *
 * @stability experimental
 * @extensionPoint slot
 */
export interface TranscriptsLibrarySlots {
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
 * The props of a share dialog.
 *
 * @stability experimental
 */
export interface TranscriptShareDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Closes the dialog. */
  onClose: () => void;
  /** The transcript being shared. */
  transcriptId: string;
  /** The transcript's title, for the dialog heading. */
  title: string;
}

/**
 * How a transcript is shared and left. The grants live in the host (the web
 * edition uses the platform's sharing slice), so the pages receive them here and
 * offer neither "Share" nor "Leave" without it.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export interface TranscriptSharingAdapter {
  /** The dialog an owner manages shares in. */
  ShareDialog: ComponentType<TranscriptShareDialogProps>;
  /** Gives up the viewer's own access to a transcript somebody shared with them. */
  leave: (transcriptId: string) => Promise<void>;
}

/**
 * The viewer's AI availability, as the name-check surfaces need it.
 *
 * @stability experimental
 */
export interface TranscriptAiState {
  /** The answer has not arrived yet. */
  isLoading: boolean;
  /** The viewer has saved a key. */
  keyConfigured: boolean;
  /** The deployment permits AI at all. */
  available: boolean;
  /** Both of the above. */
  canGenerate: boolean;
}

/**
 * AI access for "Fix names with AI": whether the viewer may run it, and the
 * empty state that asks for a key. Without it the page offers no name check.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export interface TranscriptAiAccess {
  /** A hook that reads the viewer's AI availability. */
  useAiState: () => TranscriptAiState;
  /** The "add your AI key to use this" state. */
  KeyRequired: ComponentType;
}

/**
 * The props of {@link SlotBoundary}.
 *
 * @stability experimental
 */
export interface SlotBoundaryProps {
  /** The slot's name, for the log line. */
  name: string;
  /** The slot component. */
  children?: ReactNode;
}

/**
 * The state of {@link SlotBoundary}.
 *
 * @stability experimental
 */
export interface SlotBoundaryState {
  /** Whether the slot threw. */
  failed: boolean;
}

/**
 * Contains a slot: if it throws while rendering, it renders nothing and the
 * error is logged.
 *
 * @stability experimental
 */
export class SlotBoundary extends Component<SlotBoundaryProps, SlotBoundaryState> {
  /** Starts healthy. */
  override state: SlotBoundaryState = { failed: false };

  /** Marks the slot as failed so the next render draws nothing. */
  static getDerivedStateFromError(): SlotBoundaryState {
    return { failed: true };
  }

  /** Logs the failure; the page keeps working. */
  override componentDidCatch(error: unknown): void {
    console.error(`[kvox-web] the "${this.props.name}" slot of the transcripts page threw and was not rendered`, error);
  }

  /** The slot, or nothing. */
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
