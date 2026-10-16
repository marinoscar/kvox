import { MAX_TITLE_CHARS } from '../dto/note.dto';

// =============================================================================
// Deriving a title from the note's own text (issue #182, epic #163) — RANK 2
// =============================================================================
//
// Three ranks name a generated note, each a fallback for the one above it: a
// dedicated titling completion, then THIS, then leaving the title alone. This
// file is the middle rank, and everything about it follows from WHERE it sits
// in that list.
//
// -----------------------------------------------------------------------------
// IT IS PURE, AND THE PURITY IS THE WHOLE REASON IT IS A SEPARATE FILE
// -----------------------------------------------------------------------------
//
// No `@Injectable`, no `PrismaService`, no provider, no key, no network, no
// clock — the same rule `prompt.ts` and `apps/api/src/transcripts/editing/`
// live under, for a reason of its own here: this is the rank that has to work
// when EVERYTHING ELSE HAS ALREADY FAILED. It is reached precisely because the
// deployment has AI switched off, or the user's key was erased between the
// generation and the titling, or the vendor returned a 429, or the provider
// this note names is not in this build. A fallback that needed any of those
// things to be working would not be a fallback; it would be a second copy of
// the thing that just broke.
//
// Living inside `NoteTitleService` would make that impossible to see and
// impossible to test without a module: the one function here takes a string and
// a number and returns a string or `null`, which is the entire contract.
//
// -----------------------------------------------------------------------------
// WHY A HEADING FIRST, AND A SENTENCE ONLY AFTER
// -----------------------------------------------------------------------------
//
// A generated note's first heading is the model's own answer to "what is this
// document", written when it had the whole source in front of it. Nothing this
// file could compute is a better title than that. The first sentence is the
// honest second best — it describes the note without claiming to summarise it —
// and both are truncated on a word boundary rather than mid-word, because a
// title is read at a glance in a list and `Q3 revenue review for the No…` is
// legible where `Q3 revenue review for the Nor` reads like a bug.
//
// ⚠ THE ELLIPSIS IS THE SINGLE CHARACTER `…`, NOT THREE DOTS. Three dots cost
// three of the characters the ceiling is counting and sort differently; the one
// character is what the rest of this application truncates with.
// =============================================================================

/** Re-exported so a caller needs one import for "derive a title" + its ceiling. */
export { MAX_TITLE_CHARS };

/** ATX heading: up to three spaces of indent, one to six `#`, then text. */
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;

