# Semantic Search

> Epic #165. This document is assembled section by section as the epic's issues
> land; a sibling issue writes the architecture overview, the index and query
> model, the ranking and the access rules. The section below is issue #186 and
> describes only chunking — how a transcript or a note becomes the bounded,
> overlapping windows that get embedded.

## Chunking

Embedding a document whole is not an option: models cap their input, and even
where they do not, one vector for a two-hour conversation answers "is this
about X" and nothing finer. So a document is cut into **chunks** — bounded,
overlapping windows of text — and each chunk is embedded, stored and searched
independently.

The code is `apps/api/src/search/chunking/`: `chunkTranscript(segments)`,
`chunkNote(title, body)`, `contentHash(text)`, `fingerprintDocument(chunks)`,
and the shared packer both chunkers run on. Nothing consumes it yet; the
`search.index` job of a later issue is its first caller.

### The chunk

```ts
interface Chunk {
  ordinal: number;     // 0-based position within the document
  text: string;        // the exact text that will be embedded, prefix included
  contentHash: string; // sha256 of `text` — the content-addressing key
  charStart: number;   // offsets into the RECONSTRUCTED SOURCE BODY
  charEnd: number;     // (exclusive)
}
```

⚠ **`charStart`/`charEnd` index the reconstructed source body, not the chunk's
own text.** The chunk carries decoration the source does not have — a note's
title at the head, a transcript's `Speaker A: ` labels — so the two strings have
different lengths and the offsets would be silently wrong against either the
chunk text or the raw database column. The reconstruction is deterministic and
exported alongside each chunker (`transcriptSourceBody(segments)`,
`noteSourceBody(body)`) precisely so a later snippet or highlight feature can
rebuild the identical string and slice it. It is canonical rather than raw:
segments are trimmed and blank ones dropped, a note's blocks are trimmed and the
incidental whitespace between them collapsed, so the offsets index a stable
string rather than whatever spacing an author happened to leave.

Consecutive chunks overlap, so `chunks[i + 1].charStart <= chunks[i].charEnd`.

### A character budget, not a token budget

`MAX_CHUNK_CHARS = 1600`, `CHUNK_OVERLAP_CHARS = 200`, and every other bound is
counted in **characters**.

A token-based budget would need a tokenizer, which is per-model, which makes the
chunk boundary depend on the model, which makes the content hash depend on the
model, which defeats content addressing entirely. Swapping
`text-embedding-3-small` for its successor, or for a local model, would re-cut
every boundary in the corpus and invalidate every stored hash — a migration
whose cost is "re-embed everything", paid for a property the budget was never
supposed to have. A character budget calibrated conservatively against the
model's token ceiling costs a little headroom and keeps the chunker
model-independent.

The calibration: `text-embedding-3-small` accepts 8191 tokens per input; at a
deliberately pessimistic 3.5 characters per token, 1600 characters is about 457
tokens, roughly 5.6% of the ceiling. The number is **not** chosen by pushing
that ceiling — it is chosen for retrieval quality, which wants chunks of a few
hundred tokens rather than eight thousand. An 8000-token chunk averages so much
text into one vector that the single paragraph which actually answers the
question is averaged into noise, and the snippet handed back to the reader is
three pages long. A few hundred tokens is roughly a coherent passage: a couple
of exchanges in a conversation, one section of a note — the unit a person is
actually searching for.

### Overlap

Each chunk reaches up to `CHUNK_OVERLAP_CHARS` back into its predecessor.

A fact that straddles a chunk boundary is otherwise findable by **neither**
chunk: the sentence naming the thing lands in chunk N, the sentence saying what
was decided about it lands in chunk N+1, and each embedding is a half-answer
that matches the query weakly enough to lose to a chunk that is merely on-topic.
Overlapping the seam means at least one chunk contains the whole fact.

200 characters is 12.5% of the budget — roughly one to two sentences. Both
directions of the trade are bad: too little and straddling facts stay lost; too
much and the corpus inflates (every overlapped character is embedded, stored and
billed twice) while near-duplicate chunks crowd each other out of the top-k.

The cut prefers a **sentence boundary** — a newline, or `.`/`!`/`?` followed by
whitespace — searched **forward** from the raw cut within
`OVERLAP_SENTENCE_LOOKAHEAD_CHARS`, so the search can only ever *shorten* the
overlap and the budget stays a ceiling rather than a target to overshoot. Text
with no punctuation for a thousand characters falls back to a hard character cut
promptly rather than searching on and carrying nothing. Two smaller rules round
it out: the overlap is additionally capped at half the chunk, so a short chunk
flushed early by a heading cannot be duplicated whole into its successor; and a
cut that lands inside a speaker label is snapped back to the start of that
label, because `eaker A: ` is noise as an embedding input.

The overlap is dropped at exactly one kind of boundary: a **markdown heading**.
A heading is a topical boundary, and carrying the tail of the previous section
across it dilutes the new section's embedding with the subject it was written to
leave.

### The prefixes: a title on every note chunk, a speaker on every transcript line

A chunk from the middle of a note has no idea what document it belongs to. It
reads as context-free prose — "we agreed to defer it until the numbers come
back" — and it embeds as context-free prose. So **every chunk of a note is
prefixed with the note's title**, which puts the document's subject into every
one of its embedding inputs and is exactly the signal a query like "what did we
decide about the Q3 budget" needs in order to reach a paragraph that never says
"Q3" or "budget".

