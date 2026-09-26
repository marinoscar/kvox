/**
 * Mapping a text selection back to a span of its source (#368, epic #346;
 * ontology.md §5.3 — a selection IS evidence: a note version + character
 * range, or a segment id + rev + character range, plus the exact quote).
 *
 * THE NOTE BODY is rendered markdown, and the user selects what they read,
 * not the source. `locateQuoteInMarkdown` finds the rendered text in the
 * markdown: an exact search first, then a tolerant pattern that lets
 * emphasis/code markers, link syntax and runs of whitespace sit between the
 * characters. Several matches are disambiguated by where the selection sits
 * in the rendered text (`hintRatio`). The returned span's SLICE of the
 * markdown is what is sent as `quote`, so the server's `span_mismatch` check
 * (body.slice(start, end) === quote) holds by construction.
 *
 * A TRANSCRIPT LINE is one element carrying `data-segment-id` /
 * `data-segment-rev` (#367's `SegmentList`). A selection must start and end
 * inside the same one; offsets are measured from that element's start. The
 * element may render words rather than the raw text (the current line's word
 * highlighting), so the offsets are checked against the segment's own text
 * and re-located in it when they disagree.
 */

/** Max quote length `evidenceSpanInputSchema` accepts. */
export const MAX_QUOTE_LENGTH = 2000;

export interface CharSpan {
  charStart: number;
  charEnd: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Markdown that renders as nothing between two visible characters:
 * emphasis/code/strike markers, a backslash escape, a link's `[` and its
 * `](target)` tail.
 */
const GAP = '(?:[*_`~\\[\\\\]|\\]\\([^)\\s]*\\))*';

/** Of several candidate starts, the one whose relative position is nearest `hintRatio`. */
function nearest(starts: Array<{ start: number; end: number }>, length: number, hintRatio: number) {
  let best = starts[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of starts) {
    const distance = Math.abs(candidate.start / Math.max(length, 1) - hintRatio);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Every non-overlapping exact occurrence of `needle` in `haystack`. */
function exactMatches(haystack: string, needle: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    out.push({ start: index, end: index + needle.length });
    from = index + Math.max(needle.length, 1);
  }
  return out;
}

/**
 * Locate a rendered quote in its markdown source, or `null`.
 *
 * `hintRatio` is the selection's character offset within the rendered text
 * divided by the rendered text's length (0…1).
 */
export function locateQuoteInMarkdown(markdown: string, quote: string, hintRatio: number): CharSpan | null {
  const needle = quote.trim();
  if (!needle || needle.length > MAX_QUOTE_LENGTH * 2) return null;

  const exact = exactMatches(markdown, needle);
  if (exact.length > 0) {
    const best = nearest(exact, markdown.length, hintRatio);
    return { charStart: best.start, charEnd: best.end };
  }

  // Tolerant: collapse whitespace in the quote, then allow markup and any
  // whitespace between every visible character.
  const tokens = needle.replace(/\s+/g, ' ').split('');
  const pattern = tokens.map((char) => (char === ' ' ? '\\s+' : escapeRegExp(char))).join(GAP);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'g');
  } catch {
    return null;
  }
  const matches: Array<{ start: number; end: number }> = [];
  for (let match = regex.exec(markdown); match; match = regex.exec(markdown)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  if (matches.length === 0) return null;
  const best = nearest(matches, markdown.length, hintRatio);
  return { charStart: best.start, charEnd: best.end };
}

/** Locate a quote in plain text (a transcript segment), nearest `hintRatio`. */
export function locateQuoteInText(text: string, quote: string, hintRatio: number): CharSpan | null {
  const needle = quote.trim();
  if (!needle) return null;
  const exact = exactMatches(text, needle);
  if (exact.length > 0) {
    const best = nearest(exact, text.length, hintRatio);
    return { charStart: best.start, charEnd: best.end };
  }
  // Word-by-word rendering may differ in whitespace only.
  const pattern = needle.split(/\s+/).map(escapeRegExp).join('\\s+');
  const regex = new RegExp(pattern, 'g');
  const matches: Array<{ start: number; end: number }> = [];
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  if (matches.length === 0) return null;
  const best = nearest(matches, text.length, hintRatio);
  return { charStart: best.start, charEnd: best.end };
}

// -----------------------------------------------------------------------------
// DOM helpers — offsets of a live Range
// -----------------------------------------------------------------------------

/** Characters of `root`'s text before the point (`node`, `offset`). */
export function textOffsetWithin(root: Node, node: Node, offset: number): number {
  const range = root.ownerDocument!.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** The closest element (inclusive) carrying `data-segment-id`, or null. */
export function segmentElementOf(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement && current.dataset.segmentId) return current;
    current = current.parentNode;
  }
  return null;
}

/** A range's bounding box, or an empty rect where layout is unavailable (jsdom). */
export function rangeRect(range: Range): DOMRect {
  if (typeof range.getBoundingClientRect === 'function') return range.getBoundingClientRect();
  return new DOMRect(0, 0, 0, 0);
}

/** Why a selection cannot become evidence. */
export const SELECTION_REFUSALS = {
  note: 'Select plain text within one paragraph',
  segment: 'Select within one line',
  tooLong: `Select at most ${MAX_QUOTE_LENGTH.toLocaleString('en-US')} characters`,
} as const;
