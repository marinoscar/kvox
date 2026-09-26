/**
 * The two `useTextSelection` resolvers (#368): a rendered note body and a
 * transcript's segment list. Pure over the DOM they are handed — both are
 * exported for tests.
 */

import type { SelectionResolution } from '../../../hooks/useTextSelection';
import {
  MAX_QUOTE_LENGTH,
  SELECTION_REFUSALS,
  locateQuoteInMarkdown,
  locateQuoteInText,
  rangeRect,
  segmentElementOf,
  textOffsetWithin,
} from '../../../utils/graphSpans';

export interface NoteSelectionContext {
  noteId: string;
  noteVersion: number;
  /** The markdown the rendered body came from — `note.body` at `noteVersion`. */
  markdown: string;
}

/** A selection in the rendered note body → a note span whose markdown slice is the quote. */
export function resolveNoteSelection(
  range: Range,
  container: HTMLElement,
  context: NoteSelectionContext,
): SelectionResolution {
  const rect = rangeRect(range);
  const rendered = range.toString();
  if (rendered.trim().length > MAX_QUOTE_LENGTH) return { refused: SELECTION_REFUSALS.tooLong, rect };
  const total = container.textContent?.length ?? 0;
  const before = textOffsetWithin(container, range.startContainer, range.startOffset);
  const hintRatio = total > 0 ? before / total : 0;
  const span = locateQuoteInMarkdown(context.markdown, rendered, hintRatio);
  if (!span) return { refused: SELECTION_REFUSALS.note, rect };
  const quote = context.markdown.slice(span.charStart, span.charEnd);
  if (quote.length > MAX_QUOTE_LENGTH) return { refused: SELECTION_REFUSALS.tooLong, rect };
  return {
    quote,
    source: {
      kind: 'note',
      noteId: context.noteId,
      noteVersion: context.noteVersion,
      charStart: span.charStart,
      charEnd: span.charEnd,
    },
    rect,
  };
}

export interface SegmentSelectionContext {
  transcriptId: string;
  /** The segment's own text (what the server slices), by id. */
  segmentText: (segmentId: string) => string | undefined;
}

/** A selection within one transcript line → a segment span pinned to its `rev`. */
export function resolveSegmentSelection(
  range: Range,
  _container: HTMLElement,
  context: SegmentSelectionContext,
): SelectionResolution {
  const rect = rangeRect(range);
  const startEl = segmentElementOf(range.startContainer);
  const endEl = segmentElementOf(range.endContainer);
  if (!startEl || !endEl || startEl !== endEl) return { refused: SELECTION_REFUSALS.segment, rect };
  const segmentId = startEl.dataset.segmentId!;
  const segmentRev = Number(startEl.dataset.segmentRev);
  if (!Number.isFinite(segmentRev)) return { refused: SELECTION_REFUSALS.segment, rect };

  const raw = range.toString();
  const leading = raw.length - raw.trimStart().length;
  const quoted = raw.trim();
  if (!quoted) return null;
  if (quoted.length > MAX_QUOTE_LENGTH) return { refused: SELECTION_REFUSALS.tooLong, rect };

  const shown = startEl.textContent ?? '';
  const start = textOffsetWithin(startEl, range.startContainer, range.startOffset) + leading;
  const end = start + quoted.length;
  const text = context.segmentText(segmentId) ?? shown;

  let span = text.slice(start, end) === quoted ? { charStart: start, charEnd: end } : null;
  // The line may be drawn word by word; find the words in the real text.
  if (!span) span = locateQuoteInText(text, quoted, shown.length > 0 ? start / shown.length : 0);
  if (!span) return { refused: SELECTION_REFUSALS.segment, rect };

  return {
    quote: text.slice(span.charStart, span.charEnd),
    source: {
      kind: 'segment',
      transcriptId: context.transcriptId,
      segmentId,
      segmentRev,
      charStart: span.charStart,
      charEnd: span.charEnd,
    },
    rect,
  };
}
