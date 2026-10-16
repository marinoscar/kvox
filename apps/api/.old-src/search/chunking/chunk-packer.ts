// =============================================================================
// THE SHARED PACKER (issue #186, epic #165)
// =============================================================================
//
// `chunkTranscript` and `chunkNote` differ only in how they cut a document into
// units and what decoration they hang on one. Everything after that — packing
// units up to the budget, carrying overlap backwards across the seam, hard-
// splitting a unit nothing can hold, refusing to emit whitespace, mapping the
// result back to source offsets, hashing — is identical, and is here.
//
// It lives in its own file rather than being written twice because the two
// copies would diverge on the first bug fix, and the symptom of divergence is
// not a failing test: it is transcripts and notes disagreeing about where a
// boundary goes, which nobody notices until someone compares two hashes that
// were supposed to have been produced by the same rule.
//
// ⚠ PURE. See `chunk.types.ts`'s header.
//
// -----------------------------------------------------------------------------
// HOW SOURCE OFFSETS SURVIVE DECORATION
// -----------------------------------------------------------------------------
//
// A chunk's text is not a substring of the source: it carries a note title, or
// `Speaker A: ` labels, that the source body does not have. So a chunk is built
// as a list of PIECES, each of which knows how its rendered characters map back
// to the source:
//
//   - a source piece renders verbatim and advances the source offset with it;
//   - a decoration piece renders characters the source does not contain and
//     occupies ZERO source width, pinned at the offset it decorates.
//
// That representation is what makes overlap correct rather than approximate.
// The overlap is taken as a suffix of the PREVIOUS CHUNK'S PIECES, not as a
// substring of the raw source, so it arrives already carrying the labels the
// previous chunk had rendered — and slicing the piece list at a rendered offset
// yields the source offset the new chunk should report as its `charStart`,
// by construction rather than by a second calculation that could disagree.
// =============================================================================

import {
  Chunk,
  HARD_SPLIT_BACKTRACK_CHARS,
} from './chunk.types';
import { contentHash } from './content-hash';

/**
 * One indivisible span of a document: a transcript segment, a note paragraph, a
 * note heading, a fenced code block. The packer never splits one of these
 * unless it is longer than the whole budget on its own.
 */
export interface ChunkUnit {
  /**
   * This unit's text, verbatim, exactly as it appears in the reconstructed
   * source body. Must be non-empty and must not be whitespace-only; callers
   * drop those before they get here.
   */
  readonly source: string;

  /** Offset of `source` within the reconstructed source body. */
  readonly sourceStart: number;

  /**
   * Text rendered in front of `source` inside a chunk but ABSENT from the
   * source body — a speaker label such as `'Speaker A: '`. Rendered when the
   * unit opens a chunk, and otherwise only when it differs from the preceding
   * unit's decoration: a wall of identical labels wastes budget and dilutes the
   * embedding toward the label instead of the words. Empty string for a
   * document that has no per-unit decoration.
   */
  readonly decoration: string;

  /**
   * The exact source text that sits between the preceding unit and this one in
   * the reconstructed source body (`'\n'` between transcript segments, `'\n\n'`
   * between note blocks, `''` between the pieces of a hard-split unit). Empty
   * for the first unit.
   *
   * It is supplied by the caller rather than assumed by the packer because it
   * is real source text with real offsets — rendering a separator the source
   * does not contain would put every subsequent `charStart` off by its length.
   */
  readonly precedingSeparator: string;

  /**
   * Force a chunk boundary in front of this unit — a markdown heading. The
   * overlap is dropped at such a boundary; see `packChunks`.
   */
  readonly breakBefore?: boolean;
}

export interface PackOptions {
  /** Repeated at the head of every chunk, and counted against `maxChars`. */
  readonly prefix: string;
  /** Ceiling on a chunk's final text, `prefix` included. */
  readonly maxChars: number;
  /** Ceiling on how far back each chunk reaches into its predecessor. */
  readonly overlapChars: number;
  /** How far forward from the raw overlap cut a sentence boundary is sought. */
  readonly sentenceLookaheadChars: number;
}

interface Piece {
  readonly text: string;
  readonly sourceStart: number;
  /**
   * Leading characters of `text` that are decoration. A piece is either wholly
   * decoration (`decorationLength === text.length`, zero source width) or wholly
   * source (`decorationLength === 0`); the general form exists so that slicing a
   * piece part-way through a decoration stays representable.
   */
  readonly decorationLength: number;
}

const pieceSourceEnd = (piece: Piece): number =>
  piece.sourceStart + Math.max(0, piece.text.length - piece.decorationLength);

const piecesText = (pieces: readonly Piece[]): string =>
  pieces.map((piece) => piece.text).join('');

const piecesLength = (pieces: readonly Piece[]): number =>
  pieces.reduce((total, piece) => total + piece.text.length, 0);

/**
 * The suffix of `pieces` beginning at rendered offset `cut`, with source
 * offsets adjusted. This is how overlap is carried: the returned pieces render
 * to exactly `piecesText(pieces).slice(cut)` and report exactly the source span
 * that substring came from.
 */
