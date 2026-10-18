/**
 * What a text selection resolves to on a note or a transcript line: the quote,
 * where it sits in its source, and the rectangle a floating action anchors to.
 * Pure types and one guard; the hook that watches the browser selection
 * (`useTextSelection`) lives in the `ui` entry because it follows the route.
 *
 * @stability experimental
 */

export interface GraphSelection {
  /** The selected text. */
  quote: string;
  /** Where the quote sits: a note version or a transcript segment. */
  source:
    | {
      /** Discriminator for a note selection. */
      kind: 'note';
      /** The note's id. */
      noteId: string;
      /** Note version the offsets refer to. */
      noteVersion: number;
      /** Offset of the first character in that version's markdown. */
      charStart: number;
      /** Offset just past the last character. */
      charEnd: number;
    }
    | {
        /** Discriminator for a transcript-segment selection. */
        kind: 'segment';
        /** The transcript's id. */
        transcriptId: string;
        /** The segment's id. */
        segmentId: string;
        /** Segment revision the offsets refer to. */
        segmentRev: number;
        /** Offset of the first character in the segment text. */
        charStart: number;
        /** Offset just past the last character. */
        charEnd: number;
      };
  /** For anchoring the floating button. */
  rect: DOMRect;
}

/**
 * A selection that cannot become evidence, with the reason and where to show it.
 *
 * @stability experimental
 */
export interface SelectionRefusal {
  /** The reason, ready to show the user. */
  refused: string;
  /** Where to anchor the message. */
  rect: DOMRect;
}

/**
 * What a selection resolves to: a usable selection, a refusal with a reason, or nothing.
 *
 * @stability experimental
 */
export type SelectionResolution = GraphSelection | SelectionRefusal | null;

/**
 * Tells whether a resolution is a refusal rather than a usable selection.
 *
 * @stability experimental
 */
export function isRefusal(value: SelectionResolution): value is SelectionRefusal {
  return value !== null && 'refused' in value;
}
