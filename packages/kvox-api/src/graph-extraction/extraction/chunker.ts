// =============================================================================
// planChunks — split a long note body for map-reduce extraction (#777, epic #773)
// =============================================================================
//
// PURE: no Prisma, no Nest, no clock. One `kg.extract` call can carry only so
// many output rows, so a long note (an imported document is a note whose body is
// the whole document) is split into CHUNKS and each chunk is one structured call
// inside the same job (docs/specs/ontology.md §6.6).
//
//   - A body of at most `CHUNK_THRESHOLD_TOKENS` is ONE chunk covering the whole
//     body, so a short note's request is unchanged.
//   - Otherwise it is split on Markdown HEADING boundaries first, then blank-line
//     PARAGRAPH boundaries, then LINE boundaries (a table row or a list item is
//     one line and is never cut), then sentences, then words. Pieces are packed
//     greedily up to `CHUNK_TARGET_TOKENS`.
//   - Chunks are CONTIGUOUS and cover the body exactly once: `start`/`end` are
//     absolute offsets into the body, so a quote located inside `chunk.text`
//     maps to the note by adding `chunk.start`.
//   - Every chunk after the first carries `leadIn`, the last paragraph of the
//     previous chunk, shown to the model as read-only context ("context only —
//     do not cite"). It is not part of `text`, so it can never become evidence.
//   - The count is bounded by `MAX_CHUNKS`: a longer body gets a larger target
//     instead of more calls (the job's `maxRuntimeMs` is sized from the bound).
//   - Fenced code blocks are not split at heading or paragraph boundaries.
// =============================================================================

/** A body longer than this many tokens is chunked. */
export const CHUNK_THRESHOLD_TOKENS = 3000;
/** The size a chunk is packed towards. */
export const CHUNK_TARGET_TOKENS = 2000;
/** The most chunks (hence model calls) one note can need. */
export const MAX_CHUNKS = 12;
/** The longest read-only lead-in, in characters. */
export const MAX_LEAD_IN_CHARS = 800;

export interface BodyChunk {
  /** 0-based. */
  index: number;
  count: number;
  /** Absolute offsets into the body; `body.slice(start, end) === text`. */
  start: number;
  end: number;
  text: string;
  /** The previous chunk's last paragraph; null for the first chunk. */
  leadIn: string | null;
}

export type CountTokens = (text: string) => number;

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^#{1,6}\s/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

interface Line {
  start: number;
  end: number; // exclusive, includes the newline
  text: string;
}

function linesOf(body: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < body.length) {
    const nl = body.indexOf('\n', start);
    const end = nl === -1 ? body.length : nl + 1;
    out.push({ start, end, text: body.slice(start, end) });
    start = end;
  }
  return out;
}

/** Split offsets (exclusive of 0 and body.length), ascending, per level. */
function headingOffsets(lines: Line[]): number[] {
  const out: number[] = [];
  let fenced = false;
  for (const l of lines) {
    if (FENCE.test(l.text)) fenced = !fenced;
    else if (!fenced && l.start > 0 && HEADING.test(l.text)) out.push(l.start);
  }
  return out;
}

function paragraphOffsets(lines: Line[]): number[] {
  const out: number[] = [];
  let fenced = false;
  let prevBlank = false;
  for (const l of lines) {
    const blank = l.text.trim().length === 0;
    if (FENCE.test(l.text)) fenced = !fenced;
    if (!fenced && !blank && prevBlank && l.start > 0) out.push(l.start);
    prevBlank = blank;
  }
  return out;
}

function lineOffsets(lines: Line[]): number[] {
  const out: number[] = [];
  let fenced = false;
  for (const l of lines) {
    const opensFence = FENCE.test(l.text);
    // A continuation line (indented) stays with its list item or table row.
    const continuation = /^\s+\S/.test(l.text) && !l.text.startsWith('|');
    if (!fenced && !opensFence && l.start > 0 && !continuation) out.push(l.start);
    if (opensFence) fenced = !fenced;
  }
  return out;
}

function sentenceOffsets(text: string, base: number): number[] {
  const out: number[] = [];
  const re = /[.!?]["')\]]?\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const at = m.index + m[0].length;
    if (at < text.length) out.push(base + at);
  }
  return out;
}

function wordOffsets(text: string, base: number): number[] {
  const out: number[] = [];
  const re = /\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const at = m.index + m[0].length;
    if (at < text.length) out.push(base + at);
  }
  return out;
}

/** Whether a range is a single table row or list item, which is never cut mid-line. */
function isAtomicLine(text: string): boolean {
  const first = text.split('\n', 1)[0] ?? '';
  return first.trimStart().startsWith('|') || LIST_ITEM.test(first);
}

type Range = [number, number];