A transcript's equivalent is the speaker. "What did Alice say about the
migration?" is a question about a speaker, and a chunk containing only the words
has nothing for the speaker half of it to match, so **the label goes into the
embedded text** at the head of the line it belongs to. It is emitted only when
it **changes**, and again at the head of each chunk. A label repeated on forty
consecutive lines of one person talking spends a tenth of the budget on the same
eleven characters and pulls the embedding toward the name and away from the
subject; emitting it once per run of lines says exactly as much. Re-stating it
at a chunk boundary is the other half of the same rule — a chunk that opens
mid-monologue would otherwise be unattributed prose.

Both prefixes are bounded (`MAX_TITLE_PREFIX_CHARS`, `MAX_SPEAKER_LABEL_CHARS`)
and both are **charged to the budget**, because they are repeated in every chunk
they apply to.

### Where a note is cut, in three descending tiers

A note is a written document with a shape its author gave it, and that shape is
a far better guide to where a passage ends than a character count is.

1. A **heading** (`#`..`######`) starts a new chunk. The last paragraph before a
   heading and the first paragraph after it are the two least related
   paragraphs in the document; a chunk spanning them averages two subjects into
   one vector.
2. Within a section, **blank-line-separated paragraphs** are the packing unit,
   and several are packed together while they fit.
3. Only a unit too large for the whole budget is cut on **characters**.

⚠ **A fenced code block is one unit.** A blank line inside a fence is not a
paragraph break, and a chunk ending mid-fence embeds a half-fence: an opening
` ``` ` with no close, a fragment of a function, indentation with nothing to
indent under. It is noise as an embedding input and worse as a search result,
because the reader is shown code that does not parse. A fence that fits is never
split. Splitting is done without a markdown library, deliberately: a parser
dependency would put a third party's version number inside the content hash.

An oversized unit — a forty-minute uninterrupted monologue, a pasted
thousand-line log, a code block larger than the budget — is **hard-split, never
dropped**. It is exactly the content somebody later searches for. The split
prefers whitespace within a bounded backtrack and cuts just *after* it, so no
character is lost either way, and the window leaves room for the overlap so each
piece still has an overlapping predecessor.

Two things never happen: an empty or whitespace-only chunk is never emitted (an
empty document returns `[]` rather than one empty chunk that would cost a vector
and match everything weakly), and no character of any unit fails to reach at
least one chunk.

### The hash is over the final text

`contentHash(chunk.text)` — the **final** text, prefix and speaker labels and
overlap included, never the raw source region it was cut from.

The prefix is part of what gets embedded. A paragraph under the title "Q3 Budget
Review" and the byte-identical paragraph under "Offsite Retro" are genuinely
different embedding inputs producing genuinely different vectors, and must not
share a hash. Hashing the source region instead would make them collide, and the
second note would silently reuse the first note's vector — a wrong answer with
no failure anywhere to notice it. The same holds for a transcript line
reattributed from `Speaker A` to `Alice`: the text a reader sees did not change,
the text the model embeds did.

`fingerprintDocument(chunks)` is a single hash over the **ordered** chunk
hashes, so "has this document changed at all" is one comparison rather than N.
It is what `search_index_state.contentFingerprint` stores. Order is part of it
on purpose: reordering a note's sections without editing a word produces the
same set of hashes in a different sequence, and that *is* a change — every
stored row's ordinal is stale even though no text needs re-embedding. A
commutative combiner (XOR, a sorted set) would call that document unchanged.

### ⚠ The purity rule

**`apps/api/src/search/chunking/` holds pure functions only.** No
`PrismaService`, no `@Injectable`, no NestJS module and no provider, no
`randomUUID()`, no `Date.now()`, no `process.env`, no reads of mutable module
state, no locale-dependent operation. Plain exported functions over plain
structural types — the transcript chunker deliberately does not import a Prisma
model type, it takes the three fields it actually reads.

This is the requirement, not a nicety. Content addressing is the entire economic
argument for this epic: re-indexing an edited document re-embeds only the chunks
whose text actually moved, and the owner is billed for only those. That rests on
one premise — **the same input produces byte-identical chunks every time**. A
chunker that consulted a clock, a random source, a database row or a locale
would produce a different `contentHash` for unchanged text; every chunk of every
document would look edited on every pass; and incremental re-indexing would
silently degrade into a full re-embed of the corpus, forever, with no error
anywhere to say so.

The precedent is `apps/api/src/transcripts/editing/` (issue #27, epic #19),
which holds exactly this discipline for exactly this shape of reason: its
reducers are pure so that `materialize()` — replaying a version log through *the
same functions* the live edit path calls — agrees with the live tables **by
construction** rather than by two implementations being kept in step, and
`materialize()` itself, the one operation that genuinely needs a database, is
kept deliberately *outside* that directory so the barrel can never become the
file through which a reducer acquires a row. Same rule here: the moment
something in this directory can read mutable state, the hash stops being a
function of the text.

`apps/api/src/search/chunking/index.spec.ts` is the executable form of the rule,
in the same spirit as `apps/api/test/jobs/cron-enqueue-only.spec.ts`. It scans
every non-spec file in the directory for the markers above and enforces an
import allowlist of exactly `node:crypto` plus the directory's own files —
because the one thing a marker scan cannot catch is a pure-looking helper
imported from elsewhere that is itself impure. Widening that allowlist is a pull
request that has to argue for it.