function slicePiecesFrom(pieces: readonly Piece[], cut: number): Piece[] {
  const out: Piece[] = [];
  let offset = 0;
  for (const piece of pieces) {
    const end = offset + piece.text.length;
    if (end <= cut) {
      offset = end;
      continue;
    }
    if (offset >= cut) {
      out.push(piece);
      offset = end;
      continue;
    }
    const within = cut - offset;
    out.push(
      within < piece.decorationLength
        ? {
            text: piece.text.slice(within),
            sourceStart: piece.sourceStart,
            decorationLength: piece.decorationLength - within,
          }
        : {
            text: piece.text.slice(within),
            sourceStart: piece.sourceStart + (within - piece.decorationLength),
            decorationLength: 0,
          },
    );
    offset = end;
  }
  return out;
}

/**
 * Moves `cut` back to the start of a decoration it landed inside.
 *
 * Without this, an overlap whose cut fell two characters into `'Speaker A: '`
 * would open the next chunk with `'eaker A: '` — a fragment that is noise as an
 * embedding input, and that would also mean a chunk's text was no longer the
 * source region with whole decorations inserted, which is the property that
 * makes `charStart`/`charEnd` mean what they say. Moving backwards rather than
 * forwards keeps the label: the overlap grows by at most a decoration's length,
 * which `fits` accounts for anyway.
 */
function snapCutOutOfDecoration(pieces: readonly Piece[], cut: number): number {
  let offset = 0;
  for (const piece of pieces) {
    const end = offset + piece.text.length;
    if (cut > offset && cut < offset + piece.decorationLength) return offset;
    if (cut <= end) return cut;
    offset = end;
  }
  return cut;
}

const isWhitespace = (char: string): boolean => /\s/.test(char);

const skipWhitespace = (text: string, from: number): number => {
  let index = from;
  while (index < text.length && isWhitespace(text[index])) index += 1;
  return index;
};

/**
 * Where the overlap carried into the next chunk begins, as a rendered offset
 * into `body`. Returns `body.length` when there is to be no overlap.
 *
 * The raw cut is `overlapChars` from the end, additionally capped at half the
 * body so that a short chunk (one flushed early by a heading, say) cannot be
 * carried over in its ENTIRETY — that would duplicate a whole chunk into its
 * successor rather than overlapping it.
 *
 * From the raw cut the search runs FORWARD, up to `lookahead` characters, for a
 * sentence boundary — a newline, or `.`/`!`/`?` followed by whitespace — and
 * starts the overlap after it. Forward, so the search can only shorten the
 * overlap and `overlapChars` stays a ceiling. When no boundary is found within
 * the window the raw cut stands: the hard character cut, deliberately, rather
 * than searching on and emitting nothing.
 */
export function overlapCut(
  body: string,
  overlapChars: number,
  lookahead: number,
): number {
  const maxOverlap = Math.min(overlapChars, Math.floor(body.length / 2));
  if (maxOverlap <= 0) return body.length;

  const rawCut = body.length - maxOverlap;
  const limit = Math.min(body.length, rawCut + lookahead);
  for (let index = rawCut; index < limit; index += 1) {
    const char = body[index];
    if (char === '\n') return skipWhitespace(body, index + 1);
    if (
      (char === '.' || char === '!' || char === '?') &&
      (index + 1 >= body.length || isWhitespace(body[index + 1]))
    ) {
      return skipWhitespace(body, index + 1);
    }
  }
  return skipWhitespace(body, rawCut);
}

/**
 * How many characters of `source` to take from `offset`, given a window that
 * does not reach the end. Prefers the last whitespace in the final
 * `HARD_SPLIT_BACKTRACK_CHARS` of the window and cuts just AFTER it, so the
 * split lands between words where one is available and no character is lost
 * either way.
 */
function hardSplitTake(source: string, offset: number, window: number): number {
  const windowEnd = offset + window;
  const floor = Math.max(offset + 1, windowEnd - HARD_SPLIT_BACKTRACK_CHARS);
  for (let index = windowEnd - 1; index >= floor; index -= 1) {
    if (isWhitespace(source[index])) return index - offset + 1;
  }
  return window;
}

/**
 * Replaces any unit that cannot fit a chunk on its own with a run of units that
 * can. A unit longer than the budget is HARD-SPLIT, never dropped: a
 * forty-minute uninterrupted monologue, or a pasted thousand-line log, is
 * exactly the content somebody later searches for.
 *
 * The window leaves room for the overlap and for the widest separator, so each
 * piece still gets an overlapping predecessor rather than standing alone. The
 * decoration is repeated on every piece — a continuation chunk should still say
 * who is speaking — and `breakBefore` belongs to the first piece only.
 */
