# Content Search

> Epic #164 (issue #177) is full-text search over transcripts and notes:
> generated `tsvector` columns, a ranked `GET /api/search`, a fingerprinted
> relevance cursor, and the visibility/permission rules that keep it from
> being a second way to read someone else's data. That is what this document
> describes end to end below.
>
> Epic #165 (semantic search) is a second retrieval layer — pgvector
> embeddings fused with the full-text ranking below by Reciprocal Rank
> Fusion — landing on top of this one. It is **not** built yet in the code
> this document describes; where a section below mentions it, it is stated
> as a forward-looking sentence, never as shipped behaviour. §3 (Chunking)
> is epic #165's own groundwork, already landed ahead of the rest of that
> epic, and is kept in place here rather than in a document of its own
> because it chunks the *same* two document types (transcripts, notes) this
> document's index and ranking already cover — a reader trying to understand
> "how does searching this content work" needs both halves in one place, even
> while only one of them answers real queries today.

## 1. What this solves

Both `GET /api/transcripts?q=` and `GET /api/notes?q=` filter on a
case-insensitive **title** substring — `WHERE title ILIKE '%...%'`. That is
adequate for "find the recording I named Q3 Kickoff" and useless for "find
the call where we discussed pricing": the word "pricing" can appear in every
segment of a three-hour recording and never once in its title, and the title
filter will not find it. A person who remembers what was *said*, not what a
recording or note happens to be *called*, has no way to search for it at all.

This epic adds two layers, and the important claim is that **both are
needed and neither is sufficient**:

- **Full-text search** (this document, epic #164): Postgres's built-in
  `tsvector`/`tsquery` machinery, indexed with a `GIN` index on generated
  columns. No extension to install, no vendor API key, no per-query network
  round trip or per-query cost, and it works identically for every user in
  every deployment the moment the migration lands — see §2. It is exact-term
  retrieval: it finds a document containing the words the query contains
  (after stemming), ranked by how well those words cluster together.
- **Semantic search** (epic #165, forward-looking): embeddings fused with
  the full-text ranking by Reciprocal Rank Fusion. It finds a document that
  *means* what the query means even when it shares no vocabulary with it —
  paraphrase, synonym, "that thing about the budget" for a document that
  never says "budget."

Neither layer subsumes the other. Full-text search is notoriously bad at
paraphrase — a query for "how much will this cost us" will not find a
segment that only ever says "the price" — which is exactly what semantic
search is for. But vector search is, just as notoriously, bad at *exact*
terms: a project code, a person's name, an acronym, a SKU. An embedding
model has usually never seen "PROJ-4471" in training and has no way to place
it meaningfully in vector space relative to a query that contains it
verbatim; full-text search finds it by lexeme match with no ambiguity at
all. A search feature that shipped only one of the two would have a
predictable, un-fixable class of query it always gets wrong. This document
is the first of the two, built to stand on its own and to be the exact-term
half of the fused result once the second lands.

## 2. The index

Full-text search needs matches to come from an index, not a sequential scan
of every segment and every note on every request — three generated
`tsvector` columns, each backed by a `GIN` index, added by
`prisma/migrations/20260915120000_add_search_vectors/migration.sql`:

| Table | Column | Expression |
|---|---|---|
| `transcripts` | `title_search_vector` | `to_tsvector('english', coalesce(title, ''))` |
| `transcript_segments` | `search_vector` | `to_tsvector('english', coalesce(text, ''))` |
| `notes` | `search_vector` | `setweight(to_tsvector('english', coalesce(title, '')), 'A') \|\| setweight(to_tsvector('english', coalesce(body, '')), 'B')` |

**Why a transcript needs two of these and a note needs one.** A transcript
is not one document to the index — it is a title on the parent row plus
hundreds of child rows in `transcript_segments`, each with its own vector.
The title has to be searchable *even when no segment matches at all* (a
recording titled "Q3 Pricing Review" whose spoken content never says the
word), which is only possible if the title carries its own indexed vector,
independent of what the child table does or does not contain. A note has no
such split — title and body are two columns on the *same* row — so one
vector per note is enough, and `setweight('A')`/`setweight('B')` lets that
one vector still distinguish a title hit (the user's own words) from a body
hit (AI-generated or user-edited) when `ts_rank_cd` is computed over it. A
transcript segment gets neither a title to weight against nor a second field
of its own, so its vector is a single unweighted `to_tsvector` over `text`.

**Why generated columns, and not a trigger** — and this is an argument about
*restore*, not style. This application ships a real database restore
(`docs/specs/database-restore.md`), and `pg_restore`'s data-loading session
runs under `session_replication_role = replica` (the same mode
`pg_restore --disable-triggers` documents). An ordinary `AFTER INSERT` /
`AFTER UPDATE` trigger **does not fire** in that mode. A trigger-maintained
search index would therefore restore a database that looks completely
whole — every row present, every column present, the application starts and
serves traffic — with its search index silently **empty**, and nothing
anywhere (no error, no warning, no failed job) would say so. The first
person to notice would be a user searching for something they know is
there. `GENERATED ALWAYS AS (...) STORED` is computed by the storage layer
itself on every tuple, independent of triggers and independent of
`session_replication_role`, and a restore path that has never heard of this
column cannot switch its computation off.

**The `ADD COLUMN ... GENERATED` rewrite is the backfill**, and there is no
second one. Adding a generated column is not a metadata-only change:
Postgres computes the expression for every existing row as part of the same
statement, rewriting the whole table and holding `ACCESS EXCLUSIVE` on it
for the duration — minutes, on a large table, with no reads or writes from
any other session for that whole window. There is no follow-up job, no
on-demand reindex action, no cron sweep that populates these columns
afterward: the moment the migration commits, every transcript title, every
segment, every note already in the database is searchable, because Postgres
computed the vector as part of the very statement that added the column.
That is the whole reason full-text search needed no ingestion pipeline of
its own — an operator running this migration against a production database
does need to plan the maintenance window (or accept the outage) an
`ACCESS EXCLUSIVE`-taking `ALTER TABLE` anywhere else in this codebase would
also require, and it cannot be turned into a `CONCURRENTLY` migration: a
generated column's initial computation is inherently a table rewrite, not an
index build.

**The two-argument `to_tsvector(regconfig, text)` form is required, not
stylistic.** The one-argument form is `STABLE`, not `IMMUTABLE` — it reads
`default_text_search_config` from session state — and Postgres requires a
generated column's expression to be `IMMUTABLE`. `ALTER TABLE ... ADD COLUMN
... GENERATED ALWAYS AS (to_tsvector(coalesce(text, '')))` is rejected
outright with "generation expression is not immutable"; the two-argument
form with `'english'::regconfig` as a literal has no such dependency and is
the only form Postgres accepts here. `search.service.ts`'s own `tsQuery()`
helper uses the identical two-argument form for exactly this reason, stated
in its own comment: a query built from the one-argument form could parse
under a session-level GUC nobody set on purpose, silently matching
differently — or not at all — against vectors built under a configuration
fixed at migration time.

`'english'` is a stated v1 limitation, not an oversight. `transcripts` has a
nullable `language` column, so a per-row configuration is technically
expressible, but it would need a `regconfig` cast built from an
unvalidated, arbitrary string (an invalid language value would then fail
the whole insert, not just search), and a `GIN` index built against a
per-row-varying configuration is not usable by a query issued before the
caller knows which language a given row is in. English-language stemming
("discussed" matching "discuss") is simply wrong for non-English content;
exact-token matching still works because tokenization does not depend on
the configuration nearly as much as stemming and stop-word removal do.

This is intentional schema drift, the same pattern `jobs`,
`database_backup_runs` and `transcript_speakers` already establish: every
expression above and all three `GIN` indexes are hand-written in the
migration's raw SQL only. `schema.prisma` has no DSL for a generated
column's expression or for an index access method, so the Prisma model can
only declare that these columns exist (`Unsupported("tsvector")?`) and point
here. `prisma migrate dev`/`diff` will never regenerate this file and must
never be asked to reconcile it away.

## 3. Chunking

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

## 4. Ranking

`search.service.ts` builds one candidate list per requested document type,
unions them, and orders the union — the SQL lives in
`transcriptCandidatesSql`/`noteCandidatesSql` and their degraded-path
counterparts, and it is worth reading with these four decisions in mind,
because each one looks optimisable and each one is not.

**`ts_rank_cd`, never `ts_rank`.** `ts_rank` scores purely on term frequency:
a document saying "pricing" thirty times outranks one where "pricing" and
"model" sit in the same sentence. `ts_rank_cd` is cover-density ranking — it
rewards query terms appearing *close together*, which is what "this document
is about that phrase" actually looks like in text. Someone searching
"quarterly pricing review" is naming a topic, not three independent words,
and the paraphrase-adjacent match ("the review of quarterly pricing") is the
one they want first. Cover density finds it; raw frequency does not.

**The per-document roll-up is `max`, and it must never become `sum`.** A
transcript is not one unit to the index, it is a title plus hundreds of
segments, each independently scored, and something has to turn that bag of
unit scores into one document score. `sum` measures how often a recording
brushed past a term — a three-hour all-hands mentioning "pricing" thirty
times in passing accumulates thirty small scores and outranks a twenty-minute
conversation that is *about* pricing, and worse, it is a length bias wearing
a relevance costume: the longer the recording, the more units there are to
add, so `sum` systematically promotes long documents over short ones
regardless of what either is about. `max` measures how well the single best
passage matches, which is the answer to the question a person is actually
asking ("which of my recordings was about pricing"). The transcript title is
one of the units in this roll-up, not a bonus score bolted on afterward,
which is what lets a recording titled "Q3 Pricing Review" surface even when
its spoken content never says the word.

**The candidate window is bounded, at `MAX_CANDIDATE_DOCUMENTS = 200`.** A
relevance search is answered from the top of a ranking; nobody pages to
result 4,000 of a ranked list, they refine the query. Bounding the window
keeps one request's cost a function of this constant rather than of corpus
size, and it is what makes the response's two fields honest (next
paragraph).

**There is deliberately no field called `total`.** With a bounded candidate
window, a corpus with 4,000 matching documents would report `total: 200` if
such a field existed — the number would be the cap, not a count of anything,
and a client rendering "200 results" would be lying to the user by
construction. So the response instead publishes `matchedDocuments` (how many
documents are in the window — never more than the cap) and `truncated`
(whether the window filled up). `truncated: false` makes `matchedDocuments`
an exact count; `truncated: true` makes it a floor a client can render as
"200+ results." This is the same posture `GET /api/transcripts/:id/search`
already takes with its own `truncated` flag — and the contrast is
instructive: that endpoint keeps an exact `total` *because it can* (it
counts matches inside one transcript, a small and fully-scanned set) and
says so plainly. This endpoint cannot make the same promise about an entire
corpus without scanning the whole thing on every request, so it does not
pretend to.

Two queries, not one, execute this: the candidate query returns identifiers,
titles and scores for up to `MAX_CANDIDATE_DOCUMENTS + 1` documents (one more
than the cap, so a full window is detectable without a second `count` —
the same trick `TranscriptsService.list` uses for "is there a next page?");
the snippet query then renders `ts_headline` only for the one page the
caller actually asked for. `ts_headline` re-parses and re-scans the source
text for every row it touches, so headlining the whole window to show twenty
results would do two hundred documents' worth of text processing for
nineteen-tenths of it never seen. The segment arm narrows further still,
picking each transcript's best few segments with a cheap `row_number()`
*before* headlining them, because ranking comes off an already-indexed
vector and headlining does not.

## 5. The cursor

Pagination here cannot be a keyset cursor, because a keyset needs a total
order that is *stable* across requests, and a relevance score is neither
unique (ties are constant) nor stable (correcting either of two tied
documents moves it). So the cursor is an **offset into the bounded candidate
window** described in §4 — honest about what it is, since the window's own
boundedness is what makes an offset meaningful at all.

**Contrast this with `decodeCursor` in `transcripts.service.ts`, on
purpose.** That cursor returns `null` for anything it cannot parse, and its
own comment explains why: a stale or truncated cursor should restart the
list from the top rather than 500, which is exactly right for
`GET /api/transcripts` — a newest-first feed where landing back at page 1 is
a self-explanatory, harmless outcome a user can see happened.

A relevance list has no such tell. Silently restarting hands the user page 1
again — the same rows, in the same order, under a "next page" they just
clicked — and nothing on screen distinguishes that from a genuine page 2
that happens to resemble page 1. They would scroll a ranked list believing
they were making progress while the server quietly served them the same
twenty rows forever. So `decodeSearchCursor` (`search-cursor.ts`) throws on
**every** failure mode, and `SearchService.resolveOffset` turns that throw
into a **400** naming the problem — never a silent restart. A client that
gets one knows to re-run the search rather than trust what it is holding.

The cursor is a base64url-encoded `{ f, o }`: `o` is the offset, `f` is a
SHA-256 fingerprint (truncated to 160 bits) over everything that decides
which window an offset refers to:

- **The query text**, normalised (whitespace-collapsed, case preserved —
  case does not change `plainto_tsquery` but does change the degraded
  `ILIKE`/`<mark>` path's rendering, so two differently-cased degraded
  renderings must not share a cursor).
- **The types actually searched** — the *narrowed* set (see §8), not the
  types requested. A caller holding only `notes:read` who asks for both is
  answered from a notes-only window; fingerprinting the request instead of
  the searched set would let that caller's page-2 cursor validate against a
  different window the moment their permissions changed mid-session, which
  is the one case where the numbering can move without the request moving.
- **The caller's user id.** Visibility is applied *inside* the candidate
  window (§6), so two users running the identical query get different
  windows. Without the user id in the fingerprint, a copied or leaked cursor
  would page into somebody else's numbering — it would still only ever
  return rows the second caller may see, since the window is rebuilt under
  their own visibility predicate, but it would return the *wrong* ones, with
  no error telling either party that happened.
- **`RANKING_MODEL_VERSION`**, a bare integer bumped whenever anything that
  can reorder the candidate window changes — the rank function, the roll-up
  rule, a weighting, the candidate cap, the tie-break. This is the mechanism
  itself, not a comment asking someone to remember: bumping it invalidates
  every outstanding cursor at once, by construction, because the old
  fingerprint cannot be reproduced under the new constant. A changelog entry
  saying "tell clients to refresh" does not survive a deploy nobody read the
  changelog for; a version bump does not need anyone to read anything.

`search-cursor.ts`'s header marks the exact slot where the semantic layer's
model/index identity belongs once epic #165 adds it — appended as one more
line to the fingerprint's input list, never replacing one of the lines
above. Switching embedding models then invalidates every outstanding cursor
for free, the same way bumping `RANKING_MODEL_VERSION` does today.

## 6. Visibility

The visibility predicate — not soft-deleted, and owned by the caller or
shared with them (transcripts), or owned by the caller (notes, which have no
sharing) — is applied **inside each candidate arm's own `LIMIT`**, not
after the top-`MAX_CANDIDATE_DOCUMENTS` have already been chosen.

This is stated as its own section because it is the single easiest thing in
this file to "optimise" into a real bug, and the bug produces no exception,
no log line and no degraded flag anywhere — it produces a search that looks
like it worked. The tempting shape is: rank the whole corpus, take the top
200, *then* filter those 200 down to what the caller may read. It is
obviously cheaper (one visibility check per surviving row instead of one per
candidate row) and it looks equivalent. It is not. Consider a deployment
where one user owns 1% of the documents: a query with 20,000 excellent
matches across the corpus fills the top 200 with other users' documents, the
post-filter removes essentially all of them, and this user is told their
search found **nothing** — while 200 of their own documents matched the
query perfectly and were never looked at, because they never made it into
the pre-filtered top 200 to begin with. The failure scales with the
deployment: it is completely invisible on a single-user development
database, where the caller owns everything and pre- and post-filtering
agree exactly, which is exactly the environment most likely to be used to
"verify" a change here. So the `LIMIT` that bounds each candidate arm is
applied to rows that have *already* passed the visibility predicate, always
— the top 200 is the top 200 of what this caller can see, never the top 200
of everything with this caller's rows subtracted afterward.

**Notes carry no share join, and that is deliberate, not an oversight to
fix later.** `notes` has no `note_shares` table, there is no
`notes:read_any` permission for any role including Admin, and every note
read in this application is scoped to `ownerId`. Adding a share join here
"for symmetry" with the transcript arm would not be dead code sitting
harmlessly beside the real predicate — it would be this application's first
code path capable of surfacing somebody else's note, built inside the one
file whose entire job is finding things across the corpus. If notes ever
gain sharing, the join belongs here too, added deliberately alongside that
feature — not inferred from a transcript arm that happens to look similar.

## 7. Snippets

Each result carries up to three snippets, rendered by `ts_headline` on the
full-text path (`search-snippet.ts`), saying *why* a document matched. A
transcript snippet also carries `startMs`, computed from the segment it was
drawn from, so a client can seek directly to it.

⚠ **`ts_headline` does not escape its input, and the file's own header
records a trap that is easy to walk into by testing it the wrong way.**
`ts_headline` is a text-fragment selector, not a sanitiser: it copies source
text through verbatim and wraps the lexemes that matched in `StartSel`/
`StopSel`, which default to the literal HTML tags `<b>`/`</b>`. Source text
here is user-supplied at every point that reaches it — a transcript segment
is whatever a recording contained, a note body is whatever a model wrote
from it (or a user has since edited it to), a title is whatever anyone
typed. A segment literally containing `<script>alert(1)</script>` would come
back out of a naive `ts_headline` call as `<script>alert(1)</script>`
verbatim, and a client rendering that as HTML — which it must, to show the
highlight at all — has just executed a stranger's script.

The trap: Postgres's *default* text-search parser tokenizes `<script>...`
as a single `tag` token, and `ts_headline` does not re-emit tag tokens in
its output — so an ad hoc experiment typing `<script>` at a `psql` prompt
will show it silently stripped, and a developer testing the endpoint the
same way will conclude escaping is unnecessary and "simplify" it away. It is
not a substitute for escaping and never was: that stripping behaviour
belongs to one parser configuration and covers exactly one shape of hostile
input. `&`, `"` and `'` — none of them tag syntax — pass through
`ts_headline` completely verbatim, and any one of them is enough to break
out of an HTML attribute or corrupt an entity in a rendered snippet. This is
also why the database-level test in this feature (`search.db.spec.ts`)
does **not** assert on `<script>` — asserting on the one input the parser
happens to neutralize on its own would prove nothing about the actual
guarantee and would pass even if the escaping below were deleted entirely.
It instead asserts that `&`, `"` and `'` survive `ts_headline` verbatim
against a real row, which is the one fact that makes escaping in the
application layer non-optional. The real assertion that a hostile payload
renders as inert text lives at the unit level, in `search-snippet.spec.ts`,
against `renderHeadlineHtml` directly.

The actual guarantee comes from ordering three steps so they do not commute
(`search-snippet.ts`'s header states this precisely): the database is asked
to wrap hits in two C0 control characters (`SNIPPET_START`/`SNIPPET_STOP`)
that are not markup and cannot become markup under any escaping; the whole
string is then HTML-escaped in TypeScript, turning every angle bracket that
came out of the corpus into `&lt;`/`&gt;` text; and only *then* are the
sentinel pairs replaced with `<mark>`/`</mark>`, the one piece of markup
this application ever puts into that string. Reversing the last two steps
escapes the marks themselves into visible `&lt;mark&gt;` with no highlight
at all — the "fix" a developer reaches for is to drop the escape, at which
point the corpus is rendering live markup again. An unpaired stray sentinel
(vanishingly unlikely, but not impossible, in text this application did not
author) is deleted rather than trusted, so the output always contains
balanced `<mark>` elements and nothing else, by construction rather than by
the database having behaved.

`html` in the wire response is therefore **pre-escaped**, and a client must
treat it as trusted markup to render, never as text to escape again and
never as a template to parse further than finding `<mark>` boundaries.

## 8. Degradation

`plainto_tsquery('english', 'the and of')` parses to the **empty** tsquery,
and the empty tsquery matches no row anywhere in Postgres. Left alone, the
most ordinary-looking search a person can type — a query made entirely of
stopwords — would silently answer "no results" against a corpus full of
documents containing exactly those words, with nothing telling the user why.

The service asks Postgres itself whether this happened, rather than keeping
a second copy of the stopword list in TypeScript that could drift from
whatever dictionary the deployment's Postgres actually uses:
`numnode(plainto_tsquery('english', q))` counts the nodes the parser
actually produced, and zero means "nothing was left to search for," judged
by the identical dictionary the indexed vectors were built with — the one
source that cannot disagree with them. A `null`/non-finite reading from that
probe degrades too, deliberately: when the parser's answer is unreadable,
the safer direction is the path that still returns rows a user would
recognise, not the one that silently returns nothing.

On that path the endpoint falls back to exactly the behaviour
`GET /api/transcripts?q=` and `GET /api/notes?q=` already have — a
case-insensitive title substring, newest first — and reports
`degraded: "stopwords"` in the response so a client can say which kind of
answer it is showing rather than presenting title matches as if the
full-text ranker had chosen them. There is no score to rank by on this path
(there is no tsquery), so ordering falls back to `updatedAt` descending, the
same ordering the list endpoints use, because it is the same answer.

⚠ The degraded path's `ILIKE` pattern must defuse `%` and `_` in the query
text before it is used as the middle of a `LIKE`-family pattern —
`titleLikePattern()` in `search-query.ts` escapes `\` first (it is the
escape character itself, so escaping it last would double-escape the two
escapes this function just introduced), then `%` and `_`. Without this, a
degraded search for the single character `%` would match *every* title the
caller can see, and `_` would match every one-character title — a user
typing ordinary punctuation into a search box would silently get back their
entire corpus. This defuses the `LIKE` pattern language only; the value is
still bound as a query parameter by the caller, which is what defeats SQL
injection, and neither guarantee substitutes for the other.

## 9. Permissions

Two independent read permissions gate the two document types:
`transcripts:read` (the same string `transcripts.controller.ts` enforces)
and `notes:read` (the same string `notes.controller.ts` enforces) — no new
permission is introduced for search itself. A caller's `types` request is
narrowed to the types they actually hold the permission for, and the search
runs against that narrowed set: a caller holding only `notes:read` who asks
for both types is answered from notes alone, and `searchedTypes` in the
response names exactly what was searched, so a client can render "searched
your notes" rather than implying the whole corpus was covered. **This is a
partial answer, not a 403.** A user opening a search box and getting
"Forbidden," with nothing on screen saying which half of an implicit
request was the problem, is a dead end; the notes they are entitled to
search, and which match, would sit there unreturned for no reason connected
to what they asked to see. The one case that *is* a 403 is a caller holding
**neither** permission — there is no partial answer to give someone with no
readable document type at all.

**The route itself declares no permission string, and that is not an
oversight — it is the only way to express "either" at all.**
`PermissionsGuard` requires **every** permission a route declares (`every`,
not `some`); there is no decorator syntax in this codebase for "at least one
of." Declaring both `transcripts:read` and `notes:read` on the controller
would 403 exactly the caller the partial-answer rule above exists to serve
— someone holding one but not the other — and declaring only one would
misstate what the endpoint actually reads. So `@Auth()` on
`search.controller.ts` carries only the authentication requirement, and
`SearchService.search` enforces "at least one of the two, narrowed
per-type" in code, reading the caller's flattened permission list through
`toRequestUser` — the same function both guards already use, so there is
still exactly one definition of "what permissions does this caller hold,"
just not one expressible as a route decorator here.

Because both permissions are seeded to all three roles (Admin, Contributor,
Viewer), the partial-answer branch is nearly invisible in practice — almost
every caller holds both and searches everything they ask for. It still has
to be correct, because "rarely exercised" and "never exercised" are
different properties, and the path that is rarely exercised is precisely
the one nobody notices being broken by hand-testing.

Two access facts follow through from each type's own model and are not
re-derived here: notes have no sharing and no `notes:read_any` for any role,
so this endpoint can only ever surface a caller's *own* notes; transcripts
have no `transcripts:read_any` either, so a transcript surfaces here only
when the caller owns it or holds a share on it, identical to
`GET /api/transcripts`. Search adds no new way to see a document a direct
read of it would refuse.

## 10. Rejected alternatives

- **Extending `?q=` on `GET /api/transcripts` and `GET /api/notes`
  in place**, rather than a dedicated endpoint. Rejected: those endpoints
  page by `(updatedAt, id)` keyset cursor, this one pages by relevance
  offset (§5), and a single `cursor` string that means one thing or the
  other depending on a sibling `rank=true`-style parameter is exactly the
  kind of implicit, easy-to-misuse contract this codebase avoids elsewhere
  (contrast the explicit, single-purpose cursors on every other paginated
  endpoint in `docs/API.md`). A ranked search and a filtered list are
  different operations with different pagination semantics, and conflating
  them into one query parameter would make every client guess which
  semantics applied to a given response.
- **Triggers instead of generated columns.** Rejected in §2 above at length:
  a trigger silently does not fire under `pg_restore`'s replica-role load
  session, producing a restored database with an invisibly empty search
  index and nothing anywhere to say so.
- **`sum` instead of `max` for the per-document roll-up.** Rejected: it is a
  length bias wearing a relevance costume, systematically promoting long
  documents over short, on-topic ones regardless of what either document is
  actually about (§4).
- **A `total` field on the response.** Rejected: with a bounded candidate
  window, a `total` would report the cap rather than a real count for any
  corpus larger than the window, and would look precise while being
  arbitrary (§4). `matchedDocuments` + `truncated` says exactly as much as
  is true and no more, following the precedent
  `GET /api/transcripts/:id/search` already set for the opposite case where
  an exact total *is* affordable.
- **Score normalisation instead of Reciprocal Rank Fusion**, for the future
  point where the semantic layer (epic #165) needs to combine with this
  one. Rejected in advance: a full-text `ts_rank_cd` value and a vector
  cosine-similarity score live on incomparable scales, and worse, each
  scale's own distribution shifts per query — normalising either score
  against "the scores seen in this response" makes a document's fused score
  depend on which *other* documents happened to match the same query, an
  instability RRF (which combines by rank position, not by raw score) does
  not have. Recorded here so the decision is legible before the epic that
  needs it lands, per `search-cursor.ts`'s own marked slot for the semantic
  axis.
- **A user-facing toggle between "keyword" and "semantic" search modes.**
  Rejected in advance, for the same forward-looking reason as above: it
  asks the person searching to already know which retrieval strategy their
  own question needs, which is frequently the very thing they cannot judge
  in advance — "did I phrase this exactly the way it was said, or am I
  paraphrasing?" is not a question most people can answer about their own
  memory. Fusing both layers into one ranked result removes the need to
  guess.
</content>