/** A fenced code block's opening or closing line. */
const FENCE = /^ {0,3}(```|~~~)/;

/** A bullet or ordered list item. */
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])\s+/;

/** A thematic break — `---`, `***`, `___` — including a setext underline. */
const THEMATIC_BREAK = /^ {0,3}([-*_=])(\s*\1){2,}\s*$/;

/** The end of a sentence: `.`, `!` or `?` followed by whitespace or the end. */
const SENTENCE_END = /[.!?](\s|$)/;

/**
 * A title for this note taken from the note's own text, or `null`.
 *
 * TOTAL AND NEVER THROWS. It is called on a body that a language model wrote,
 * which means it is called on Markdown, on plain prose, on a single code fence,
 * and one day on something nobody has thought of. Every one of those that
 * yields no sensible title is `null` — rank 3, "leave the title alone" — and
 * never an exception, because the note it would be thrown from is already
 * committed and durable.
 *
 * @param body     The committed note body, as Markdown.
 * @param maxChars The ceiling, passed in rather than read: see {@link MAX_TITLE_CHARS}.
 */
export function deriveTitleFromBody(body: string, maxChars: number): string | null {
  if (typeof body !== 'string' || body.trim().length === 0) return null;
  if (!Number.isFinite(maxChars) || maxChars < 1) return null;

  const lines = body.split(/\r?\n/);

  const heading = firstHeading(lines);

  if (heading) return truncateTitle(heading, maxChars);

  const sentence = firstSentence(lines);

  return sentence ? truncateTitle(sentence, maxChars) : null;
}

/**
 * Cut `text` to `maxChars`, on a word boundary, with a trailing `…` when it had
 * to cut.
 *
 * ⚠ THE RESULT INCLUDING THE ELLIPSIS IS WITHIN `maxChars`. The ceiling is a
 * database column's, so a truncation that overshot it by the one character it
 * added would fail the write it exists to make safe.
 *
 * Exported because {@link deriveTitleFromBody} is not the only thing that has
 * to respect that ceiling — `NoteTitleService` truncates an over-long model
 * answer the same way, and two truncations that could disagree about where a
 * word ends is exactly the drift this module's purity is for.
 */
export function truncateTitle(text: string, maxChars: number): string {
  const trimmed = text.trim();

  if (trimmed.length <= maxChars) return trimmed;

  const room = maxChars - 1;
  const head = trimmed.slice(0, room);
  const lastSpace = head.lastIndexOf(' ');

  // A single word longer than the whole ceiling (a URL, a chemical name) has no
  // boundary to cut on, so it is cut where it is — still within the ceiling.
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head;

  return `${cut.replace(/[\s,;:–—-]+$/, '')}…`;
}

// -----------------------------------------------------------------------------
// The two candidates
// -----------------------------------------------------------------------------

/** The first ATX heading's text, cleaned of markup, or `null`. */
function firstHeading(lines: string[]): string | null {
  let fenced = false;

  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;

      continue;
    }

    if (fenced) continue;

    const match = HEADING.exec(line);

    if (!match) continue;

    // `## Overview ##` — a closing run of `#` is decoration, not content.
    const text = stripInlineMarkdown(match[2].replace(/\s+#+\s*$/, ''));

    if (text.length > 0) return text;
  }

  return null;
}

/**
 * The first sentence of the first paragraph that is ordinary prose, or `null`.
 *
 * "Ordinary prose" excludes headings (they had their chance above), list items,
 * fenced code, thematic breaks, table rows and block quotes. A quote is
 * somebody else's words carried into the note, which is the one kind of text
 * that reads as a description of the note while describing something else.
 */
function firstSentence(lines: string[]): string | null {
  let fenced = false;
  const paragraph: string[] = [];

  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;

      // A fence closes whatever prose preceded it.
      if (paragraph.length > 0) break;

      continue;
    }

    if (fenced) continue;

    if (isProse(line)) {
      paragraph.push(line.trim());

      continue;
    }

    // Anything else ends the paragraph — but only once one has started, so the
    // headings and lists a note opens with are skipped rather than stopping us.
    if (paragraph.length > 0) break;
  }

  if (paragraph.length === 0) return null;

  const text = stripInlineMarkdown(paragraph.join(' '));

  if (text.length === 0) return null;

  const end = SENTENCE_END.exec(text);

  // No terminator at all means the paragraph IS the sentence — a heading-shaped
  // line that never got a full stop. `truncateTitle` bounds it either way.
  const sentence = end ? text.slice(0, end.index) : text;

  return sentence.trim().length > 0 ? sentence.trim() : null;
}

/** Is this line a line of ordinary prose? */
function isProse(line: string): boolean {
  const trimmed = line.trim();

  if (trimmed.length === 0) return false;
  if (HEADING.test(line)) return false;
  if (LIST_ITEM.test(line)) return false;
  if (THEMATIC_BREAK.test(line)) return false;
  if (/^ {0,3}>/.test(line)) return false;
  if (trimmed.startsWith('|')) return false;
  if (trimmed.startsWith('<')) return false;

  return true;
}

// -----------------------------------------------------------------------------
// Inline markup
// -----------------------------------------------------------------------------

/**
 * The text a human would read, with Markdown's inline markup taken off.
 *
 * ⚠ THE POINT IS THAT A TITLE IS NEVER `**Overview**`. It is rendered as plain
 * text in a list row, an email subject and a browser tab — none of which render
 * Markdown — so markup that survives here is markup the user reads verbatim.
 *
 * Underscore emphasis is matched ONLY at word boundaries, so `note_generations`
 * and `snake_case_names` survive intact; asterisk emphasis needs no such care
 * because no identifier contains one.
 */
function stripInlineMarkdown(text: string): string {
  return text
    // Images first, then links: `![alt](src)` and `[label](href)` keep the part
    // a person actually reads, and reference links `[label][id]` do the same.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/(^|[\s(])_{1,3}([^_]+)_{1,3}(?=[\s).,;:!?]|$)/g, '$1$2')
    // Any leftover marker characters that were never part of a pair.
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
