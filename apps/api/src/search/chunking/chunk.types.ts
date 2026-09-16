// =============================================================================
// THE CHUNK CONTRACT AND THE BUDGETS (issue #186, epic #165 — Semantic Search)
// =============================================================================
//
// `apps/api/src/search/chunking/` turns a transcript or a note into bounded,
// overlapping windows of text suitable for embedding. Nothing consumes it yet;
// the `search.index` job of a later issue is its first caller.
//
// -----------------------------------------------------------------------------
// ⚠ EVERYTHING IN THIS DIRECTORY IS PURE, AND THAT IS THE REQUIREMENT
// -----------------------------------------------------------------------------
//
// No `PrismaService`. No `@Injectable`. No `randomUUID()`. No `Date.now()`. No
// reads of mutable module state. No locale-dependent operation (`localeCompare`,
// `toLocaleUpperCase`, `Intl`) — a chunker whose boundaries move with `LANG`
// produces different chunks on a developer's laptop than in production. Plain
// exported functions, taking plain structural types, returning plain data.
//
// This is not tidiness. Content addressing is the entire economic argument for
// this epic: re-indexing an edited document re-embeds only the chunks whose text
// actually moved, and the owner is billed for only those. That property rests on
// one premise — THE SAME INPUT PRODUCES BYTE-IDENTICAL CHUNKS EVERY TIME. A
// chunker that consulted a clock, a random source, a database row or a locale
// would produce a different `contentHash` for unchanged text, every chunk of
// every document would look edited on every pass, and the incremental
// re-indexing that justifies the design would silently degrade into a full
// re-embed of everything, forever, with no error anywhere to say so.
//
// The precedent is `apps/api/src/transcripts/editing/` (issue #27, epic #19),
// which holds exactly this discipline for exactly this kind of reason: its
// reducers are pure so that `materialize()` — replaying a version log through
// *the same functions* the live edit path calls — agrees with the live tables
// BY CONSTRUCTION rather than by two implementations being kept in step. Read
// that directory's `index.ts` header; it states the rule and names the one
// operation (`materialize()`, which genuinely needs a database) that is kept
// deliberately OUTSIDE the directory so the barrel can never become the file
// through which a reducer acquires a row. Same rule here, same reason shape:
// the moment something in this directory can read mutable state, the hash stops
// being a function of the text.
//
// `index.spec.ts` is the executable form of that rule, in the same spirit as
// `apps/api/test/jobs/cron-enqueue-only.spec.ts`.
//
// -----------------------------------------------------------------------------
// ⚠ WHY A CHARACTER BUDGET AND NOT A TOKEN BUDGET
// -----------------------------------------------------------------------------
//
// A token-based budget would need a tokenizer, which is per-model, which makes
// the chunk boundary depend on the model, which makes the content hash depend on
// the model, which defeats content addressing entirely. Swapping
// `text-embedding-3-small` for its successor, or for a local model, would
// re-cut every boundary in the corpus and invalidate every stored hash — a
// migration whose cost is "re-embed everything" paid for a property the budget
// was never supposed to have.
//
// A character budget calibrated conservatively against the model's token
// ceiling costs a little headroom and keeps the chunker model-independent. The
// headroom is the whole price, and it is small: see the numbers below.
// =============================================================================

/**
 * One embedding input: a bounded window of a document, with the offsets that
 * say where in the document it came from.
 */
export interface Chunk {
  /** 0-based position within the document. */
  ordinal: number;

  /**
   * The exact text that will be embedded, prefix included.
   *
   * ⚠ This is NOT a substring of the source. A note chunk carries the note's
   * title at its head; a transcript chunk carries `Speaker A: ` labels its
   * source body does not have. Those decorations are part of what gets embedded
   * and therefore part of what gets hashed — see `contentHash` in
   * `content-hash.ts`.
   */
  text: string;

  /** sha256 of `text`. The content-addressing key. */
  contentHash: string;

  /**
   * Character offsets into the SOURCE text this chunk came from.
   *
   * ⚠ FRAME OF REFERENCE, STATED PRECISELY BECAUSE GETTING IT WRONG IS SILENT.
   * These index the **reconstructed source body** — the string returned by
   * `transcriptSourceBody(segments)` or `noteSourceBody(body)` for the very same
   * input — and NOT the chunk's own `text`, and NOT the raw column the source
   * was read from. The reconstruction is deterministic and is exported
   * alongside each chunker precisely so a later snippet/highlight feature can
   * rebuild the identical string and slice it; `source.slice(charStart,
   * charEnd)` is then genuinely the region this chunk was built from, including
   * whatever the chunk carried over as overlap from its predecessor.
   *
   * `charEnd` is exclusive. Consecutive chunks deliberately overlap, so
   * `chunks[i + 1].charStart <= chunks[i].charEnd`.
   */
  charStart: number;
  charEnd: number;
}

