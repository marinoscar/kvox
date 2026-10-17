/**
 * What a text selection resolves to on a note or a transcript line: the quote,
 * where it sits in its source, and the rectangle a floating action anchors to.
 * Pure types and one guard; the hook that watches the browser selection
 * (`useTextSelection`) lives in the `ui` entry because it follows the route.
  *
 * @stability experimental
 */

export interface GraphSelection {
  /** The quote. */
  quote: string;
  /** The source. */
  source:
    | {
      /** The kind. */
      kind: 'note';
      /** The id of the note. */
      noteId: string;
      /** The note version. */
      noteVersion: number;
      /** The char start. */
      charStart: number;
      /** The char end. */
      charEnd: number;
    }
    | {
        /** The kind. */
        kind: 'segment';
        /** The id of the transcript. */
        transcriptId: string;
        /** The id of the segment. */
        segmentId: string;
        /** The segment rev. */
        segmentRev: number;
        /** The char start. */
        charStart: number;
        /** The char end. */
        charEnd: number;
      };
  /** For anchoring the floating button. */
  rect: DOMRect;
}

/**
 * The selection refusal.
 *
 * @stability experimental
 */
export interface SelectionRefusal {
  /** The refused. */
  refused: string;
  /** The rect. */
  rect: DOMRect;
}

/**
 * The selection resolution.
 *
 * @stability experimental
 */
export type SelectionResolution = GraphSelection | SelectionRefusal | null;

/**
 * Tells whether refusal.
 *
 * @stability experimental
 */
export function isRefusal(value: SelectionResolution): value is SelectionRefusal {
  return value !== null && 'refused' in value;
}