function expandOversized(
  units: readonly ChunkUnit[],
  bodyBudget: number,
  overlapChars: number,
): ChunkUnit[] {
  const out: ChunkUnit[] = [];
  for (const unit of units) {
    if (unit.decoration.length + unit.source.length <= bodyBudget) {
      out.push(unit);
      continue;
    }
    // `- 2` is the widest separator this module renders (`'\n\n'`), reserved so
    // the first piece still fits once the carried overlap is prepended.
    const window = Math.max(
      1,
      bodyBudget - overlapChars - unit.decoration.length - 2,
    );
    let offset = 0;
    let first = true;
    while (offset < unit.source.length) {
      const remaining = unit.source.length - offset;
      const take =
        remaining <= window
          ? remaining
          : hardSplitTake(unit.source, offset, window);
      out.push({
        source: unit.source.slice(offset, offset + take),
        sourceStart: unit.sourceStart + offset,
        decoration: unit.decoration,
        precedingSeparator: first ? unit.precedingSeparator : '',
        breakBefore: first ? unit.breakBefore : false,
      });
      offset += take;
      first = false;
    }
  }
  return out;
}

/**
 * Packs units into chunks: the whole of the shared algorithm.
 *
 * Guarantees, each pinned by `chunk-packer.spec.ts`:
 *   - no chunk's `text` exceeds `maxChars`, `prefix` included;
 *   - no chunk is empty or whitespace-only;
 *   - `ordinal` runs 0, 1, 2, … over the emitted chunks;
 *   - `charStart`/`charEnd` index the reconstructed source body and are
 *     strictly increasing from chunk to chunk;
 *   - every unit's source span is wholly contained in at least one chunk's
 *     span, so nothing is dropped;
 *   - consecutive chunks either overlap (`charStart[i+1] <= charEnd[i]`) or, at
 *     a boundary where the overlap was deliberately dropped — a heading, or a
 *     unit that left no room for it — abut across exactly the source separator
 *     that already sat between them.
 */
export function packChunks(
  units: readonly ChunkUnit[],
  options: PackOptions,
): Chunk[] {
  const { prefix, maxChars, overlapChars, sentenceLookaheadChars } = options;
  const bodyBudget = Math.max(1, maxChars - prefix.length);
  const expanded = expandOversized(units, bodyBudget, overlapChars);

  const chunks: Chunk[] = [];
  /** The chunk under construction: carried overlap first, then new units. */
  let current: Piece[] = [];
  /** Whether `current` holds anything beyond carried overlap. */
  let hasContent = false;
  /** The previous unit's decoration within `current`, for the repeat rule. */
  let previousDecoration = '';

  /** The decoration `unit` would render given the state of `current`. */
  const decorationFor = (unit: ChunkUnit): string =>
    !hasContent || unit.decoration !== previousDecoration ? unit.decoration : '';

  const fits = (unit: ChunkUnit): boolean => {
    const separator = current.length > 0 ? unit.precedingSeparator : '';
    return (
      piecesLength(current) +
        separator.length +
        decorationFor(unit).length +
        unit.source.length <=
      bodyBudget
    );
  };

  const reset = (): void => {
    current = [];
    hasContent = false;
    previousDecoration = '';
  };

  const flush = (): void => {
    const body = piecesText(current);
    // Defensive: callers drop blank units and `expandOversized` cannot
    // manufacture one, so this should be unreachable. It is here so that the
    // "never emit an empty or whitespace-only chunk" guarantee is a property of
    // the emitter rather than of every caller remembering.
    if (body.trim().length === 0) {
      reset();
      return;
    }
    const text = prefix + body;
    chunks.push({
      ordinal: chunks.length,
      text,
      contentHash: contentHash(text),
      charStart: current[0].sourceStart,
      charEnd: pieceSourceEnd(current[current.length - 1]),
    });
    const cut = snapCutOutOfDecoration(
      current,
      overlapCut(body, overlapChars, sentenceLookaheadChars),
    );
    const carried = cut >= body.length ? [] : slicePiecesFrom(current, cut);
    reset();
    current = carried;
  };

  for (const unit of expanded) {
    if (hasContent && (unit.breakBefore === true || !fits(unit))) {
      flush();
      if (unit.breakBefore === true) {
        // A heading is a topical boundary, so the overlap is dropped rather
        // than carried across it: the tail of the previous section dilutes the
        // new section's embedding with the subject it was written to leave.
        reset();
      }
    }
    if (current.length > 0 && !fits(unit)) {
      // The carried overlap does not leave room for this unit. Drop the
      // overlap; a chunk that holds its unit beats a chunk that holds an
      // overlap and has to split the unit.
      reset();
    }

    const separator = current.length > 0 ? unit.precedingSeparator : '';
    if (separator.length > 0) {
      current.push({
        text: separator,
        sourceStart: unit.sourceStart - separator.length,
        decorationLength: 0,
      });
    }
    const decoration = decorationFor(unit);
    if (decoration.length > 0) {
      current.push({
        text: decoration,
        sourceStart: unit.sourceStart,
        decorationLength: decoration.length,
      });
    }
    current.push({
      text: unit.source,
      sourceStart: unit.sourceStart,
      decorationLength: 0,
    });
    hasContent = true;
    previousDecoration = unit.decoration;
  }

  if (hasContent) flush();
  return chunks;
}