// -----------------------------------------------------------------------------
// The budgets. Numbers, with the arithmetic that produced them.
// -----------------------------------------------------------------------------

/**
 * `text-embedding-3-small`'s documented per-input ceiling, in tokens. Present
 * as a named constant only so the calibration below can be checked rather than
 * asserted — see `chunk.types.spec.ts`. Nothing in this directory tokenizes.
 */
export const EMBEDDING_INPUT_TOKEN_CEILING = 8191;

/**
 * The conservative characters-per-token floor the character budget is
 * calibrated against.
 *
 * English prose averages roughly 4 characters per token under a BPE tokenizer;
 * dense technical text, CJK, code and heavy punctuation run lower. 3.5 is
 * deliberately pessimistic — it OVERESTIMATES how many tokens a given number of
 * characters becomes, so the derived character budget errs toward chunks that
 * are too small rather than inputs the model refuses.
 */
export const CHARS_PER_TOKEN_FLOOR = 3.5;

/**
 * The ceiling on a single chunk's FINAL text — prefix, speaker labels and
 * overlap all included — in characters.
 *
 * 1600 / 3.5 ≈ 457 tokens: about 5.6% of the 8191-token ceiling, so the
 * conservative calibration is nowhere near binding. The number is NOT chosen by
 * pushing the ceiling; it is chosen for retrieval quality, which wants chunks of
 * a few hundred tokens rather than eight thousand. An 8000-token chunk answers
 * "is this document about X" and nothing finer: the embedding is an average over
 * so much text that the one paragraph that actually answers the question is
 * averaged into noise, and the snippet handed back to the reader is three pages
 * long. A few hundred tokens is roughly a coherent passage — a couple of
 * exchanges in a conversation, one section of a note — which is the unit a
 * person is actually searching for.
 */
export const MAX_CHUNK_CHARS = 1600;

/**
 * How far back into its predecessor each chunk reaches, in characters.
 *
 * A fact that straddles a chunk boundary is otherwise findable by NEITHER
 * chunk: the sentence that names the thing lands in chunk N, the sentence that
 * says what was decided about it lands in chunk N+1, and each embedding is a
 * half-answer that matches the query weakly enough to lose to a chunk that is
 * merely on-topic. Overlapping the boundary means at least one chunk contains
 * the whole fact.
 *
 * 200 is 12.5% of `MAX_CHUNK_CHARS` — roughly one to two sentences. The trade is
 * direct and both directions are bad: too little and straddling facts stay lost;
 * too much and the corpus inflates (every character of overlap is a character
 * embedded, stored and billed twice) while near-duplicate chunks crowd each
 * other out of the top-k. `overlapCut` prefers a sentence boundary within a
 * bounded lookahead so the carried text is usually a whole sentence rather than
 * a fragment starting mid-word.
 */
export const CHUNK_OVERLAP_CHARS = 200;

/**
 * How far FORWARD from the raw overlap cut a sentence boundary is looked for.
 *
 * Forward, never backward, so a boundary search can only ever SHORTEN the
 * overlap — `CHUNK_OVERLAP_CHARS` stays a hard ceiling rather than a target the
 * search may overshoot. Bounded so that a passage with no sentence punctuation
 * for a thousand characters (a URL dump, a table, a transcript of someone
 * talking without pause) falls back to a hard character cut promptly instead of
 * searching to the end and emitting no overlap at all.
 */
export const OVERLAP_SENTENCE_LOOKAHEAD_CHARS = 160;

/**
 * When a single unit (one segment, one paragraph, one fenced code block) is
 * longer than the whole budget it is hard-split rather than dropped. Before
 * cutting at the exact window edge, this many characters are searched backwards
 * for whitespace, and the cut is taken just AFTER it — so the split lands
 * between words where one is available, and NO CHARACTER IS EVER LOST either
 * way (the whitespace ends the earlier piece rather than being discarded).
 */
export const HARD_SPLIT_BACKTRACK_CHARS = 80;

/**
 * The longest title, in characters, that may be prefixed onto every chunk of a
 * note. A title is repeated in every chunk of its note, so an unbounded one is
 * an unbounded tax on the budget: at 1600 characters a pathological title would
 * leave no room for the note. Titles longer than this are truncated for the
 * prefix only; nothing about the note itself is altered.
 */
export const MAX_TITLE_PREFIX_CHARS = 160;

/**
 * The longest speaker label, in characters, that may be prefixed onto a
 * transcript line. Same reasoning as `MAX_TITLE_PREFIX_CHARS`, one scale down:
 * a label is repeated at every speaker change.
 */
export const MAX_SPEAKER_LABEL_CHARS = 64;