function cut(range: Range, offsets: number[]): Range[] {
  const [s, e] = range;
  const inside = offsets.filter((o) => o > s && o < e);
  const points = [s, ...inside, e];
  const out: Range[] = [];
  for (let i = 0; i < points.length - 1; i++) out.push([points[i], points[i + 1]]);
  return out;
}

/** Contiguous atoms of at most `target` tokens each (an unsplittable one may exceed it). */
function atomize(body: string, lines: Line[], countTokens: CountTokens, target: number): Range[] {
  const levels: Array<(range: Range) => number[]> = [
    () => headingOffsets(lines),
    () => paragraphOffsets(lines),
    () => lineOffsets(lines),
    ([s, e]) => (isAtomicLine(body.slice(s, e)) ? [] : sentenceOffsets(body.slice(s, e), s)),
    ([s, e]) => (isAtomicLine(body.slice(s, e)) ? [] : wordOffsets(body.slice(s, e), s)),
  ];
  const sizeOf = (r: Range) => countTokens(body.slice(r[0], r[1]));

  const split = (range: Range, level: number): Range[] => {
    if (sizeOf(range) <= target || level >= levels.length) return [range];
    const pieces = cut(range, levels[level](range));
    if (pieces.length === 1) return split(range, level + 1);
    // Greedy pack at this level, then split any piece that is still too big.
    const packed: Range[] = [];
    let current: Range | null = null;
    let currentSize = 0;
    for (const piece of pieces) {
      const size = sizeOf(piece);
      if (current && currentSize + size <= target) {
        current = [current[0], piece[1]];
        currentSize += size;
      } else {
        if (current) packed.push(current);
        current = piece;
        currentSize = size;
      }
    }
    if (current) packed.push(current);
    return packed.flatMap((p) => (sizeOf(p) > target ? split(p, level + 1) : [p]));
  };
  return split([0, body.length], 0);
}

/** The last paragraph of `text`, at most `MAX_LEAD_IN_CHARS`; null when blank. */
export function leadInOf(text: string): string | null {
  const paragraphs = text.split(/\n[ \t]*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  let last = paragraphs[paragraphs.length - 1];
  if (!last) return null;
  if (last.length > MAX_LEAD_IN_CHARS) {
    const tail = last.slice(last.length - MAX_LEAD_IN_CHARS);
    const nl = tail.indexOf('\n');
    const sp = tail.search(/\s/);
    const from = nl !== -1 ? nl + 1 : sp !== -1 ? sp + 1 : 0;
    last = tail.slice(from).trim();
  }
  return last.length > 0 ? last : null;
}

/** Merge a whitespace-only atom into its neighbour so no chunk is blank. */
function dropBlank(body: string, atoms: Range[]): Range[] {
  const out: Range[] = [];
  for (const a of atoms) {
    const blank = body.slice(a[0], a[1]).trim().length === 0;
    if (blank && out.length > 0) out[out.length - 1] = [out[out.length - 1][0], a[1]];
    else out.push(a);
  }
  if (out.length > 1 && body.slice(out[0][0], out[0][1]).trim().length === 0) {
    out.splice(0, 2, [out[0][0], out[1][1]]);
  }
  return out;
}

/**
 * The chunks of `body`. One chunk covering everything when the body fits under
 * the threshold (or `allowSplit` is false); never more than `MAX_CHUNKS`.
 */
export function planChunks(
  body: string,
  countTokens: CountTokens,
  options: { allowSplit?: boolean; threshold?: number; target?: number; maxChunks?: number } = {},
): BodyChunk[] {
  const threshold = options.threshold ?? CHUNK_THRESHOLD_TOKENS;
  const maxChunks = options.maxChunks ?? MAX_CHUNKS;
  const single: BodyChunk[] = [{ index: 0, count: 1, start: 0, end: body.length, text: body, leadIn: null }];
  if (options.allowSplit === false) return single;
  const total = countTokens(body);
  if (total <= threshold) return single;

  const lines = linesOf(body);
  let target = options.target ?? CHUNK_TARGET_TOKENS;
  let atoms: Range[] = [];
  // A longer body grows the target rather than the call count.
  for (let attempt = 0; attempt < 8; attempt++) {
    atoms = dropBlank(body, atomize(body, lines, countTokens, target));
    if (atoms.length <= maxChunks) break;
    target = Math.ceil(Math.max(target * 1.25, total / maxChunks));
  }
  if (atoms.length > maxChunks) return single;
  if (atoms.length <= 1) return single;

  return atoms.map(([start, end], index) => {
    const text = body.slice(start, end);
    return {
      index,
      count: atoms.length,
      start,
      end,
      text,
      leadIn: index === 0 ? null : leadInOf(body.slice(atoms[index - 1][0], atoms[index - 1][1])),
    };
  });
}
