// =============================================================================
// CHUNKING A NOTE (issue #186, epic #165)
// =============================================================================
//
// ⚠ PURE. See `chunk.types.ts`'s header for why that is the requirement.
//
// -----------------------------------------------------------------------------
// WHY EVERY CHUNK CARRIES THE TITLE
// -----------------------------------------------------------------------------
//
// A chunk from the middle of a note has no idea what document it belongs to. It
// reads as context-free prose — "we agreed to defer it until the numbers come
// back" — and embeds as context-free prose, matching nothing in particular.
// Prefixing the note's title puts the document's subject into every one of its
// embedding inputs, which is exactly the signal a query like "what did we
// decide about the Q3 budget" needs in order to reach a paragraph that never
// says "Q3" or "budget".
//
// The title costs its own length out of every chunk's budget, which is why
// `MAX_TITLE_PREFIX_CHARS` bounds it.
//
// -----------------------------------------------------------------------------
// MARKDOWN STRUCTURE FIRST, CHARACTERS ONLY AS A LAST RESORT
// -----------------------------------------------------------------------------
//
// A note is a written document with a shape its author gave it, and that shape
// is a far better guide to where a passage ends than a character count is. So
// the body is cut in three descending tiers:
//
//   1. A heading (`#`..`######`) STARTS A NEW CHUNK. A section is a topic; the
//      last paragraph before a heading and the first paragraph after it are the
//      two least related paragraphs in the document, and a chunk spanning them
//      averages two subjects into one vector.
//   2. Within a section, blank-line-separated paragraphs are the packing unit,
//      and several are packed together while they fit.
//   3. Only a unit too large for the whole budget is cut on characters.
//
// ⚠ A FENCED CODE BLOCK IS ONE UNIT. A blank line inside a fence is not a
// paragraph break, and a chunk ending mid-fence embeds a half-fence: an opening
// ``` with no close, a fragment of a function, indentation with nothing to
// indent under. It is noise as an embedding input and it is worse as a search
// result, because the reader is shown code that does not parse. A fence that
// fits the budget is never split; one that does not is hard-split like anything
// else, because dropping it would be worse still.
// =============================================================================

import {
  Chunk,
  CHUNK_OVERLAP_CHARS,
  MAX_CHUNK_CHARS,
  MAX_TITLE_PREFIX_CHARS,
  OVERLAP_SENTENCE_LOOKAHEAD_CHARS,
} from './chunk.types';
import { ChunkUnit, packChunks } from './chunk-packer';

/** The separator between blocks in the reconstructed source body. */
export const NOTE_BLOCK_SEPARATOR = '\n\n';

/** A heading, a paragraph, or a fenced code block. */
interface NoteBlock {
  readonly text: string;
  readonly breakBefore: boolean;
}

/** Up to three leading spaces, then `#`..`######`, then space or end of line. */
const HEADING_RE = /^ {0,3}#{1,6}(\s|$)/;
/** Up to three leading spaces, then three or more backticks or tildes. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
/** The same, with nothing but whitespace after it: a closing fence. */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * Cuts a markdown body into blocks. Pure string work, no markdown library: this
 * is a chunking heuristic, not a renderer, and a parser dependency would put a
 * third party's version number inside the content hash.
 */
function splitNoteBlocks(body: string): NoteBlock[] {
  // CRLF is normalized away first, so the same document does not chunk
  // differently for having been round-tripped through a Windows editor.
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const blocks: NoteBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    const text = paragraph.join('\n').trim();
    if (text.length > 0) blocks.push({ text, breakBefore: false });
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const opening = FENCE_OPEN_RE.exec(line);

    if (opening !== null) {
      flushParagraph();
      const marker = opening[1];
      const fence: string[] = [line];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        fence.push(candidate);
        index += 1;
        const closing = FENCE_CLOSE_RE.exec(candidate);
        // A fence closes on the same character, repeated at least as many
        // times. An unterminated fence simply runs to the end of the note,
        // which is also how every markdown renderer treats it.
        if (
          closing !== null &&
          closing[1][0] === marker[0] &&
          closing[1].length >= marker.length
        ) {
          break;
        }
      }
      const text = fence.join('\n').replace(/\s+$/, '');
      if (text.trim().length > 0) blocks.push({ text, breakBefore: false });
      continue;
    }

    if (HEADING_RE.test(line)) {
      flushParagraph();
      const text = line.trim();
      if (text.length > 0) blocks.push({ text, breakBefore: true });
      index += 1;
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

/**
 * The prefix every chunk of a note carries: the title, whitespace-collapsed,
 * bounded, followed by a blank line. Empty string for a note with no usable
 * title — an untitled note is chunked without a prefix rather than with a
 * decorative empty one.
 *
 * Exported because a consumer holding a chunk's `text` may need to strip it to
 * recover the body, and re-deriving the rule by hand is how the two drift.
 */
export function noteChunkPrefix(title: string): string {
  const collapsed = title
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_PREFIX_CHARS)
    .trim();
  return collapsed.length > 0 ? `${collapsed}\n\n` : '';
}

/**
 * The reconstructed source body `Chunk.charStart`/`charEnd` index: the note's
 * blocks, each trimmed, joined by a blank line.
 *
 * ⚠ THIS IS NOT THE RAW `notes.body` COLUMN, and the difference is the point of
 * exporting it. The reconstruction collapses the incidental whitespace between
 * blocks — three blank lines or one become the same separator — so that the
 * offsets a chunk reports are offsets into a canonical string rather than into
 * whatever spacing the author happened to leave. A later snippet feature calls
 * this on the same body, slices the result, and gets exactly the region the
 * chunk was built from.
 */
export function noteSourceBody(body: string): string {
  return splitNoteBlocks(body)
    .map((block) => block.text)
    .join(NOTE_BLOCK_SEPARATOR);
}

/**
 * Cuts a note into bounded, overlapping, title-prefixed chunks.
 *
 * An empty or whitespace-only body returns `[]`, whatever the title says: a
 * note with no content has nothing to embed, and a chunk consisting of a title
 * and nothing else would match every query about that title with no text behind
 * it to justify the hit.
 */
export function chunkNote(title: string, body: string): Chunk[] {
  const blocks = splitNoteBlocks(body);
  if (blocks.length === 0) return [];

  const units: ChunkUnit[] = [];
  let offset = 0;
  blocks.forEach((block, index) => {
    const separator = index === 0 ? '' : NOTE_BLOCK_SEPARATOR;
    offset += separator.length;
    units.push({
      source: block.text,
      sourceStart: offset,
      decoration: '',
      precedingSeparator: separator,
      breakBefore: block.breakBefore,
    });
    offset += block.text.length;
  });

  return packChunks(units, {
    prefix: noteChunkPrefix(title),
    maxChars: MAX_CHUNK_CHARS,
    overlapChars: CHUNK_OVERLAP_CHARS,
    sentenceLookaheadChars: OVERLAP_SENTENCE_LOOKAHEAD_CHARS,
  });
}
