# Connected Knowledge → The kvox Ontology

> Epic not yet filed — this document **is** the spec the epic is filed from,
> per CLAUDE.md's Issue-Driven Development rule and the precedent
> `docs/specs/notes.md` set for issue #46 and `docs/specs/transcription.md`
> set for issue #20. **Nothing described below is merged.** There are no
> `kg_*` tables, no `graph.*` job types, no `/api/graph/*` controller, and no
> graph UI anywhere in this codebase today. Every file path named below is
> where the implementing issue commits to putting the code, marked *planned*
> on first use in each section; a handful of existing files this design reads
> from or extends are named without that marker because they are verified
> against the current tree as of this document's writing (2026-09) —
> `apps/api/prisma/schema.prisma`'s `Transcript.speakerIdentities` (line
> ~2391), `TranscriptSegment`, `TranscriptNameSuggestion`, `NoteGeneration`
> and `SearchEmbedding` models; `apps/api/src/search/search-fusion.ts`
> (`reciprocalRankFusion`, `RRF_K = 60`); `apps/api/src/notes/job-types.ts`
> (`aiProviderThrottleKey`); `apps/api/src/transcription/keyterms.ts`
> (`MAX_TRANSCRIPT_KEYTERMS`); and `apps/web/src/config/destinations.ts`
> (the four-tab ceiling). Everything under `apps/api/src/graph/`,
> `apps/web/src/pages/graph/` (or wherever §13 lands it), and every `kg_*`
> table is *planned*.
>
> Builds on: `docs/specs/transcription.md` (segment stability, the version
> log, `materialize()`, speaker identification), `docs/specs/notes.md`
> (the AI provider framework, per-user credentials, the token budget, the
> durable-stream pattern), `docs/specs/search.md` (the hybrid retrieval
> architecture and `reciprocalRankFusion` this design reuses directly),
> `docs/specs/transcript-name-correction.md` (the phonetic/discovery/
> adjudication pipeline shape this design's resolution step is modelled on),
> and CLAUDE.md's MANDATORY job-queue and Settings UI Pattern rules, both of
> which this document commits to following rather than restating.
>
> This document supersedes a broader draft (project name `knotes`,
> `docs/ONTOLOGY.md` v0.2 in that repository — 80-odd node labels, a Neo4j
> graph-database projection, an agent-execution-trace layer, and a
> problem/resolution layer) that was never implemented against kvox. "Why
> this shape, and not the obvious one" below states exactly what was kept,
> what was cut, and why; nothing from that draft is assumed as background —
> every decision this document depends on is restated here in full.

## Why this shape, and not the obvious one

VISION.md's "Knowledge Graph" section states the intent — *"the graph should
draw knowledge from transcripts, generated notes, imported documents, user
context and user corrections,"* and its purpose is *"helping users understand
relationships across information that would otherwise remain isolated"* — and
then explicitly defers everything else: *"the exact ontology and structure of
this graph should be defined later."* In the meantime a full draft ontology
*was* written, for a different, more ambitious product than the one kvox
actually is. This document is the reconciliation: what of that draft still applies to kvox, cut
down to what kvox's own workflow — record, correct, generate a note, done —
actually needs, and grounded in outside evidence about where a graph helps
retrieval and where it does not.

**What the v0.2 draft got right, and is kept.** Three of its structural
choices survive unchanged into this document because nothing about narrowing
the scope invalidates them: content is evidence, not knowledge, so nothing
enters the graph without a citation back to the transcript segment or note
span that supports it (v0.2 §3.2, kept as this document's §5.3); a
user-curated fact always outranks a machine-extracted one and is never
silently overwritten (v0.2 §9.2, kept as §7's resolution rules and §5.5's
review lifecycle); and a review-status lifecycle — `unreviewed → accepted |
edited | rejected`, with `merged`/`superseded` as terminal states reached only
from an already-curated row (v0.2 §9.3) — is kept nearly verbatim as §5.5,
because it is the mechanism that makes the first two promises actually
enforceable rather than aspirational.

**What is cut, and why.** Two whole layers of the v0.2 draft do not appear
below at all:

- **The agent-execution-trace layer** (`AgentRun`, `AgentStep`, `ToolUse`,
  `CommandRun`, `FileChange`, `CodeChange`, and a dozen more, v0.2 §7) modelled
  a coding agent's own actions — commands run, files touched, diffs produced
  — as first-class graph nodes. kvox has no coding-agent surface: it
  transcribes conversations and generates notes from them. There is nothing
  in this product for that layer to describe, and importing forty node types
  built for a different product's execution model would be exactly the
  "invent structure nobody's data will ever populate" mistake this document's
  §3 argues against on its own terms.
- **The problem-resolution layer** (`Problem`, `Symptom`, `Hypothesis`,
  `Attempt`, `RootCause`, `Resolution`, `Runbook`, `LessonLearned`, v0.2 §6)
  modelled operational troubleshooting memory — "did I already try this,"
  "what worked instead." kvox's meetings are not incident retros by default,
  and forcing every "we tried X, it didn't work, we did Y instead" into a
  five-type mini-ontology when the same fact is already representable as two
  ordinary `Claim`s and a `SUPERSEDES` edge (§5.2) buys nothing an
  organization actually using this product for meeting notes would use.

Both layers remain named here, in this paragraph and in "Rejected
alternatives," specifically so a future contributor tempted to reintroduce
them for a genuinely operational use case finds the reasoning that removed
them rather than silence. Everything below, correspondingly, targets exactly
one product statement — the north star this whole document optimises for:

> **Remember the work, not just the words.**

A transcript remembers what was *said*. A note remembers what was *written*
about what was said. Neither remembers, across dozens of meetings over
months, that Acme's CIO is leaving in March, that the Q2 pilot was already
pushed once, or that Sarah owns the vendor migration and it is three weeks
overdue. That is the specific gap this document's graph closes — nothing more
ambitious, and (per the research below) nothing less either.

**The research summary, and what each source actually contributed.** Before
committing to *any* graph, four independent findings were checked against the
"just do better vector search" alternative, because a knowledge graph is a
second store, a second access-control surface, and a second thing that can
disagree with the truth — expensive enough that it should not be built on
vibes.

A large systematic evaluation of RAG versus GraphRAG
(arxiv.org/html/2502.11371v3) found single-hop retrieval-augmented generation
scores 64.8 F1 against graph-based methods' 60–63 — **plain vector/lexical
retrieval wins the common case outright**, and graph-based methods only pull
ahead by 1–6% on genuinely multi-hop questions ("who took over from the
person Acme mentioned leaving in March?"). The same study's most load-bearing
number for this document's design is that only 65.8%/65.5% of the entities a
correct answer actually needed were present in the graphs those systems had
built — **extraction is the bottleneck, not retrieval**, which is why §6
below treats extraction quality as a first-class deliverable with a golden
set and precision/recall targets *before* any retrieval feature ships, and
why §9.4 makes graph-only retrieval structurally impossible rather than
merely discouraged. The same paper found hybrid integration — combining a
graph signal with the existing FTS/vector legs — adding +6.4% over either
alone, which is the empirical basis for §9's fusion design rather than a
graph-replaces-search design.

GraphRAG-Bench (github.com/GraphRAG-Bench/GraphRAG-Benchmark, feeding ICLR'26's
"When to Use Graphs in RAG") frames the same result as a decision rule rather
than a single number: graphs earn their cost specifically on multi-hop
reasoning and corpus-wide sensemaking questions, and lose or tie on
single-fact lookup. A VentureBeat practitioner summary of the same body of
work (venturebeat.com/orchestration/stop-graphing-everything-when-graphrag-actually-beats-vector-rag)
adds concrete numbers this document leans on directly: multi-hop recall rising
73.4%→87.8% with a graph in the loop, global "comprehensiveness" questions
winning 72–83% of head-to-head comparisons, roughly $48 to index a
benchmark-scale corpus, and — the single most relevant data point for §6's
architecture — a "LazyGraphRAG" strategy that defers entity resolution to
query time scoring within 0.1% of full GraphRAG on quality while resolving
nothing at write time. That is a real engineering option for a system with no
review step; §"Rejected alternatives" explains why it is wrong for kvox
specifically, where resolving "is this the same Sarah" *is* the review step
a human already has to do once per meeting, and deferring it to every future
query would just repeat that decision, unreviewed, forever.

Zep's temporal-knowledge-graph paper (arxiv.org/abs/2501.13956) is cited for
one mechanism, not its headline benchmark: representing facts with
valid/invalid time windows rather than a single timestamp measurably improved
long-context memory recall (+18.5% on LongMemEval) and cut retrieval latency
~90% relative to a full-context baseline. Its `valid_from`/`valid_to` +
"superseded" pattern is the direct model for §5.4's temporal design. Its own
LoCoMo benchmark numbers are disputed in public discussion of that paper and
are **not** relied on here — kvox's own golden set (§6) is the quality bar
this project measures itself against, not a third party's disputed leaderboard.
Finally, a study on LLM extraction against scholarly Wikidata
(arxiv.org/pdf/2411.08696) reports precision around 0.80 and recall 0.81–0.97
for structured entity/relation extraction from real text with a capable
model — evidence that the ≥0.95 auto-link precision and ≥0.85 commitment
recall targets §6 sets are realistic engineering targets, not optimistic
ones, for a domain (meeting transcripts) that is considerably more
structured than open scholarly text.

The synthesis these four sources converge on, and the one sentence this whole
document is an elaboration of: **a knowledge graph over meeting content is
worth building because it wins on multi-hop and temporal questions
specifically — "what's changed since I last checked on Acme," "who inherited
this when Sarah left" — and it is worth building *carefully* because its
single biggest failure mode, in every source that measured it, is
under-extraction, not bad ranking.** Hybrid retrieval that never depends on
the graph alone (§9.4) is not a hedge against this design being wrong; it is
the design responding directly to what the evidence says about where graphs
fail.

## 1. Scope and non-goals

**In scope for this document and its filed epic:** six entity types plus
`Meeting` and evidence (§5.1); one direction per relationship, always with
provenance (§5.2); an evidence contract anchored to a stable transcript
segment id or a note version and character range (§5.3); a review-gated
extraction pipeline running once per note (§6); three-stage entity resolution
with reversible merges (§7); a proposal object and an explicit "Send to
graph" commit — nothing enters the graph any other way, with two narrow
exceptions named in §8 (§8); hybrid retrieval that fuses a graph walk with the
existing FTS/vector legs, never a graph-only answer (§9); an entity page and
a bounded, entity-centred neighbourhood view (§13); and feedback loops back
into transcription's keyterms and name-check and into the note-generation
prompt (§14).

**Out of scope, permanently, not merely "not yet":**

- **Any second database.** §3.2 and "Rejected alternatives" state the
  argument in full; the summary is that PostgreSQL, `pg_trgm`, pgvector and
  bounded recursive CTEs are sufficient for the query shapes this product
  needs, and a second store buys graph-algorithm and long-path capabilities
  this product does not use.
- **An agent-execution-trace layer.** See "Why this shape" above. kvox has no
  coding-agent surface for this layer to describe.
- **A problem/resolution layer** (`Problem`, `Symptom`, `Attempt`,
  `Resolution`, `Runbook`). See "Why this shape" above; the same facts are
  representable as `Claim`s and `SUPERSEDES` edges when they actually occur in
  a meeting.
- **Free-form graph query access** — no endpoint ever accepts or generates
  Cypher, SQL, or any other query language from a model or a user; every
  graph read is one of the fixed shapes in §9 and §12.

**Deferred to v2, not rejected — listed in full in §5.7:** a `Concept`/topic
layer distinct from `Project`, corpus-wide sensemaking summaries, and a
neighbourhood-graph rendering library choice (§13 names candidates, installs
none).

## 2. Standards profile

kvox's ontology reuses established vocabularies **as naming and
disambiguation guidance**, not as a schema kvox's Postgres tables are bound
to today. Nothing below requires an RDF store, a SPARQL endpoint, or any
runtime dependency on these vocabularies; they exist so that a future export
(§18) has an honest target rather than an invented one.

| Area | Vocabulary | How kvox aligns |
|---|---|---|
| Core entities | Schema.org | `Person`, `Organization` map to `schema:Person`/`schema:Organization` by name and by the properties each entry keeps (§5.1) |
| Concepts and taxonomies | SKOS | Named as the alignment target for the *deferred* `Concept`/topic layer (§5.7) — not used by anything in scope today |
| Provenance | PROV-O | `kg_evidence` (§10) is structurally a `prov:wasDerivedFrom`/`prov:used` pair — an entity or item "used" a segment or note span as its evidence — without importing `prov:Agent`/`prov:Activity` as graph nodes, because kvox's own `jobs`/`audit_events` tables already record who/what generated a row |

**Every type declares its own alignment, so an export is derived, never
hand-maintained.** The definition file's `alignment` field (§17.1) is what
actually ties a `kg_*` row to a standard-vocabulary class or property —
`schema:Person`, `schema:worksFor`, and so on — and §18's OWL/RDFS and SHACL
generators read that field directly rather than a second, separately
maintained mapping table. A vocabulary named in this section with no
`alignment` value on any type is aspirational only; §18 is where the mapping
becomes something a generator actually runs against.

**Namespace.** `kv:` / `https://kvox.app/ns#` is named here as the *future*
IRI base for a JSON-LD/RDF export (§18), and it is a placeholder only: it
binds no running system today, resolves no real endpoint, and is not read or
written by any code in this repository. Choosing it now costs nothing and
avoids a later rename if export is ever built; deferring the choice would
not have made the eventual export any easier and would have left one more
undecided detail hanging over a document whose entire purpose is to stop
deferring decisions.

## 3. Design principles

**3.1 Content is evidence, not knowledge, by itself.** A transcript segment
or a note is a primary source; the graph is what a human reviewed and decided
those sources mean. This is not a stylistic preference — it is what makes
§5.3's evidence contract and §8's "nothing enters without a commit" rule
possible at all: if raw content and curated knowledge lived in the same
table with the same trust level, there would be nothing to distinguish "the
model guessed this" from "a person confirmed this," which is exactly the
distinction VISION.md's "AI proposes. The user controls the truth" thesis
exists to preserve at every other layer of this product.

**3.2 PostgreSQL is the only store — a graph database is a rejected
alternative with named re-open triggers, not a future default.** The v0.2
draft ran a Neo4j projection beside Postgres, and its own §9.1 spent thirty
lines specifying the "no-orphans" invariant a two-store design needs and two
more mechanisms (a cascading accept, a projection-time fallback) to actually
hold it, plus a one-time backfill migration to heal cases where it briefly
didn't. That is not a report of a design working — it is a report of a
sync-consistency bug class that a two-store architecture manufactures and
then has to keep re-closing. This document's design has exactly one system
of record and nothing to keep in sync with it, because there is nothing else
to sync. `pg_trgm` handles fuzzy name matching, pgvector (already a
dependency — `SearchEmbedding`, verified above) handles semantic similarity,
and a bounded `WITH RECURSIVE` CTE handles the 1–2-hop neighbourhood walks
§9.1 and §13 need — kvox's graph questions are shallow by construction
(§9.1's brief, §13's neighbourhood view), and a shallow, indexed graph walk
in Postgres has no measured latency problem at this scale. "Rejected
alternatives" names the three conditions that would actually justify
revisiting this — none of which this product's roadmap currently states as
a goal.

**3.3 No orphans.** Every `accepted`/`edited` entity, relation, and item has
at least one `kg_evidence` row, enforced inside the same transaction that
commits it (§8, tested per §"Verification"). An entity or fact with no
citation back to a segment or note span is not knowledge kvox can stand
behind — it is an unsupported assertion wearing the UI of a supported one,
which is the specific failure "AI proposes, the user controls the truth"
exists to prevent everywhere else in this product.

**3.4 Failed and superseded facts are kept, never deleted.** A `Decision`
that was later reversed, a `Claim` that turned out to be wrong, a
`Commitment` that was dropped — all stay in the graph, linked by `SUPERSEDES`
(§5.2, §5.4), because "what did we used to think, and when did that change"
is itself a question this product exists to answer, and deleting the earlier
row would erase the very history a temporal graph is for.

**3.5 A narrow schema, not a broad one.** Six entity types plus `Meeting`
and evidence, roughly sixteen relationship types, one join table for facts —
against the v0.2 draft's 80-odd node labels across seven layers. Every type
in §5 exists because a real product surface (an entity page, a brief, a
feedback loop) reads it; nothing is speculative inventory for a use case
this document cannot name. "Rejected alternatives" states the 44-type
`graph_nodes` catalogue this replaces and exactly why precision, not
completeness, was the deciding factor.

**3.6 Human in the loop by construction, not by policy.** §8's commit gate is
not a permission check that a future flag could disable — it is the only
write path into `kg_entities`/`kg_relations`/`kg_items` that exists at all,
with two narrow, explicitly named exceptions (the speaker-naming write and a
manual edit on an entity page, §8).
A design that made auto-commit *possible* and merely defaulted it off would
be one config change away from silently reintroducing the exact
unsupported-assertion failure §3.3 rules out; a design where the write path
itself does not exist cannot be misconfigured into that state.

## 4. The workflow

Connected knowledge attaches to kvox's existing note-generation flow — it
adds one step at the end, and reuses two moments that already exist for
other reasons:

1. **Upload a recording** (`docs/specs/transcription.md`) — unchanged.
2. **Name speakers** — unchanged, but this is **resolution moment #1**: the
   instant a user types "Sarah Chen" against "Speaker A," they have just
   performed the single highest-confidence entity-resolution act this whole
   design will ever see, for free, as a side effect of a feature that already
   exists (`Transcript.speakerIdentities`, verified above). §5.1 and §7 both
   depend on this moment rather than duplicating it.
3. **Add context** — unchanged (`docs/specs/notes.md` §3.1's Context field),
   but its free text is now also **resolved to entities** where it names one
   the graph already knows, feeding §6's known-entities list for this
   meeting.
4. **A note is generated** — unchanged (`note.generate`, `docs/specs/notes.md`
   §1–§3).
5. **A graph proposal is produced** — new. `kg.extract` (§6) runs
   automatically the moment the note reaches `ready`, reading the committed
   note body, its source transcript's segments, and the meeting's known
   entities, and produces a *draft* — nothing visible in the graph yet.
6. **A review panel** — new (§8, §13). The proposal's entities, relations and
   items are shown grouped by type, pre-checked where resolution is
   confident (§7), with every row's evidence one click away.
7. **"Send to graph" commits** — new (§8). One transaction. Before this
   click, nothing the note generated exists as a graph row anywhere; after
   it, every accepted/edited item does, each with its evidence attached.

**Where resolution happens, restated as one list because it is easy to lose
track of across §6–§8:** at speaker-naming time (step 2, free, already
built); at extraction time, against the known-entities list assembled for
this specific meeting (§6, inside `kg.extract`); and as a standalone,
on-demand `kg.resolve` pass over already-committed rows (§7, for a bulk
re-scan, a merge reversal, or a threshold change). Nothing about this list is
a fourth place — every resolution decision this design ever makes happens in
one of these three moments.

## 5. The ontology

### 5.1 Entity types

Six entity types, one event anchor, and one fact type with its own handling
— eight labels total, each with a one-line disambiguation rule against its
nearest neighbour, because the failure mode a narrow ontology exists to
prevent (§3.5) is precisely two people creating two entities for the same
real-world thing because nothing told them which label to reach for.

**Person** — a human being. Never a role ("the CIO"), never a team, never an
organization acting collectively. *Positive:* "Sarah Chen," "the Acme CIO
whose name was given as Marcus Webb." *Negative:* "the data team at EY" (an
`Organization`, or a `Person` if and only if one specific human is meant);
"whoever's on call" (no specific human named — nothing to create). *Domain:*
`core` (§17.2).

**Organization** — a company, client, vendor, institution, or an internal
team specifically when that team acts as a party to a commitment or decision
rather than merely being mentioned. *Positive:* "EY" (a company); "the data
team at EY," when a commitment is owed *to* that team specifically rather
than to an individual within it. *Negative:* "the data team at EY," mentioned
only in passing with no commitment or decision naming it as a party — that
mention lives as evidence on whatever it actually relates to, not as a new
`Organization` row created speculatively. *Domain:* `core` (§17.2).

**Project** — a named effort with a start and an expected (even if fuzzy) end
that meetings, decisions and commitments attach to. *Positive:* "Q2 pilot,"
"the vendor migration." *Negative:* "AI code review" as a recurring meeting
topic with no start/end and nothing else attaching to it as a unit of work —
that is a topic, not a project, and it lives today as a free-text entry in
`Meeting.topics[]` (a plain string array property, never a graph node) rather
than as the deferred `Concept` type §5.7 names. The line is deliberately
conservative: creating a `Project` for every recurring conversation subject
would flood the graph with nodes that never anchor a `Commitment` or
`Decision`, the exact "invented structure nobody's data populates" failure
§3.5 exists to prevent. *Domain:* `work` (§17.2).

**Meeting** — the event anchor: a date, its attendees, and the source
transcript(s) and/or note(s) it was drawn from. Every `Commitment`,
`Decision`, and `Claim` attaches to exactly one `Meeting` through
`CREATED_IN`/`DECIDED_IN`/`ABOUT`'s temporal grounding (§5.4). One `Meeting`
per transcript by default (a transcript carries one recorded date —
`Transcript.recordedAt`, §5.4 — and one attendee list). A note with no source audio — created from another note or
an uploaded document — still gets a `Meeting`: its date is whatever the user
supplied in Context if that names one, else the note's own `createdAt`, and
either way `Meeting.dateSource` records which (`'stated' | 'note_created_at'`)
so a later "why does this say September when the call was in July" question
has a straight answer rather than a silent guess. *Domain:* `core` (§17.2).

**Commitment** — a task with an *owner* and, optionally, a *counterparty* and
a *due date*, stated or clearly implied by the source text. `status`:
`open | done | dropped | superseded`. *Positive:* "Sarah will send the
updated proposal by Friday" (owner: Sarah, due: Friday). *Negative:* "we
should probably look into that at some point" — no owner named or clearly
implied is **not** a `Commitment`; it is either a `Claim` (a statement that
this was discussed) or nothing at all, never force-fit into a task type
because a sentence sounded task-shaped. *Domain:* `work` (§17.2).

**Decision** — a choice that was made, with what was chosen and, when the
source states it, the option that was rejected. A later reversal is **a new
`Decision`** that `SUPERSEDES` the old one (§5.4) — a `Decision` row is never
edited in place to record a change of mind, because that would erase exactly
the "what did we used to think, and when did that change" history §3.4 exists
to keep. *Domain:* `work` (§17.2).

**Claim** — a dated statement of fact about an entity that is neither a
decision nor a commitment: "Acme's CIO is leaving in March," "the budget was
cut 20%," "the pilot moved to Q2." Properties: `subject` (the entity it is
about), `statement`, `occurred_at`, `superseded_by`. This is the unit of
"what's changed" — §9's entity brief is, structurally, mostly a query over
`Claim`s newer than the reader's last visit. *Domain:* `core` (§17.2).

**PersonFact** — a `Claim` whose `subject` is a `Person` and whose content is
about that person as an individual rather than about their work: an
interest, a preference, a personal-life detail, a note on communication
style. It is its own type, not merely a `Claim` with a `Person` subject,
specifically because of §5.6's sensitivity handling — folding it into
`Claim` would mean every `Claim` reader has to remember to check a field that
usually does not apply, instead of a type whose very existence signals "this
one needs the extra care." *Domain:* `core` (§17.2).

**Speaker is deliberately not a graph entity of its own.** It is the
existing per-transcript diarization row (`TranscriptSegment.speakerId`,
`TranscriptSpeaker`, both verified above); `IDENTIFIED_AS` (§5.2) links it to
a `Person`, and the identification itself is read from
`Transcript.speakerIdentities` rather than duplicated into a graph-owned
copy — the map issue #323 already built *is* where the user's naming lives,
and this design reads it rather than re-storing the same fact under a second
name that could drift from the first.

### 5.2 Relationship types

Every relationship below has **one fixed direction**, carries a `valid`
range with a precision (§5.4) when validity can meaningfully change, and
every instance carries at least one evidence row (§5.3) once it is
`accepted`/`edited`. There is deliberately **no inverse pair stored for any
of them** — see below for why — and **no `RELATED_TO` catch-all** — see
"Rejected alternatives" for why a relation with no stated meaning is worse
than no relation at all.

| Relationship | From → To | Notes |
|---|---|---|
| `ATTENDED` | Person → Meeting | |
| `WORKS_FOR` | Person → Organization | Temporal (§5.4); normally exclusive (soft) |
| `HAS_ROLE` | Person → Organization | Props: `{ title }`; temporal (§5.4), one edge per role period; normally exclusive (soft) |
| `REPORTS_TO` | Person → Person | Temporal (§5.4); normally exclusive (soft) |
| `IDENTIFIED_AS` | Speaker → Person | The one relation whose source is not a `kg_entities` row at all — see §5.1 |
| `DISCUSSED` | Meeting → Project | |
| `ABOUT` | Claim \| Decision \| Commitment → Person \| Organization \| Project | |
| `PART_OF` | Project → Organization; Meeting → Project | Two endpoints pairs sharing one relation type, disambiguated by the endpoint types actually present |
| `DECIDED_IN` | Decision → Meeting | |
| `CREATED_IN` | Commitment → Meeting | |
| `ASSIGNED_TO` | Commitment → Person | The owner |
| `OWED_TO` | Commitment → Person \| Organization | The counterparty, when one is stated |
| `SUPERSEDES` | Decision → Decision; Claim → Claim; Commitment → Commitment; `HAS_ROLE` → `HAS_ROLE`; `WORKS_FOR` → `WORKS_FOR`; `REPORTS_TO` → `REPORTS_TO` | §5.4. The relation-to-relation form is what the closing rule (§5.4) writes when a new fact closes a still-open exclusive edge |
| `MENTIONS` | Note \| Transcript → any entity | The coarse, overview-level shortcut — "everything this note touches," one hop, no evidence detail beyond "somewhere in this document" |
| `SUPPORTED_BY` | any generated entity/relation/item → its evidence | The fine-grained link — *which* segment or span, §5.3 |

**Why there is no inverse relation stored for any of these — no
`EMPLOYS` beside `WORKS_FOR`, no `HAS_COMMITMENT` beside `ASSIGNED_TO`.**
The v0.2 draft, running on a graph database, stored both directions for
several relation types because a property-graph traversal engine benefits
from having an edge to walk in either direction without a join. Postgres
joins are symmetric by construction — `WHERE from_id = $1` and
`WHERE to_id = $1` cost the same, indexed either way (§10's
`(owner_id, from_id, type)`/`(owner_id, to_id, type)` index pair) — so
storing both directions here would buy zero query-time benefit and one
concrete cost the v0.2 draft actually paid: two rows that can disagree.
Reversing a relation, correcting one endpoint, or merging one side (§7) all
become two writes that must stay in lockstep instead of one, and nothing
enforces that they do. One row, one direction, joined from either side, is
strictly simpler and cannot drift from itself.

**Why `RELATED_TO` does not exist.** A relation whose *meaning* is "these two
things are related, somehow" is not a fact an evidence-anchored graph can
support any claim about — it is a hedge. Concretely, offering it as an
extraction option would give `kg.extract` (§6) an escape hatch for every
ambiguous case, and an escape hatch a model can reach for is one it *will*
reach for, disproportionately, on exactly the sentences worth getting
specific about. Every relationship above states a real, checkable claim
("X is assigned to Y," "X supersedes Y"); a proposed link the extractor
cannot express as one of them is a link that should not be proposed at all.

### 5.3 Evidence contract

Every generated entity, relation, and item points back to the specific
material that supports it, via `kg_evidence` (§10) rows shaped:

```
(subject_kind: 'entity' | 'relation' | 'proposal_item' | 'import',
 subject_id,
 transcript_id?, segment_id?, segment_rev?, start_ms?, end_ms?,
 note_id?, note_version?, char_start?, char_end?,
 quote)
```

**Segment anchoring reuses a mechanism that already exists and is already
proven stable across edits.** `docs/specs/transcription.md` establishes that
`TranscriptSegment.id` is stable across a `segment.split`/`segment.join` — a
split keeps the id on the earlier half specifically so a stale reference
still names something real (verified in the schema's own comment, quoted
above) — and `TranscriptNameSuggestion.segmentId` + `segmentRev` (verified
above) is the exact precedent for citing "this segment, as it read at this
revision" rather than "this segment, as it reads right now." `kg_evidence`
copies that shape unchanged: `segment_id` + `segment_rev` says *which*
segment and *which version of its text* the citation was drawn from, so the
UI can say "this citation's text has changed since" exactly the way a
name-check suggestion already can, without inventing a second anchoring
scheme for the same underlying stability guarantee.

**Note anchoring is the identical idea over a note's own version history.**
`note_id` + `note_version` + `char_start`/`char_end` names a span in a
specific `note_versions` row (`docs/specs/notes.md` §4.5) — a note's body is
immutable once a version is written, so an offset pair into a fixed version
is exactly as durable as a segment id + rev pair into a fixed transcript
state.

**`quote` is the exact text at anchoring time, kept even though the source
it points to might move or be corrected later.** A citation is only useful if
it stays legible after the underlying segment is edited or the note is
regenerated; `quote` is what lets a reviewer read what the model actually
saw, even once the live text at that offset has changed underneath it, the
same "the text has changed since" affordance §7 of
`docs/specs/transcript-name-correction.md` already gives its own stale
suggestions.

**The invariant: an `accepted`/`edited` entity, relation, or proposal item has
at least one evidence row, always.** Enforced inside the same transaction
that commits it (§8) — never a background check that could catch a violation
after the fact — and covered by a dedicated test (§"Verification").

### 5.4 Temporal model

`occurred_at` is set on `Meeting` (its date), and on `Commitment`,
`Decision`, and `Claim` — defaulting to the meeting's own date unless the
source text names another, with relative dates ("next Tuesday," "in three
weeks") resolved **against the meeting's date**, never against the date the
note happened to be written or reviewed. For a `Meeting` backed by a
transcript, that date is **`Transcript.recordedAt`** — a column this epic
adds (§16, P1) precisely because the existing `transcripts` table has no
notion of *when the recording happened* distinct from `createdAt` (when it
was uploaded, verified above): using `createdAt` for a transcript uploaded a
day or a week late would silently mistake upload time for meeting time on
every such recording. `recorded_at` backfills to `createdAt` at migration
time and defaults to it on every future transcript, and is editable on the
transcript page exactly like its title, so a late upload is correctable the
same way a late title already is. This is a distinct field from
`created_at` (when the graph row itself was written) for the identical reason
Zep's temporal-graph paper argues for the distinction: a note is written
*after* the meeting it describes, sometimes days after, and "latest" queries
have to sort by when the thing actually happened, not by when kvox happened
to find out about it.

**Two clocks, bitemporal.** Every relation and every `kg_items` row carries
two independent notions of time: *valid* time (when the fact was true in the
world) and `asserted_at` (when kvox learned it). `asserted_at` is not a
column of its own — it is **derived** from the row's evidence: the **latest**
`occurred_at` among the meetings or notes whose `kg_evidence` (§5.3) supports
the row — "when kvox most recently learned it," so a second meeting restating
an existing fact moves the tiebreaker forward even though the fact itself is
unchanged — read at query time rather than duplicated into a second stored
timestamp that could drift from the evidence it is supposed to summarize.
Every "latest"/"as of" query in this document (§9.1, this section) reads
**valid** time; `asserted_at` is provenance, surfaced on the entity page, and
is the tiebreaker when two sources disagree about the same period and
neither is curated. The reason for keeping both, rather than collapsing to
one: notes are written after the meeting they describe, sometimes days
after, and a recording can be uploaded weeks late — the same "how kvox
learned something is not when it became true" argument Zep's temporal-graph
paper makes for its own `valid_from`/`valid_to`/"invalid" window pattern,
cited above and adopted here for the identical reason.

**Ranges with precision, not two nullable timestamps.** `valid` is a single
Postgres `tstzrange` column, paired with `valid_precision`
(`day | month | year | unknown`) recording how exact the source actually
was. "In 2026" becomes `valid = [2026-01-01, 2027-01-01)` with
`valid_precision = 'year'` — the UI renders "2026" from the precision rather
than a synthetic January 1st date, `valid @> $date` still answers a point
containment query exactly, the column is GiST-indexable (§10), and an
overlap check (below) is a native range operator rather than a pair of
comparisons an extractor or a migration could get backwards. `unknown` is a
legitimate value, not a gap to be filled in later — the extractor is
required to write `unknown` rather than guess a plausible-looking range when
the source text does not state one, because a guessed precision is a
fabricated fact carrying the same authority in the UI as a real one.

Three conventions follow from the half-open range and are fixed by the
temporal engine (`apps/api/src/graph/temporal/`, issue #353). A **start-only
statement** is one of two different facts, and the extractor must say which:
a *point* ("in March 2026") spans its one precision unit, `[2026-03-01,
2026-04-01)`, while a *continuing state* ("has worked there since 2019") is
open, `[2019-01-01, )`. A stated **end** is inclusive in speech and exclusive
in the column: "2019 to 2025" is `[2019-01-01, 2026-01-01)`. And the UI
renders an upper bound as the **last unit included**, so that range reads
"2019 → 2025", and a year-precision edge closed at `2026-03-01` reads
"2019 → Feb 2026" — the bound is shown at the finest unit it needs, never
rounded to the edge's own precision.

**State is derived from dated facts, not edited in place.** A `Claim` is the
record — a dated, evidenced statement. A relation edge (`WORKS_FOR`,
`HAS_ROLE`, `REPORTS_TO`, and every other temporal relationship in §5.2) is
the *index* built from the current set of `Claim`s and extractions about
that edge, never a row a later note is allowed to mutate directly. A new
fact never rewrites an existing edge's `valid` range in place; it is added
as its own dated row, and the edge set — which edges are open, which are
closed, which supersede which — follows from replaying the facts, the
identical "derive, never mutate" discipline `materialize()` already applies
to transcript corrections (`docs/specs/transcription.md` §4.4) and
`kg_entity_digests` (§9.2) applies to summaries.

**Closing rule.** For a relationship type marked *normally exclusive*
(`WORKS_FOR`, `REPORTS_TO`, `HAS_ROLE` within one organization — §5.2),
accepting a new fact with a `valid` start date closes that person's
still-open edge of the same type at the new fact's start: the open edge's
`valid` upper bound is set, and the new edge records `SUPERSEDES` against it
(§3.4). The closing is never applied silently — it surfaces in the review
panel as its own proposal row ("Closes: Joe works for Acme, 2019 → Feb
2026") and is accepted, edited, or rejected exactly like any other proposed
item (§8); a reviewer who rejects the close leaves both edges open, which
the overlap tolerance below then treats as a legitimate (if unusual)
concurrent pair rather than an error state.

**Out-of-order rule.** Facts are inserted by **valid** time, never by
arrival order. A note about a 2020 meeting, reviewed and committed in 2026,
saying "Joe works for Acme" that lands inside an already-accepted
`[2019, 2026)` edge is additional evidence for that edge — it is attached to
it (the same "known, skipped" collapsing §8 already gives a restated fact)
and never reopens or splits it. A fact whose valid period lands **outside**
every known interval for that person and relationship type is a new edge,
proposed as such; it is flagged `overlaps` in the review panel specifically
when its valid range overlaps an already-accepted edge of the same type, so
a reviewer sees the conflict rather than two silently coexisting edges with
no signal that anything needs a look. That includes a new period of the
**same** fact that straddles a known one (Acme `[2023, 2025)` against an
accepted Acme `[2019, 2024)`): it is not contained, so it is a new edge —
ranges are never merged automatically — and it is flagged against the period
it overlaps. An accepted edge whose `valid` is `unknown` cannot be ordered
against a dated fact at all, so it is never closed by one; the proposal is
flagged `unordered` instead and a reviewer decides, exactly as for a new fact
whose own start is unknown.

**Overlap tolerance is soft, not enforced.** "Normally exclusive" describes
the common case, not a database constraint: a consultant or a board member
can legitimately hold two concurrent `WORKS_FOR` edges, and a person can
genuinely report to two managers during a reorg. The schema never rejects an
overlapping pair of edges of the same type for the same person — it only
ever warns, in the review panel, at the moment an overlap is proposed.
Making this a hard constraint would force a reviewer to falsify one of two
true facts just to satisfy the schema, which is a worse outcome than an
accurate graph with a flagged overlap in it.

**Worked examples.**

- *A promotion.* Joe holds `HAS_ROLE { title: "Engineer" }` at Acme,
  `valid = [2019-01-01, )`. A meeting in March 2026 says he was promoted to
  "Staff Engineer" that month. The closing rule ends the Engineer edge at
  `2026-03-01` and proposes a new `HAS_ROLE { title: "Staff Engineer" }`
  edge starting the same day, `SUPERSEDES` linking the two — one person, one
  role at a time, two edges, full history kept.
- *A manager change.* Joe `REPORTS_TO` Jane, `valid = [2020-01-01,
  2026-03-01)`; from March 2026 he `REPORTS_TO` Will. Both edges are real
  and both stay in the graph; the entity page reads the second as current
  and the first as history, and an "as of January 2024" query (below) reads
  the first.
- *A company change, with its two side effects.* Joe leaves Acme for a new
  employer: the `WORKS_FOR` edge closes, a new one opens. Two things the
  closing rule alone does not handle, both worth stating because they are
  easy to miss: any **open `Commitment`** where Joe is owner or
  counterparty is flagged in the review panel for a second look — a
  commitment made to an employee who has since left is not automatically
  void, but it is exactly the kind of fact a reviewer should be asked about
  rather than have silently carry over unremarked; and every **`PersonFact`**
  about Joe carries over unchanged, because a `PersonFact` is about Joe as a
  person, not about his employer, and has no relationship to the
  `WORKS_FOR` edge closing at all.
- *An as-of question.* "What was Joe's role when the Q2 pilot was decided?"
  is answered by intersecting the `Decision`'s own `occurred_at` with every
  `HAS_ROLE` edge's `valid` range for Joe and returning the one range that
  contains it — the same range-containment operator the "in 2026" example
  above uses for a point query, applied here to a derived point (the
  decision's date) rather than "now."

Relations that are not marked temporal in §5.2 (`ATTENDED`, `DISCUSSED`,
`ABOUT`, and the rest) carry no `valid` range at all — attaching one to a
relationship with no meaningful notion of "still open" would be a column
every writer has to remember to leave `unknown` for no reason.

`SUPERSEDES` remains how a reversal is recorded on `Decision`, `Claim`, and
`Commitment` alike: a new row, linked to the old one it replaces, never an
in-place edit of the row it corrects (§3.4). Every "latest on X" query in §9
sorts on `occurred_at`, descending, and reads the chain of `SUPERSEDES` edges
to present the current state plus its history — never on `created_at`, which
would misorder any note written out of order relative to the meetings it
covers.

### 5.5 Review status lifecycle

```
unreviewed → accepted | edited | rejected
accepted | edited → merged (tombstone, merged_into_id)
accepted | edited → superseded
```

`unreviewed` rows exist **only inside a proposal** (§8) — nothing unreviewed
is ever visible to retrieval, the entity page, a brief, or a prompt (§9.4,
§14). `accepted` means committed with no change from what the model
proposed; `edited` means committed after a reviewer corrected a field before
accepting — both are equally "real" from every downstream reader's
perspective, and the distinction exists purely as a UI/audit signal, not a
trust tier. `rejected` rows are kept (never deleted) so a re-extraction does
not propose the identical rejected fact again with no memory of the earlier
"no" (§7's suppression mechanism). `merged` is a tombstone: the row still
exists, points at `merged_into_id`, and is excluded from every read path;
`POST /api/graph/merges/:id/reverse` (§12) restores it. `superseded` marks a
`Decision`/`Claim`/`Commitment` a later row has replaced (§5.4); it stays
fully readable, because history is the point.

Content rows — transcripts and notes themselves — are **evidence**, not
graph rows, and carry no review status of their own: a transcript is trusted
or not trusted by kvox's existing correction workflow entirely independently
of whether anything was ever extracted from it into this graph.

### 5.6 Sensitivity

`PersonFact.sensitivity`: `business | personal | sensitive`.

- **`business`** — work-relevant personal context ("prefers async updates,"
  "based in the Austin office"). Used freely in retrieval, briefs, and the
  note-generation feedback loop (§14).
- **`personal`** — non-work personal context (a hobby, a family detail, a
  personal preference unrelated to how they work). Surfaced in retrieval and
  the entity page; used in the note-prompt feedback loop **only when the
  user has opted in** (§14) — the default is off, because feeding a
  stranger's family details into a generation prompt without being asked is
  a step further than this product's existing bring-your-own-key privacy
  posture (`docs/specs/notes.md` §9) has ever taken.
- **`sensitive`** — anything a reasonable person would not expect repeated
  back to them in an AI-generated summary: health, legal, financial, or
  similarly weighty personal information. **Never used in any prompt
  enrichment, under any setting, ever** (§14, §15) — there is no toggle that
  turns this on, because the harm of getting this default wrong (a sensitive
  fact about a third party who never consented to being profiled quietly
  surfacing in someone else's generated note) is asymmetric with the benefit
  of getting it right slightly more often.

**`sensitive` is never pre-checked in the review panel** (§8) — every
`PersonFact` at that level requires an explicit, deliberate accept, the same
"never silently on by default" posture the review pipeline gives every
uncertain resolution (§7).

### 5.7 Deferred to v2

- **A `Concept`/topic layer**, distinct from `Project`, aligned to SKOS
  (§2). Today a meeting's subject lives as a free-text entry in
  `Meeting.topics[]` — a plain string property, not a graph node — which is
  enough to answer "what came up" without committing to a topic taxonomy
  this document has no evidence kvox's users need yet. See "Rejected
  alternatives."
- **Corpus-wide sensemaking** ("what are the recurring themes across all my
  meetings this quarter") — the specific question Microsoft GraphRAG's
  community-summary architecture answers and this design deliberately does
  not attempt; §9's per-entity digest is the narrow, cheap answer to "what's
  new about *this one thing*," not to "summarize everything."
- ~~A neighbourhood-graph rendering library choice~~ — **no longer
  deferred.** An earlier draft of this document left this open for the P5
  issue that builds the neighbourhood view; §22 (added once the explorer and
  whole-graph overview were specified) makes the choice for both surfaces at
  once — sigma.js + graphology — because a library chosen twice, once per
  view, would risk two different in-memory graph representations for what is
  conceptually one graph.

## 6. Extraction (`kg.extract`)

**Trigger and subject.** `kg.extract` is enqueued automatically the moment a
note reaches `status: 'ready'` (`docs/specs/notes.md` §1.1) and on an
explicit user "Re-extract" action; it is **never** enqueued for a transcript
with no note. A transcript with no generated note has nothing curated to
extract *from* — the note is the reviewed signal a user has already spent
attention shaping (§3.1's instructions, §3.1's context, a possible manual
edit before it settles); the transcript underneath it is evidence the
extraction step cites into, never the thing it reads primary content from.
Subject: `note`, payload `{ noteId, noteVersion }` — deduplicated on subject
while `pending`/`running`, the ordinary queue dedup, `skipDedup` never
needed because there is no self-re-enqueue pattern here the way
`transcription.poll` has (`docs/specs/transcription.md` §1's own warning
about that specific pattern does not apply to this job type at all).

**Inputs, assembled by a pure `buildExtractionContext()` (planned:
`apps/api/src/graph/extraction/extraction-context.ts`):**

- The note body at the version the job was enqueued for (never a live
  re-read mid-job — the same "assemble once, act on that snapshot" posture
  `docs/specs/notes.md` §3.1's `assemblePrompt` takes for generation itself).
- The note's source transcript's segments, compact — ids and millisecond
  ranges included, full word-level timing omitted, mirroring
  `docs/specs/transcription.md`'s own segment-compaction discipline for
  `GET /api/transcripts/:id/segments`.
- `Transcript.speakerIdentities` (verified above) — who was actually
  identified as whom, read directly rather than re-derived.
- The meeting context the user typed (`docs/specs/notes.md` §3.1's Context
  field).
- **The caller's effective schema** — core plus their enabled domains plus
  their own attribute definitions (§17) — which entity types, relation
  types, and attributes this run is allowed to propose at all. A type or
  attribute outside the effective schema is never offered to the model in
  the first place, the same "closed by default" discipline §17.1's `props`
  validation applies to what a proposal may *contain* applied here to what
  extraction may *propose*.
- A **known-entities list**, scoped to this meeting: the attendees' `Person`
  rows, their `Organization`s, any `Project`(s) already named in Context,
  plus the top-N entities by recent mention across the user's own graph —
  each with its id and known aliases, so the model can answer "this is
  entity `kg:<id>`" for something it already knows and "this is new" for
  something it does not, rather than inventing a fresh entity for every
  mention regardless of whether one already exists.

**One provider call, structured output.** A single request per extraction
run — `entities[]`, `relations[]`, `items[]` (the `kg_items` kinds:
`commitment | decision | claim | person_fact`), each carrying an
`evidence[]` array of segment ids and character ranges — using a new
`AiProvider.generateStructured()` method (§20). This codebase's `AiProvider`
interface has neither a structured-output mode nor tool calling today
(verified above: the only provider, OpenAI, is called through Chat
Completions with `response_format: {type: 'json_object'}`, a bare JSON mode
with no schema enforcement) — adding `generateStructured` (OpenAI's
`response_format: {type: 'json_schema', json_schema: {name, strict: true,
schema}}`) is itself foundation work this epic ships before `kg.extract` can
exist at all, gated behind a `structuredOutput` capability flag on the
resolved model (§20.2) so a model that cannot honour a JSON Schema is never
offered for this task in the first place. Zod-validated regardless of the
provider's own enforcement: a malformed answer is a **failed proposal**,
never a partial commit, the identical posture `docs/specs/notes.md` §2.2's
error taxonomy takes for every provider-calling job in this codebase. The
model that runs this call is `AiTaskModelResolver.resolve(userId,
'graph.extract', requestedModel?)` (§20.3) — the administrator's configured
default for this task unless the calling user has overridden it with another
model their own allow-list permits — and is recorded on the resulting
`kg_proposals.model`/`.provider` (§10) exactly as `NoteGeneration` already
records its own (verified above). Every temporal relation and every `kg_items` row also carries
`valid_from`/`valid_to`/`precision` in the extractor's structured output
(§5.4); `precision: 'unknown'` is a legitimate answer the extractor is
required to give rather than guess a plausible-looking date, and it is
preserved as `unknown` unchanged all the way through review and commit — no
later step in this pipeline is permitted to upgrade a guess into a false
precision on the extractor's behalf.

**The model cites evidence ids it was
given, never invents new ones** — an entity or item whose cited segment id
is not among the ones handed to it in this run is dropped outright, counted
in the proposal's `stats` (so a reviewer can see "3 items were dropped for
uncited evidence" rather than silently losing them), enforcing §3.3's
no-orphans rule at the extraction boundary itself rather than trusting a
later check to catch it.

**The prompt/answer exchange is snapshotted on the proposal, exactly as
`NoteGeneration.systemPrompt`/`userContent` (verified above, issue #307)
already snapshots generation's own exchange** — recorded before the provider
call returns, so a failed extraction still records what was asked, and a
reviewer questioning why a particular item was (or wasn't) proposed can see
the exact context the model reasoned from.

**Job execution profile:** `{ maxRuntimeMs: 10 * 60_000, maxAttempts: 1 }`.
One attempt, for the identical reason `note.generate` carries `maxAttempts:
1` (`docs/specs/notes.md` §1.3 decision 3, restated by
`docs/specs/transcript-name-correction.md` §6 for `transcript.name_check`):
the call spends the user's own AI provider credit, and a completion is
non-deterministic, so an automatic retry would silently re-spend the user's
money to propose a *different* set of entities than the draft they may
already be reviewing. Throttled on `aiProviderThrottleKey(userId)` (verified
above) — the per-user key, not a shared deployment bucket, for the same
reason `docs/specs/notes.md` §2.3 gives: every user brings their own vendor
account, so a 429 against one user's key is evidence about that user alone.
**Server-only, permanently** — no `nodeResultSchema`/`persistNodeResult` is
declared, so `JobHandlerRegistry.serverOnlyTypes()` reports it and no worker
node can ever claim it (CLAUDE.md rule 2), for the identical reason
`note.generate` is server-only: the credential in play is the user's own
long-lived vendor key, and no AI vendor here offers a job-scoped sub-key a
`nodeSecretBroker` could mint and hand to a remote machine — the same
argument `docs/specs/notes.md`'s own "Rejected alternatives" makes for
itself.

**Quality bar, stated as a first-class deliverable rather than an
afterthought — per the research summary above.** A golden set of 30
**synthetic**, hand-authored meeting transcripts — invented conversations,
never real recordings or real customer data — kept under
`apps/api/test/fixtures/kg-golden/` (planned) and committed to the
repository like any other fixture, specifically because a real transcript
can never be checked into a repository or run inside CI's shared
environment without becoming exactly the third-party-consent problem §15
already argues against creating even for the product's own users. An eval
script (planned: `apps/api/scripts/kg-eval.ts`) runs `kg.extract`'s prompt
against every fixture and reports per-type precision/recall plus auto-link
precision, run in CI on every change to the extraction prompt or the
ontology definition file. A **second, separate mode of the same script** —
local-only, opt-in, and never run in CI — lets an individual developer point
it at their *own* real transcripts, through their own AI key, on their own
machine, to sanity-check extraction quality against real data before relying
on it; nothing from that local run is ever collected, uploaded, or compared
against the committed synthetic set. Targets: **auto-link precision ≥
0.95**, **`Commitment` recall ≥ 0.85**, **entity coverage ≥ 0.90** — chosen
against the scholarly-extraction baseline (arXiv 2411.08696's 0.80/0.81–0.97
range for a considerably less structured domain than a meeting transcript)
and against the systematic-evaluation finding that under-extraction, not
ranking, is where graph systems actually fail in practice (§"Why this
shape"). These targets are **gates on relaxing §7's resolution thresholds**
— a lower auto-link threshold is only defensible once measured precision
supports it — **not gates on shipping the review UI itself**: the review
panel (§8) exists specifically to catch what extraction gets wrong, so it
ships regardless of where the numbers land, and the numbers are what
determine how much the panel can safely pre-check versus leave for a human.

## 7. Entity resolution (`kg.resolve`)

Resolution runs in two places: **inline**, inside `kg.extract` itself, so
the review panel can already show proposed matches rather than a wall of
"new" rows the user has to link by hand; and **on demand**, as a standalone
`kg.resolve` job, for a bulk re-scan, a re-check after a merge reversal, or a
re-check after a threshold change in the `graph` settings namespace (§10).

**Candidate generation** unions three signals, deliberately over-generating
candidates for the scoring step below to narrow rather than trying to be
precise at this stage:

- **Alias exact match**, case-insensitive (`citext`), against
  `kg_entity_aliases` (§10).
- **`pg_trgm` similarity** ≥ 0.4 over label + aliases — catches
  misspellings and near-matches exact lookup misses.
- **pgvector kNN** (k = 10) over each entity's own profile embedding — label,
  type, organization, role, and top co-mentions concatenated and embedded
  through the existing `SearchQueryEmbedder`
  (`apps/api/src/search/search-query-embedder.service.ts`, verified above) —
  reused rather than duplicated, because a second embedder for the same
  model and dimension contract is a second place for those two facts to
  drift apart.

**Scoring** combines name similarity with context signals, weighted
qualitatively (strong/medium/weak) rather than as a single opaque number,
because the signals genuinely differ in kind: **same-meeting
attendee/speaker match** (strong — the two "Sarah"s were in the same room),
**organization co-mention** (strong — both "Sarah"s work at Acme),
**shared-neighbour overlap** (medium — both connect to the same `Project`),
**recency** (weak — a tie-breaker only, never a deciding signal on its own).

**Thresholds**, stored in the `graph` system-settings namespace (§10,
default values given here): **auto-link ≥ 0.90**, **new < 0.55**, and
everything between routed to **LLM adjudication** — a small, bounded request
carrying a dossier per candidate (its 1–2-hop neighbourhood plus its
supporting quotes, matching the "small, bounded, verification-shaped, never
generation-shaped" call discipline
`docs/specs/transcript-name-correction.md` §12's own "Rejected alternatives"
argues for) that answers `same | different | uncertain` plus a rationale.
`uncertain` goes to the review panel **unchecked** — the same "never
pre-check an uncertain result" posture §5.6 gives sensitive `PersonFact`s.

**Learning, so the same ambiguity is not re-litigated on every future
extraction:** an accepted link becomes an alias row on the survivor, with
provenance recording it came from a confirmed resolution rather than from
the model's own guess; a confirmed "not the same" verdict is recorded in
`kg_distinct_pairs` (§10) and every future candidate-generation pass skips
that pair outright; a rejected `PersonFact` is suppressed by its statement
hash so the identical fact is never re-proposed verbatim after a user has
already said no to it once.

**Curated entities are protected, always.** An entity at `accepted` or
`edited` review status is never auto-merged with *another* curated entity,
regardless of score — merging two things a human has each separately
confirmed requires a human decision, not a score crossing a line. When
exactly one side of a merge is curated, that side is **always** the
survivor, unconditionally.

**Merge mechanics.** A merge tombstones the redundant entity
(`review_status: 'merged'`, `merged_into_id` set, §5.5) and reassigns its
relations, evidence, mentions, and aliases onto the survivor, all inside one
transaction. Every merge is logged in `kg_merges` (§10) with a full reversal
payload — the pre-merge state of the redundant entity and every row that was
reassigned — so `POST /api/graph/merges/:id/reverse` (§12) can restore
exactly what a merge undid, not an approximation of it.

**Work-item dedup — Commitments, Decisions, and Claims are deduplicated
too, not just Person/Organization/Project.** A newly proposed item is
matched against open or otherwise-live items sharing the same `subject` and
owner/organization, using the same embedding-plus-type-filter approach as
entity resolution, and adjudication returns one of three verdicts:
**`same`** (attach the new evidence to the existing row; update its status
or due date if the new text actually says something changed), **`new`** (an
unrelated item, create it), or **`supersedes`** (link the two via
`SUPERSEDES`, §5.4, and mark the earlier one superseded) — the mechanism
that turns "the pilot moved to Q2" arriving twice, once as the original
statement and once as a later correction, into one `Claim` chain rather than
two unrelated rows that silently disagree.

**Closing a temporal edge is a proposal row, not a side effect.** When
§5.4's closing rule fires — a new fact with a `valid` start closing an
existing exclusive edge — the close is itself a `kg_proposal_items` row
("Closes: Joe works for Acme, 2019 → Feb 2026") that goes through the same
`pending | accept | edit | reject | merge_into` decision as everything else
in §8; nothing closes an edge outside a proposal a reviewer acts on. An
overlap between two edges of the same normally-exclusive type is a warning
surfaced in the panel, never a rejection — §5.4's overlap tolerance is
enforced here, at the one place a conflicting pair would otherwise commit
unremarked.

## 8. The proposal and "Send to graph"

**`kg_proposals`** (§10) records one row per extraction run: `note_id`,
`note_version`, the generation-context snapshot (§6), `status`
(`draft | committed | discarded | failed`), and `stats` (counts of proposed,
dropped-for-uncited-evidence, and — post-commit — accepted/edited/rejected
items). **`kg_proposal_items`** holds one row per proposed entity, relation,
or item: `kind`, `payload`, a `resolution` object (`{ ref, score,
candidates[] }` from §7), a per-item `decision`
(`pending | accept | edit | reject | merge_into`), and its `evidence[]`.

**Review panel rows are grouped by type** (People, Organizations, Projects,
Decisions, Commitments, Claims, Person Facts), each row showing its proposed
value, its evidence (one click to the exact ▶ segment or note span), and —
where §7's resolution produced one — its matched entity.

**Pre-check rule.** A row is pre-checked (defaulted to `accept`) exactly
when: its resolution score is at or above the auto-link threshold **and**
its kind is not `PersonFact` **and** it is not flagged as a possible
duplicate by §7's own uncertain-adjudication path. `PersonFact` is
categorically excluded from pre-checking regardless of resolution
confidence — resolving *who* the fact is about being confident says nothing
about whether surfacing the fact itself was the reviewer's intent, which is
exactly §5.6's sensitivity handling restated as a UI default rather than a
storage rule.

**"Known, skipped" rows.** A proposed relation or claim that already exists
verbatim — the same endpoints, the same statement hash — is shown collapsed
rather than proposed as a duplicate row to accept, and its evidence is
appended to the existing row's evidence set even though nothing new is
created: a second meeting restating "Sarah owns the vendor migration" is
additional support for a fact the graph already has, not a second fact.

**Commit semantics.** `POST /api/graph/proposals/:id/commit` (§12) applies
every `accept | edit | merge_into` item **in one transaction**: entities,
relations, items, and evidence are upserted, aliases and distinct pairs are
recorded, `kg.entity_digest` (§9.2) is enqueued for every touched entity, and
`kg.embed` (§11) is enqueued for every new or edited one. The commit is
audited as `graph.proposal_committed`. **This is the transaction §3.3's
no-orphans invariant is enforced inside** — an item committed with no
evidence row is a bug in this transaction, not a state the schema merely
discourages, and it is covered by a dedicated test (§"Verification").

**Re-extraction on an already-committed note** produces a **new draft**
whose items are diffed against the current graph — only genuinely new or
changed rows are shown, so re-running extraction after an edit to the note
does not re-present everything the first pass already committed as if it
were new.

**Nothing else writes to the graph.** The commit above is the only general
write path, with exactly two named exceptions: the **speaker-naming write**
(`IDENTIFIED_AS` plus a `Person` row, because the user typing a name against
"Speaker A" *is itself* the review — there is no separate confirmation step
that act could sensibly wait for), enqueued as **`kg.speaker_link`** (§11)
from `TranscriptEditingService.identify()` (verified above) rather than
performed inline in that request — CLAUDE.md's job-queue rule applies here
exactly as everywhere else, however small the write — and a **manual edit on
an entity page**
(§13) — a person directly correcting a `Person`'s name or an `Organization`'s
label after the fact, which is curation by construction and needs no
proposal to wrap it.

## 9. Retrieval

### 9.1 Entity brief

`GET /api/graph/entities/:id/brief?since=&as_of=` (§12, planned) answers
"what's the latest on Company A" (or a person, or a project) in one call:

1. **Entity → 1–2-hop walk**, bounded, over `kg_relations` — direct
   connections and, where the first hop is another entity rather than an
   item, one hop further (never deeper — §3.5's "narrow schema" principle
   extended to query shape: an unbounded walk over a graph this size answers
   a question nobody asked and costs latency nobody budgeted).
2. **Items in the requested window** (`occurred_at > since`, or the digest's
   `covers_until` when no `since` is given, §9.2) — the `Claim`s,
   `Decision`s, and `Commitment`s that actually changed.
3. **FTS + pgvector over segments and notes**, fused with
   **`reciprocalRankFusion()`** (`apps/api/src/search/search-fusion.ts`,
   verified above, `RRF_K = 60`) — the *exact same* fusion function
   `docs/specs/search.md` already uses for its two retrieval arms, reused
   rather than re-implemented, because a second RRF implementation that
   could disagree with the first about how two rankings combine is exactly
   the kind of drift `docs/specs/notes.md`'s own "one function, two callers"
   discipline (§2.5) argues against wherever it recurs in this codebase.
4. **× recency × confidence**, then an **LLM composition step** that writes
   the brief with **mandatory citations** — every stated fact traces, through
   its item id, to the evidence (§5.3) that supports it, down to the ▶
   segment or note span a reader can click through to.

Sections, in order: **What changed** · **Decisions** · **Open commitments
(theirs / yours)** · **Risks / claims** · **People changes**. **People
changes** reads directly off §5.4's closing rule: every edge of a normally
exclusive type closed since the window's start — a promotion, a manager
change, a company change — surfaces here by name, rather than being left for
a reader to notice buried in the raw relation list.

**`as_of`, on this endpoint and on the neighbourhood endpoint (§12, §13),
answers the identical brief or neighbourhood walk as of a past date instead
of now** — the same range-containment query §5.4's "an as-of question"
worked example uses, exposed here as a first-class query parameter rather
than a one-off. `since` and `as_of` answer different questions and are not
interchangeable: `since` bounds which **items** are new enough to include;
`as_of` changes which **edges** are considered open at all, by evaluating
every `valid` range against that date instead of the present moment.

### 9.2 Entity digest (`kg.entity_digest`)

A per-entity rolling summary, so a busy entity's brief does not have to
re-read and re-summarize its entire history on every view. Deduplicated per
entity (one pending digest job per entity at a time — the ordinary queue
dedup, no `skipDedup` needed), it writes `kg_entity_digests (entity_id,
summary, citations, covers_until, generated_at)` — the running summary plus
the timestamp up to which it accounts for everything. A brief request is
then: the digest, plus whatever items are newer than `covers_until`, never a
full re-summarization from scratch. Enqueued after every commit that touches
the entity (§8), and its `covers_until` is what makes the entity brief cheap
even for an entity mentioned in fifty meetings.

**"Since I last looked"** is a separate, per-viewer fact: `kg_entity_views
(user_id, entity_id, last_viewed_at)` (§10), read to compute what's "new"
*for this specific reader* on top of the shared digest — two different
users looking at the same entity see the same underlying digest but a
different "what's changed since you last checked" delta.

### 9.3 Agent tools

The endpoints in §12 are re-exposed as a typed toolset — `search`,
`get_entity`, `neighbors`, `evidence`, `timeline`, `entity_brief` — for any
future agent-style consumer of this graph. **No free-form SQL or Cypher is
ever generated by a model, for any purpose, at any point in this design.**
Every tool call resolves to one of the fixed, parameterized query shapes
already described above; there is no tool that hands a model a query
language and asks it to write one.

### 9.4 Graph-only is forbidden by design, not merely discouraged

Nothing in this document's design ever answers a retrieval question from the
graph alone. Every brief, every entity page, every search result fuses the
graph signal with the existing FTS+vector legs (§9.1's step 3) — because the
research this design rests on (§"Why this shape") found that only 65.8%/65.5%
of the entities a correct answer actually needed were present in graphs
comparable systems had built, meaning a graph-only design silently fails on
roughly a third of real questions with no visible symptom beyond an
incomplete answer that looks complete. The FTS+vector leg is not a fallback
bolted on for robustness — it is the leg that covers exactly the extraction
misses §6's own quality bar cannot fully close no matter how well it is
tuned, and treating it as load-bearing rather than optional is the direct,
mechanical response to that specific finding.

## 10. Data model

This section's tables (all `snake_case`-mapped Prisma models — built by issue #351,
epic #344; column-level reasoning lives in the block comment above each model in
`apps/api/prisma/schema.prisma`, following the discipline `notes.md` §4 and
`transcript-name-correction.md` §8 already establish; this section is the
summary, kept in sync with that schema by issue #351's own "definition of done"):

- **`kg_entities`** — `Person`, `Organization`, `Project`, `Meeting` (`type`
  is plain text, not a Prisma enum — an ontology key, §17.4, not a schema-owned
  state machine), `label`, `props` JSONB, `embedding vector(1536)` — reusing the exact
  model/dimension contract `SearchEmbedding` already carries, verified above,
  rather than a second embedding convention — plus `embedding_model`/
  `embedding_hash` (#364's `kg.embed` re-embed key, mirroring
  `SearchChunk.contentHash`) — `review_status` (§5.5),
  `merged_into_id` (self-relation, nullable), `occurred_at` (`Meeting` only),
  `ontology_version` (§17.4 — the definition-file version this row was
  written against). `owner_id` **Cascade** — the same reasoning `notes.owner_id`/
  `transcripts.owner_id` already establish: an entity has no meaning and no
  permission path to read it once its owner is gone, and there is no
  `graph:read_any` (§12) for the identical reason there is no
  `notes:read_any`.
- **`kg_entity_aliases`** — a separate table, not an array column on
  `kg_entities`, specifically because an alias needs its own indexed
  exact/`citext` lookup *and* its own provenance (`source`:
  `user | extraction | speaker_naming`, plus `evidence`) — a plain array
  column can hold the strings but not which of three very different origins
  each one came from, and that provenance is exactly what §7's "learning"
  step needs to record. `entity_id` **Cascade**.
- **`kg_relations`** — `type` (§5.2's sixteen), `from_id`, `to_id`, `props`
  JSONB, `valid tstzrange` + `valid_precision` (`day | month | year |
  unknown`, §5.4 — `valid_from`/`valid_to` name the range's lower and upper
  bound throughout this document's prose, but there is exactly one stored
  column, a range, never two nullable timestamps), `review_status` (§5.5),
  `confidence`, `ontology_version` (§17.4). No inverse row is ever stored
  (§5.2). `owner_id` Cascade. **`from_speaker_id`** (uuid, nullable, FK
  `transcript_speakers` Cascade) is a contract addition landed by issue #351:
  the `IDENTIFIED_AS` edge's source is a diarized speaker, not a resolved
  entity, so `from_id` and `from_speaker_id` are exactly-one-of (a CHECK, not
  a polymorphic `from_kind`/`from_id` pair without FKs — the rejected
  alternative below), and `from_speaker_id` is restricted to the one relation
  type whose source is a speaker.
- **`kg_items`** — `Commitment`, `Decision`, `Claim`, and `PersonFact` **in
  one table**, not four, distinguished by a `kind` enum: `subject_id`,
  `statement`/`title`, `status`, `occurred_at`, `due_at`, `valid tstzrange` +
  `valid_precision` alongside `occurred_at` (§5.4 — the same bitemporal pair
  `kg_relations` carries, so an item's own valid period, when it has one, is
  never a second stored shape from its edges' shape), `owner_person_id`
  (Person), `counterparty_id`, `superseded_by_id`, `sensitivity` (nullable —
  only meaningful when `kind = 'person_fact'`, §5.6, enforced by a CHECK), a
  matching CHECK requiring `subject_id` on `claim`/`person_fact` rows,
  `statement_hash` (§7's
  dedup and suppression key), `embedding` plus `embedding_model`/
  `embedding_hash` (mirroring `kg_entities` above), `ontology_version` (§17.4).
  **`meeting_id`** (uuid, nullable, FK `kg_entities` SetNull) is a contract
  addition landed by issue #351: it backs `CREATED_IN`/`DECIDED_IN` (§5.2)
  directly on the item rather than as a stored edge — the same "items carry
  their own links" argument this section's own rejected-alternatives entry
  makes for `ABOUT`/`ASSIGNED_TO`/`OWED_TO`. One
  table because all four kinds
  share the same lifecycle (§5.5), the same evidence and dedup mechanics
  (§7), and the same `occurred_at`-sorted "what's changed" query (§9.1) —
  four separate tables would mean writing that query, that dedup pass, and
  that review-status transition four times over rather than once. `owner_id`
  Cascade.
- **`kg_evidence`** — the §5.3 contract, exactly as specified there.
  Foreign keys into `transcripts`/`transcript_segments`/`notes` are
  **`SetNull`**, not `Restrict` — a deliberate divergence from
  `notes.source_transcript_id`'s `Restrict` (`docs/specs/notes.md` §4.1):
  that FK is `Restrict` because a note's *source* is a dependency a delete
  must not silently break, while an evidence row's link to its segment or
  note is a **pointer** a citation can survive losing — `quote` (§5.3) is
  precisely what keeps the citation readable once the thing it pointed to is
  gone, which is the entire reason `quote` is stored rather than resolved
  live on every read.
- **`kg_mentions`** — `(note_id | transcript_id, entity_id, span)` — the
  coarse `MENTIONS` shortcut (§5.2), what an entity page's "notes about Joe"
  section reads. `entity_id`/`note_id`/`transcript_id` **Cascade** — a
  mention has no meaning once either side is gone, unlike evidence's
  pointer relationship above.
- **`kg_proposals`** — one row per extraction, import, or resolution run:
  `note_id`/`note_version` (null for `import`/`resolution`), `kind`
  (`extraction | import | resolution` — `resolution` landed by issue #351
  alongside every other proposal-model column below, so #364 needs no schema
  change of its own; #364 owns the prose for what a `resolution` proposal
  is), `status` (`draft | extracting | committed | discarded | failed |
  reverted` — `extracting` landed by issue #351 for the identical
  no-later-migration reason; #363 owns the prose for the `extracting`
  lifecycle: `extracting → draft | failed`, `draft → committed | discarded`,
  `failed → discarded`, `committed → reverted`), `model`/`provider` (§20 — which task-model resolution
  actually ran, recorded rather than re-derived, so an administrator
  changing the default tomorrow never rewrites what an already-committed
  proposal used yesterday), `system_prompt`/`user_content` (the generation-
  context snapshot, §6), `user_guidance` JSONB (§19.1 — pinned entities, a
  type selection, free text, read by `kg.extract`'s prompt builder), `stats`
  JSONB, `committed_at`/`reverted_at`, `job_id`. **`commit_log`** (JSONB,
  nullable) is a contract addition landed by issue #351: #366's internal
  undo record — the commit writes it, the revert reads it — never
  serialized to clients (`stats` is the display copy). A CHECK
  (`kg_proposals_note_source_chk`) requires `note_version` on every
  `extraction` proposal and both `note_id`/`note_version` NULL on
  `import`/`resolution`; it keys on `note_version`, never `note_id`, because
  `note_id` is `SetNull` and can go NULL later (a hard-deleted note) while
  `note_version` never does. Two hand-written partial unique indexes cap
  concurrency beyond the existing "at most one open draft per note" one:
  **at most one `extracting` proposal per note**, and **at most one
  `extracting` `import` proposal per owner** (scoped by `owner_id`, since an
  import has no note) — both landed by issue #351 for #363's/#387's 409s.
  `owner_id` Cascade.
- **`kg_proposal_items`** — one row per proposed entity, relation, or item:
  `kind` (`entity | relation | item | closing` — `closing` is §7's "closing
  a temporal edge is a proposal row" case), `payload`, `resolution` JSONB
  (§7's `{ ref, score, candidates[] }`), a per-item `decision` (`pending |
  accept | edit | reject | merge_into`), `edited_payload` (set when
  `decision: edit`), `flags` text[] (§7's `overlaps`, an uncertain-
  adjudication flag, a possible-duplicate flag — read by the review panel's
  pre-check rule, §8), `origin` (`ai | user` — `user` for a row created by
  §19.3's "Add to graph" from a text selection or by a reviewer's own manual
  add, never proposed by the model, and excluded from `kg.extract`'s own
  precision/recall accounting in §6's eval harness for the identical reason
  a human's own correction is never scored as a model error), `committed_ref_id`
  (the `kg_entities`/`kg_relations`/`kg_items` row this item became once
  committed — §19.4's revert reads this to know exactly what to undo).
  **`merge_into_id`** (uuid, nullable, FK `kg_entities` SetNull) and
  **`distinct_from`** (uuid[], default `{}`) are contract additions landed by
  issue #351 for #366's reviewer overrides: `merge_into_id` is set **iff**
  `decision = 'merge_into'` (a CHECK), SetNull so losing the target entity
  clears the override rather than blocking its delete — #366 refuses a
  `merge_into` row with no target at commit — and `distinct_from` records the
  "not the same as" candidates a reviewer ruled out, as plain uuids with no
  FK (recorded facts about a review decision, not live references).
- **`kg_graph_layouts`** — one row per computed whole-graph layout (§22):
  `computed_at`, `node_count`, `edge_count`, `clusters` JSONB (which
  community each node belongs to), `positions` JSONB (precomputed 2D
  coordinates per node), `ontology_version`. Exactly one *latest* row per
  `owner_id` — `GET /api/graph/overview` (§22.3) always reads the newest,
  never recomputes at request time, the same "precompute once, read
  cheaply" economy `kg_entity_digests` already gives the entity brief.
  `owner_id` Cascade. Added in its own migration (§16, P4/P5), after the
  tables above.
- **`ask_conversations`** / **`ask_messages`** — §21's own tables, added in
  their own migration because Ask is a separate module from the core `kg_*`
  set, not a graph table itself: a saved back-and-forth with the read-only
  graph agent. `ask_conversations`: `owner_id`, `title`, `scope_entity_id`
  nullable (set when a conversation was started from an entity page's Ask
  panel, §21.5), `created_at`/`updated_at`. `ask_messages`:
  `conversation_id` (Cascade), `role` (`user | assistant`), `content`,
  `status` (`pending | streaming | complete | failed` — the identical shape
  `note_generations` already uses, verified above), `tool_calls` JSONB (the
  agent's own tool-call trace, read by the citation-validity check in
  §"Verification"), `citations` JSONB, `model`/`provider` (§20.3), token
  counts, `error_class`, `job_id`. `owner_id`-equivalent access runs through
  `ask_conversations.owner_id`; `ask_messages` has no owner column of its
  own, mirroring how `note_generations.noteId` (verified above) carries
  ownership through its parent rather than duplicating it.
- **`kg_merges`** — one row per merge (§7), with the full reversal payload.
- **`kg_distinct_pairs`** — confirmed-not-the-same pairs (§7), skipped by
  every future candidate-generation pass.
- **`kg_entity_digests`** — §9.2.
- **`kg_entity_views`** — `(user_id, entity_id, last_viewed_at)`, partial
  unique on `(user_id, entity_id)` (§9.2).
- **`kg_attribute_defs`** — one row per user-defined attribute (§17.3):
  `(id, owner_id, entity_type, key, label, kind, options jsonb, extractable,
  extraction_hint, sensitivity, sort_order, deprecated_at)`. `owner_id`
  Cascade, the same reasoning every other `kg_*` table's `owner_id` follows.

**Indexes.** `pg_trgm` GIN on `label`/`alias` (§7's candidate generation);
HNSW cosine on every embedding column, matching `SearchEmbedding`'s own
hand-written index discipline (verified above — Prisma cannot express
`USING hnsw`, so this is intentional schema drift in the migration only, the
same pattern `jobs`, `database_backup_runs`, `transcript_speakers`, and
`SearchEmbedding` itself already establish); `(owner_id, from_id, type)` and
`(owner_id, to_id, type)` on `kg_relations` (§5.2's "joins are symmetric"
argument, made concrete); a **GiST index on `valid`**, on both `kg_relations`
and `kg_items` (§5.4 — the range-containment (`@>`) and overlap (`&&`)
queries §5.4's worked examples and closing rule depend on need this, not the
plain b-tree a bare pair of timestamp columns would have used);
`(owner_id, subject_id, occurred_at desc)` on `kg_items` (§9.1's brief
query); a partial unique on `kg_entity_views(user_id, entity_id)`.

**`pg_trgm` is a new migration requirement for this codebase — pgvector
already is not** (`SearchEmbedding` already depends on it, verified above),
worth stating plainly because it is the one new PostgreSQL extension this
epic's foundation phase (§16, P1) actually needs to enable.

## 11. Job types

Eleven types, all under `apps/api/src/graph/handlers/` (planned) except
`ask.respond`, which lives under `apps/api/src/ask/handlers/` (planned) —
Ask is its own module (§21), reusing the graph's job-queue conventions
rather than being folded into a handler directory it does not belong in:

| Job type | Profile | Node-eligible? | Reasoning |
|---|---|---|---|
| `kg.extract` | `{ maxRuntimeMs: 10m, maxAttempts: 1 }` | **No** | §6 — user's own AI key, `maxAttempts: 1` for the identical reason `note.generate` carries it |
| `kg.resolve` | `{ maxRuntimeMs: 20m, maxAttempts: 1 }` | **No** | §7 — same credential reasoning; a bulk re-scan spends the same per-user key |
| `kg.entity_digest` | `{ maxRuntimeMs: 5m, maxAttempts: 1 }` | **No** | §9.2 — same credential reasoning; deduplicated per entity |
| `kg.embed` | `{ maxRuntimeMs: 5m, maxAttempts: 3 }` | **No** | Uses the user's own embedding provider key via the existing `SearchQueryEmbedder`; retry-safe because it is content-hash keyed, so a retry re-embeds the identical input and produces the identical vector — unlike `kg.extract`/`kg.resolve`/`kg.entity_digest`, a retry here has no non-determinism to worry about, hence `maxAttempts: 3` rather than 1 |
| `kg.speaker_link` | `{ maxRuntimeMs: 2m, maxAttempts: 3 }` | **No** | §8's speaker-naming write, enqueued from `TranscriptEditingService.identify()` (verified above) rather than performed inline — writes directly to the owner's graph tables over the ordinary Prisma pool, no AI key involved and no artifact a node could fetch or produce; idempotent (re-linking the same speaker to the same `Person` a second time is a no-op), hence `maxAttempts: 3` rather than 1 |
| `kg.graph_layout` | `{ maxRuntimeMs: 15m, maxAttempts: 2 }` | **No** | §22.3 — reads every relation and entity the owner's graph holds to compute clusters and a layout; no AI key involved, but no node-side artifact for a worker to fetch or produce the way `media.audio.transcode`'s single input file is either — the computation *is* reading the owner's whole graph over the Prisma pool. Deduplicated per owner, one pending layout job at a time |
| `kg.purge` | `{ maxRuntimeMs: 30m, maxAttempts: 3 }` | **No** | Server-only, destructive fan-out — the identical CLAUDE.md rule-2 reasoning `user.data.purge` states for itself: this job type holds the authority to delete a user's graph data across several tables, and there is no credential narrow enough for a `nodeSecretBroker` to hand a worker node instead |
| `kg.migrate` | `{ maxRuntimeMs: 60m, maxAttempts: 3 }` | **No** | §17.4 — reshapes one user's existing graph rows after an ontology bump (a deprecated type re-tagged, an attribute's `kind` corrected); server-only because it writes across several `kg_*` tables under the same authority `kg.purge` already needs, idempotent per row so a retry after a partial run never double-applies a reshape to a row already reshaped |
| `kg.export` | `{ maxRuntimeMs: 10m, maxAttempts: 3 }` | **No** | §18.2 — server-only for the identical "the renderers live in the API" reason `note.export` gives (`docs/specs/notes.md`): the RDF/JSON-LD serializers live in `apps/api`, and a second copy anywhere else would mean one export request producing byte-for-byte different files depending on which codebase rendered it |
| `kg.import` | `{ maxRuntimeMs: 30m, maxAttempts: 1 }` | **No** | §18.3 — server-only, one attempt: a half-applied import must surface as a failed job a person looks at, never silently resume minutes later, the identical reasoning `user.data.purge` gives for its own `maxAttempts: 1` |
| `ask.respond` | `{ maxRuntimeMs: 5m, maxAttempts: 1 }` | **No** | §21.3 — identical reasoning to `kg.extract`: the user's own AI key, `maxAttempts: 1` because a retried agent turn would silently re-spend the user's provider credit to produce a different, non-deterministic answer to a question the user already saw partway through. Throttled on `aiProviderThrottleKey(userId)` exactly like every other AI-calling type in this table |

**Priorities.** `kg.extract` runs at priority **−5** — someone is plausibly
watching the review panel for their note fill in, the same "someone is
watching a spinner" reasoning `transcript.export`'s −10 and `note.export`'s
−10 both state for themselves, though slightly less urgent than an export
download because a proposal panel is a review step, not a wait-for-a-file
moment. `ask.respond` runs at priority **−10**, the identical download-and-
wait urgency `note.export`/`transcript.export` state for themselves — a
person is watching the agent's own answer stream in real time. `kg.graph_layout`
and `kg.speaker_link` run at the deployment default: neither is watched
synchronously the way an extraction proposal or an agent answer is. Every
other type in this table runs at the deployment default;
`kg.entity_digest` is specifically enqueued **after** a commit settles, never
before, so it always summarizes the post-commit state rather than racing it.

**`kg.purge` also serves the Danger Zone.** `docs/specs/user-data-deletion.md`'s
scope matrix (`content` and `everything`) gains the graph as a category once
this epic ships: deleting a user's content deletes their graph rows too,
through the identical fan-out-to-existing-handlers pattern that document's
§2 (the scope matrix) already establishes for transcripts and notes — `kg.purge` is the handler
that fan-out calls, never a second implementation of bulk deletion.

## 12. Endpoints

`apps/api/src/graph/graph.controller.ts` (planned), prefix `/api/graph`,
gated by a **new permission pair**, `graph:read`/`graph:write`, seeded to all
three roles (Admin, Contributor, Viewer) — the same posture
`notes:read`/`write` and `transcripts:read`/`write` already take, and for
the identical reason: building and reading one's own connected knowledge is
this feature's core product action, not an operational surface, and this
app's default role is Viewer.

- **`graph:read`** — entity list/search/get/brief/neighbourhood/timeline,
  proposal get, mentions, `GET /api/graph/ontology` (§17.4 — the caller's own
  effective schema), and the two export routes `GET /api/graph/ontology.ttl`
  /`.shacl.ttl` and `GET /api/graph/export` (§18.2 — reading one's own graph
  or its shapes out in a standard format is a read, not a write).
- **`graph:write`** — proposal commit/discard, re-extract, entity
  create/edit/merge/reverse-merge/forget-a-person, relation edit, resolution
  settings, `kg_attribute_defs` CRUD (§17.3 — adding, editing, and
  deprecating a user-defined attribute is authoring the schema one proposes
  against, gated the same as every other write to it), and import (§18.3 —
  an import ultimately writes rows to the graph, exactly like a proposal
  commit, and is gated identically).

`GraphAccessService` (planned) mirrors `NoteAccessService`
(`apps/api/src/notes/access/note-access.service.ts`, verified above) exactly:
**owner-only, 404 never 403, no `read_any`** — the identical reasoning
transcripts and notes already state for themselves, applied to this graph's
rows: a private conversation's derived facts are not shared infrastructure,
and confirming a specific entity id exists (a 403 would do exactly that) is
itself information a stranger has no business learning.

**Sharing does not propagate.** A transcript share (`docs/specs/
transcription.md`'s `transcript_shares`, `viewer`/`editor`) does **not**
share the graph rows derived from that transcript. The graph is the owner's
own curated memory built *from* the recording; the share was of the
recording itself, a different object entirely. The stated consequence:
revoking a transcript share revokes nothing on the graph side, because
nothing was ever shared there to revoke.

**Additional routes §19–§22 add, under the same two permissions.**
`graph:read` also gates the read side of proposal review — `GET
/api/graph/proposals`, `GET /api/graph/proposals/:id`, `GET
/api/graph/notes/:noteId/proposal`, and `GET /api/graph/extract/estimate`
(§19 — a cost estimate before spending a run, the same shape `GET
/api/transcripts/:id/name-checks/estimate` already gives its own AI-calling
feature) — as well as `GET /api/graph/overview` (§22.3's whole-graph
snapshot) and `POST /api/graph/explore/expand` (§22.2 — a read of the
caller's own graph even though it is a `POST`, because the node-id list it
accepts does not fit a query string). `graph:write` also gates every
proposal decision — `PATCH .../items/:itemId`, `POST .../items` (add-missing
from a selection, §19.3), `POST .../items/bulk` (§19.2's group actions),
`POST .../commit`, `POST .../discard`, and `POST .../revert` (§19.4) —
`POST /api/graph/notes/:noteId/extract` (§6, taking §20.3's optional model
override), entity `merge`/`merges/:id/reverse`/`distinct-pairs` (§7),
`entities/:id/forget` (§15), and `POST /api/graph/overview/refresh` (§22.3, a
manual re-cluster).

**Ask is a separate controller and OpenAPI tag (`Ask`,
`apps/api/src/ask/ask.controller.ts`, planned) but a reused permission.**
`GET/POST/PATCH/DELETE /api/ask/conversations[...]`, `POST .../messages`, and
`GET /api/ask/messages/:id/stream` (§21) are gated on `graph:read` alone,
with no `ask:*` pair — asking a question of one's own graph is a read of it,
the identical reasoning that already lets `notes:read` cover `GET
/api/notes/:id/stream` rather than a `notes:read`/`stream:read` split. There
is deliberately no write permission for Ask: a conversation and its messages
are the caller's own scratch history over data they can already read, not a
second surface with its own authority.

**Task-model configuration reuses the existing AI settings routes rather
than adding new ones (§20).** `ai.taskModels` and `ai.graphEnabled` are two
more fields on the `ai` system-settings namespace, read and written through
the existing `GET`/`PUT /api/ai-settings` (`system_settings:read`/`:write`)
exactly as every other `ai` field already is — and `GET /api/ai/config`
gains the caller's own resolved `taskModels` (which model each graph task
will actually run with, after applying any override the caller is permitted)
and `graphEnabled`, the identical "what does this deployment permit and does
the caller have a key" contract that endpoint already answers for
`docs/specs/notes.md`'s own feature.

**New 409 `details.reason` values this epic adds:** `graph_disabled`
(`ai.graphEnabled` is off), `extraction_running` (a draft proposal already
exists for this note version), `proposal_not_draft` (acting on a
committed/discarded/reverted proposal), `stale_note_version` (extracting
against a note version that has since changed), `revert_conflict` (§19.4 —
one or more of the proposal's committed rows has been touched since commit),
and `model_lacks_capability` (§20.2 — the requested model does not report
`structuredOutput` for an extraction/adjudication/digest task or
`toolCalling` for the agent).

## 13. Web surfaces

**Proposal panel** — a side sheet on the note page, **not a tab**. Per
Settings UI Pattern rule 2 (CLAUDE.md), a tab gate is about *content*
within one destination, while reachability is about the *route*; the
proposal panel is neither a destination nor parallel content to the note
itself — it is a transient review surface over the note that is already
open, which is exactly what a side sheet is for and a tab strip is not.

**Entity page**, at `/graph/:id` (planned) — "everything about Joe": the
entity's properties, its 1–2-hop neighbourhood (below), its open commitments,
its recent claims and decisions, and the entity brief (§9.1).

**Neighbourhood view**, inside the entity page — 1–2 hops, entity-centred,
never a whole-graph rendering (§3.5's "narrow schema" extended to the UI: a
whole-graph view for a shallow, meeting-scoped graph is a view nobody asked
for and a rendering cost nobody budgeted). The rendering library named as a
deferred decision here in an earlier draft of this document is deferred no
longer — §22 chooses sigma.js + graphology and records `react-force-graph`
and `cytoscape` as rejected, once this document actually had to build the
whole-graph overview (§22) and could no longer leave the neighbourhood
widget's own library unstated without also leaving the overview's unstated.

**Route ownership.** None of this needs a new bottom-bar destination (below),
but every route this epic adds is still a route, and `apps/web/src/config/
destinations.ts`'s own route-ownership test (verified above) fails an
unowned one — so `/graph`, `/graph/entities/:id`, `/graph/explore`,
`/graph/overview`, `/ask`, and `/ask/:conversationId` (§21.5, §22) are all
declared under the **`home`** destination's `DESTINATION_ROUTES` prefix: none
of them is a natural extension of `transcripts`, `notes`, or `settings`, and
`home` is already where a user arrives from before reaching any of the entry
points below. `/settings/knowledge-graph` (below) is the one exception — a
settings-card route, owned through `USER_SETTINGS_SECTIONS` the way every
other settings route already is, not through `DESTINATION_ROUTES`.

**No new bottom-bar destination.** `apps/web/src/config/destinations.ts`
(verified above) is at its four-tab ceiling by design — `home`,
`transcripts`, `notes`, `settings`, with `console` pinned rather than
occupying a fifth slot — and this document does not ask for a sixth. The
graph and Ask are reached from within existing surfaces instead: a new
**Knowledge** section on `HomePage.tsx` (verified above) surfacing recent
entities, the "Waiting for review" card (§19.5), and an Ask entry point; the
proposal panel on a note (§8, §19); an entity chip added to a transcript's
speaker list (linking a named speaker to their `Person` page); and from
search results that resolve to a graph entity.

**A user-settings card, `Knowledge graph`** (thresholds, resolution mode,
domain toggles, a user-defined-attribute browser, gated `graph:write`) is
the **only** registry entry this document adds, in
`apps/web/src/config/userSettingsSections.tsx`'s `USER_SETTINGS_SECTIONS`
(Settings UI Pattern rule 1) — no admin card, because resolution thresholds
and extraction behaviour are a per-user preference over one's own graph, not
a deployment-wide policy. This is not the same claim as "no admin surface at
all": the two knobs that genuinely are deployment policy —
`ai.graphEnabled` and the per-task model defaults (§20) — get **no new card
either**, registry or otherwise; they land as two new sections on the
*existing* `/admin/settings/ai` page (`AiSettingsPage.tsx`, already
registered on `system_settings:read`/`:write`, verified above), because they
are two more fields on a policy that page already owns, not a graph-specific
surface Settings UI Pattern rule 1 would require its own card for.

**Every form on these surfaces is schema-driven, never hand-coded per
type.** The proposal panel (§8), the entity page's edit form, and this
settings card's attribute browser are all generated from
`GET /api/graph/ontology`'s payload (§17.4) — a control per declared
attribute, its `kind` choosing the widget — rather than each shipping its own
per-type form component. A type added to the definition file after this
section is written renders correctly in all three surfaces with zero web
changes, because none of them was ever coded against a fixed list of types.

## 14. Feedback into transcription and notes

Three feedback loops close the circle between what the graph already knows
and what the transcription/notes pipeline does with a *future* meeting —
each reusing an existing mechanism rather than inventing a new one:

- **Aliases feed `keyterms` at submission time.** The names of a meeting's
  expected attendees' `Person` entities, their `Organization`s, and any
  named `Project`s become the `keyterms` hint
  (`docs/specs/transcript-name-correction.md` §2) `POST /api/transcripts`
  submits with the recording, capped by `MAX_TRANSCRIPT_KEYTERMS` (verified
  above, = 200) — the graph is, concretely, a better source for "who's
  probably in this recording" than asking the user to type names by hand
  every time.
- **The same list feeds the name-check dictionary.** The identical set of
  names becomes `terms` for `POST /api/transcripts/:id/name-checks`
  (`docs/specs/transcript-name-correction.md` §3), so a name the graph
  already knows about a person is a name the phonetic/discovery pipeline is
  specifically looking for, rather than one it has to rediscover cold on
  every transcript.
- **Accepted facts feed the note-generation prompt, gated by sensitivity.**
  `business`-sensitivity `Claim`s and `PersonFact`s about a meeting's
  attendees are added to the note prompt's context block (§5.6);
  `personal`-sensitivity facts are added only when the user has explicitly
  opted in; `sensitive` facts are **never** added, under any setting — the
  same rule §5.6 and §15 both state, restated here as the concrete point
  where it would otherwise be tempting to relax it "just this once" for a
  better summary.

## 15. Privacy — what leaves the deployment, under whose key

**What leaves, and to whom.** A note's body, its source transcript's
segments, its identified speaker names, and the labels of the known
entities assembled for a meeting (§6) go to **the user's own AI provider
account** — the identical bring-your-own-key posture `docs/specs/notes.md`
§9 already establishes for note generation itself, extended unchanged to
extraction, because extraction is, mechanically, another provider call
billed to and authorised by the same account. Embeddings (§7, §11's
`kg.embed`) go to the user's own embedding provider, for the same reason.

**What never leaves, under any setting.** `sensitive`-classified
`PersonFact`s (§5.6) — never sent for extraction context enrichment, never
sent in a note prompt (§14), never surfaced in a brief unless a user
explicitly opens the entity page and asks. Another user's graph data —
`graph:read_any` does not exist (§12), so there is no path by which one
user's extraction, resolution, or brief could ever read a second user's
rows.

**Third-party consent, stated honestly rather than glossed over.**
`PersonFact`s describe people who did not themselves consent to being
profiled by this system — the subject of a `PersonFact` is very often
someone other than the account holder generating the note. The mitigations
this design applies, restated together because no single one of them is
sufficient alone: sensitivity **defaults to `personal`** for anything not
plainly work-related (§5.6), rather than defaulting to the lower-friction
`business`; nothing at `sensitive` level is ever pre-checked in the review
panel (§8); and **"Forget this person"** (`kg.purge`, §11, scope `person`)
removes that `Person` entity, its aliases, every relation naming it, every
item where it is `subject`/`owner`/`counterparty`, its mentions, and its
evidence — **the underlying transcript or note text is left untouched**,
because that recording is the account holder's own content, not the third
party's, and this design's authority to delete stops at the graph it built,
not at the primary source it was built from.

**The Danger Zone scopes gain the graph** (§11's `kg.purge` note) — deleting
one's own `content` or `everything` now includes one's own graph rows,
through the same fan-out-to-existing-handler pattern `docs/specs/
user-data-deletion.md` already establishes for transcripts and notes.

## 16. Phasing and the epic to file

Seven phases, each a child-issue list with acceptance criteria, filed as
child issues of one epic once this document lands — the same "spec first,
epic and issues after" sequencing `docs/specs/notes.md` (issue #46) and
`docs/specs/transcription.md` (issue #20) already established.

**P1 — Foundation.** Schema and migrations (including the new `pg_trgm`
extension, §10), `GraphAccessService`, the `graph:read`/`graph:write`
permission seed, `kg_*` CRUD, the golden set and eval harness (§6), **and the
definition file, its `core`/`work` module registry, and its parity test**
(§17.1, §17.2, §17.4) — the ontology-as-code foundation everything else in
this phasing reads from, built here rather than retrofitted once types
already have rows depending on them. *Acceptance:* the eval script runs
against the 30-meeting fixture set and prints per-type precision/recall with
no extraction pipeline behind it yet — proving the measurement tooling
exists before the thing it measures does.

**P2 — Extraction, proposal, "Send to graph."** The `generateStructured`/
`chat` `AiProvider` capabilities and task-model resolution (§20 — foundation
work `kg.extract` cannot run without), `kg.extract` (§6), the proposal API
and review panel including guide-the-graph, row-level overrides, "Add to
graph" from a selection, and revert-commit (§8, §19), the commit transaction
with the no-orphan invariant enforced and tested (§3.3), the speaker-naming
write via `kg.speaker_link` (§8's named exception, §11), and the Home
"Waiting for review" card (§19.5). *Acceptance:* a real note produces a
proposal, a reviewer can accept/edit/reject/re-type/re-link each row, add a
missed fact from a text selection, commit, revert that commit, and a commit
leaves no accepted/edited row without at least one evidence citation.

**P3 — Resolution and dedup.** Candidate generation, scoring, LLM
adjudication, aliases, distinct pairs, merges and reversal, work-item
dedup, the `Knowledge graph` settings card (§13). *Acceptance:* the same
person named twice across two meetings resolves to one `Person`, a
confirmed-distinct pair is never re-proposed, and a merge can be reversed
losslessly.

**P4 — Claims, digest, brief.** `occurred_at` handling end to end (§5.4),
`kg.entity_digest` (§9.2), the brief endpoint with mandatory citations
(§9.1), "since I last looked" (§9.2), and `kg.graph_layout` — the job that
precomputes the whole-graph overview's clusters and positions (§22.3), built
here because it depends on nothing P5 adds and the overview it feeds has no
reason to wait for the rest of P5's web work. *Acceptance:* the entity brief
for a seeded fixture entity names every fact it states with a working
citation down to a segment or note span, and `kg.graph_layout` produces a
stored snapshot for a seeded fixture graph.

**P5 — Views, tools, feedback loops, Ask.** The entity page, the sigma.js +
graphology neighbourhood view and the explorer (§22.1, §22.2), the whole-
graph overview UI reading P4's precomputed snapshot (§22.3), the timeline,
the agent toolset (§9.3) built out as Ask — conversations, `ask.respond`,
its SSE stream, the `/ask` page and the entity-page Ask panel (§21) — the
keyterms/name-check/prompt feedback loops (§14), and the Danger Zone graph
and Ask scopes (§15, §21.6). *Acceptance:* a user can open an entity from a
transcript's speaker list, see its brief, drill from the whole-graph overview
into the explorer, ask Ask a cited question about that entity, and see a
subsequent transcript's keyterms include names drawn from the graph.

**P6 — Personal domain.** The `personal` module (§17.2: `SPOUSE_OF`,
`PARENT_OF`, `FRIEND_OF`, `Interest`, `Trip`, `Milestone`), the domain-toggle
setting on the `Knowledge graph` settings card (§13), and the
`sensitivity: personal` default every `personal`-domain type carries so §15
applies to it automatically from the moment the domain is turned on.
*Acceptance:* a user who enables `personal` sees its types offered by
extraction on their next note; a user who never enables it sees no change
anywhere, including in the effective-schema payload §17.4 publishes.

**P7 — Interoperability.** The RDF/OWL and SHACL generators (§18.1, §18.2),
`kg.export` and its three artefacts, `kg.import` and its validate-then-propose
pipeline (§18.3), and the CI check running the SHACL engine against a fixture
export. *Acceptance:* a fixture user's graph exports as valid JSON-LD and
Turtle that validates against the ontology's own generated SHACL shapes, and
that same export re-imported into a second fixture account produces a
proposal that, once accepted, reproduces the original graph's entities and
relations (not necessarily its ids).

Each phase is expected to break into 4–8 child issues at filing time, one
line each with its own acceptance criterion, following the existing
epic-authoring convention this codebase already uses (see epic #45's own
child-issue breakdown for the pattern).

## 17. Ontology definition, domains and user-defined attributes

### 17.1 The definition file — ontology as code

The ontology is not a fixed set of Prisma enums and a hand-maintained
extraction prompt kept in step with them by discipline alone — it is a single
TypeScript + Zod declaration (issue #350). Sources live at
`packages/shared/src/ontology/`, a new directory inside the existing
`@app/shared` package (`packages/shared/`), compiled with
`npm run build:ontology --workspace=@app/shared` into committed CommonJS +
`.d.ts` at `packages/shared/ontology/` and consumed via the `@app/shared/ontology`
subpath export — because both `apps/api` and `apps/web` already depend on
that package for exactly this reason: the API to validate and extract
against, the web app to render a form from, one declaration shared rather
than two hand-copied ones.
Zod is not a new dependency reached for here — it is already this codebase's
single source of truth for settings (CLAUDE.md's Adding a Setting rule, and
the six-file settings-parity discipline `settings-parity.spec.ts` enforces),
and the same argument that makes it right for a system-settings namespace
makes it right here: one declaration yields runtime validation of a `props`
object, a JSON Schema for the extraction prompt's structured-output mode,
TypeScript types the API and web share without a second hand-copied
interface, and the `GET /api/graph/ontology` (§12) payload the UI builds a
form from — the same "one registry entry, several consumers" principle
`docs/specs/transcription.md`'s exporter registry and this codebase's job
handler registry both already follow, applied to type definitions instead of
export formats or job types.

**Shape**, following `defineEntityType`/`defineRelationType` factories:

```ts
defineEntityType({
  key: 'Person',              // permanent once rows exist — see below,
                               // same discipline Job.type already carries
  domain: 'core',              // §17.2
  label: 'Person',
  description: 'A human being...',   // used verbatim in the extraction prompt
  disambiguation: ['Never a role...', 'Never a team...'],
  attributes: {
    title: {
      kind: 'text',
      required: false,
      extractable: true,
      description: "The person's job title, if stated",
      sensitivity: 'business',
    },
    // ...
  },
  sensitivityDefault: 'business',
  alignment: 'schema:Person',  // §18
});

defineRelationType({
  key: 'WORKS_FOR',
  domain: 'work',
  from: ['Person'],
  to: ['Organization'],
  temporal: true,
  exclusive: 'soft',            // 'soft' | 'none' — §5.4's overlap tolerance,
                                 // as a declared property of the type rather
                                 // than a hardcoded list the closing rule
                                 // has to know about separately
  props: { /* none for WORKS_FOR */ },
  alignment: 'schema:worksFor', // §18
});
```

**Closed by default.** A `props` object may carry only keys declared by the
type itself or by the caller's own attribute registry (§17.3); an undeclared
key is a validation error, not a warning and not a silently-dropped field.
This is what actually keeps the extractor from inventing structure: a model
asked for structured output against an *open* schema will, over enough runs,
propose a field nobody declared because it seemed useful in the moment — the
same "an escape hatch a model can reach for is one it will reach for"
argument §5.2 makes against `RELATED_TO` applies identically here to an
undeclared property.

**A `key` is permanent once rows exist**, the identical discipline
`Job.type` already carries in this codebase (CLAUDE.md's Adding a Job Type
recipe): renaming `WORKS_FOR` after real relations of that type exist would
either orphan every existing row's `type` string or require a data migration
indistinguishable from adding a new type and retiring the old one — §17.4
states the retirement path (deprecate, never delete) this constraint forces.

**Credit and deliberate non-adoption.** Two prior systems' ideas are taken
here, and named because pretending this shape was invented from nothing would
misattribute the actual design work: **LinkML** contributes the shape of the
declaration itself — typed classes, reusable slots, `is_a` inheritance,
mixins, `imports`, and critically the **closed-by-default** class semantics
this section adopts outright. **Graphiti** contributes the entity/edge-type
pattern specifically for LLM extraction — Pydantic-typed entity and edge
definitions, an `edge_type_map` restricting which relation types are valid
between which entity types (the direct model for `from`/`to` above),
protected field names, and the operating principle "add attributes without
breaking existing nodes; a genuinely new type needs re-ingestion" that
directly motivates §17.4's versioning rules. **LinkML itself is not
adopted as a dependency** — it is a Python toolchain, and this codebase is
TypeScript end to end (CLAUDE.md's Technology Stack); the ideas worth taking
(closed classes, slots, mixins) cost nothing to reimplement in Zod, while the
toolchain itself would be a second language's build step wired into a
Node/TypeScript monorepo for no capability this document's design actually
needs from it.

### 17.2 Domains as modules

The definition file is not one flat list of types — it is modules listed
**explicitly** in `index.ts`, never self-registered by import side effect
(issue #350): `@app/shared` is a CommonJS package pre-bundled by Vite and
`require()`d by Jest, and registration order under those two module systems
is not something to depend on. `index.ts` imports each domain module and
passes it to `buildOntologyRegistry([coreDomain, workDomain, ...], ...)`
directly — one import and one array entry is the whole cost of adding a
domain, with the same "one registry entry" simplicity CLAUDE.md's Adding a
Job Type and Adding a Notification recipes give their own registries, just
without the runtime self-registration mechanism those use:

- **`core.ts`** — `Person`, `Organization`, `Meeting`, `Claim`, `PersonFact`,
  plus the evidence/review/temporal machinery (§5.3–§5.5) every other domain
  depends on. **Always on**, for every user, unconditionally.
- **`work.ts`** — `Project`, `Commitment`, `Decision`, and the relation types
  `WORKS_FOR`, `HAS_ROLE`, `REPORTS_TO`, `ATTENDED`. **On by default.**
- **`personal.ts`** — `SPOUSE_OF`, `PARENT_OF`, `FRIEND_OF`, `Interest`,
  `Trip`, `Milestone`. **Off by default**, a later phase (§16, P6), not yet
  built.
- **`index.ts`** — the registry: lists every domain module explicitly and
  builds it via `buildOntologyRegistry`, and a user's **effective schema** is
  computed as `core ∪ {enabled domains}` — never hand-assembled per caller.

**Why `Person` and `Organization` are `core` rather than `work`, specifically
— this is the reason to design domains at all rather than ship one flat
list.** A person exists whether or not `work` is ever enabled; putting
`Person` in `work` would mean the identical human Joe becomes two different,
unrelated rows depending on which domain proposed him — one from a
`work`-domain `WORKS_FOR` edge, a second from a `personal`-domain
`SPOUSE_OF` edge — with nothing to say they are the same Joe. Keeping
`Person`/`Organization` in `core` and letting `work` and `personal` each add
*relations* onto them (and, via a mixin, *attributes* onto them) is what
guarantees one Joe across every domain a user ever turns on.

**Rules:**

- A user enables a domain in the `Knowledge graph` settings card (§13); the
  extraction prompt (§6) includes only the types and relations from `core`
  plus the user's currently-enabled domains — a disabled domain's types are
  not merely hidden in the UI, they are never sent to the model at all,
  which is what keeps a `personal.ts` `Interest` from ever being proposed for
  a user who never turned that domain on.
- A domain may add attributes to a `core` type via a **mixin**, namespaced by
  domain, rather than editing `core.ts` itself — `work` adding a `title`
  attribute to `Person`, say, lives declared in `work.ts` and is merged onto
  `Person`'s effective attribute set only when `work` is enabled, so `core.ts`
  never has to know what any domain built on top of it chooses to add.
- Every `personal`-domain type defaults to `sensitivity: 'personal'` (§5.6),
  so §15's privacy handling — never pre-checked, opt-in for prompt
  enrichment — applies automatically the moment the domain is turned on,
  with no second setting a user has to separately remember to configure.

### 17.3 User-defined attributes

A user can add an attribute to an entity type with **no code change and no
migration** — the same promise the settings-hub registry and the job/exporter
registries make on their own axes, extended here to the ontology's own
shape.

**Storage: JSONB `props`, not an EAV table.** The alternative — a generic
`(entity_id, attribute_key, value)` rows-as-columns table — was rejected on
the same grounds the wider industry has settled on for this exact tradeoff:
JSONB is indexable (GIN, or a targeted expression index on a hot key), its
read/write performance is on par with typed columns at this codebase's
scale, and it avoids EAV's characteristic failure mode of slow, deeply
self-joined queries once an entity accumulates more than a handful of
dynamic attributes. The one caveat every JSONB-over-EAV comparison names —
JSONB has no schema of its own to validate against — is handled in the API
layer, against a definition row, exactly as `props`' closed-by-default
validation (§17.1) already handles it for built-in attributes; user-defined
attributes are validated by the identical mechanism, not a second one.

**Model: Notion's property model**, per user, per entity type — a stable id
that survives a label rename (so a report or a saved view built against
"Nickname" keeps working after someone renames the column to "Preferred
Name"), a `kind` drawn from a fixed list, and per-kind options (a `select`'s
choices, say). New table:

```
kg_attribute_defs (
  id, owner_id, entity_type, key, label, kind, options jsonb,
  extractable, extraction_hint, sensitivity, sort_order, deprecated_at
)
```

`kind ∈ text | number | date | boolean | select | multi_select | url |
entity_ref`. **Values are keyed by definition id, never by label** — the
same "stable id, renameable label" property that makes a rename safe in
Notion's model makes it safe here.

**`extractable: true` plus a hint is what makes extraction ask for it.** The
worked example: a user adds a "Nickname" attribute to `Person` with
`extraction_hint: "how this person is addressed informally, e.g. by
teammates"`; the next `kg.extract` run over a transcript where everyone
calls someone "JJ" fills it in as an ordinary proposal row, reviewed exactly
like any built-in attribute — a user-defined attribute is not a second-class
citizen of the extraction pipeline, it is a field the effective schema (§17.4)
handed the model like any other.

**`entity_ref` is a light link, not a relation type.** It lets a
user-defined attribute point at another entity (a `Person`'s "Assistant,"
say) without going through §5.2's fixed relation-type list and its
`from`/`to` endpoint typing — appropriate for a genuinely per-user,
lightweight cross-reference, and deliberately not a way to sneak a new
relation *type* past the constraint below.

**Deprecate, never delete.** A `deprecated_at` timestamp hides an attribute
from new proposals and new forms without invalidating rows that already
carry a value under its id — deleting the definition instead would leave
existing `props` values keyed by an id nothing can any longer render a label
for.

**Users do not get new entity types in v1, and user-defined relation types
are v2 under the same constraint.** A genuinely new *type* — as opposed to a
new attribute on an existing type — needs a prompt description precise
enough for consistent extraction, a disambiguation rule against its nearest
neighbour (§5.1's own discipline), evidence rules, and a place in the golden
eval set (§6) before it can be trusted at all; none of that is something a
settings-form text field can produce, and shipping user-defined entity types
without it would reintroduce exactly the blurry-boundary failure §3.5's
"Rejected alternatives" documents for the v0.2 draft's 44-type catalogue,
except invented per-user instead of once centrally. Attributes on an
*existing*, already-disambiguated type carry none of that risk, which is the
line this document draws for v1.

### 17.4 Versioning and maintenance

**Semver on the definition file.** Every graph row — `kg_entities`,
`kg_relations`, `kg_items` — carries the `ontology_version` it was written
against (a v0.2 idea kept, per this document's own opening credit to that
draft). **Major** means a type's *meaning* changed (a redefinition an old
row can no longer be assumed to satisfy); **minor** means a type or attribute
was *added*; **patch** means only descriptions or extraction hints changed —
text a model reads, never a structural change a stored row depends on. A key
is permanent once rows exist (§17.1); deprecate before delete, always.

**Maintenance discipline.** A `CHANGELOG` lives in the definition file
itself, and a parity test in the style of `settings-parity.spec.ts`
(CLAUDE.md's Database Tables section) checks the properties that keep the
file internally honest: every type has a description, every relation
declares its endpoint types, every attribute declares a `kind`, and no key
that ever shipped is ever removed from the file (only deprecated).

**Reshaping is a job, never a migration.** When the ontology changes in a
way that requires touching existing rows — a type is deprecated and its rows
need re-tagging, an attribute's `kind` is corrected — that reshape runs as
`kg.migrate` (§11), a resumable job visible in the admin job list like any
other, operating **per user, per row**, never as a `prisma migrate` step.
This is deliberate and structural, not a style preference: the physical
`kg_*` tables do not change shape when the ontology changes — `props` is
JSONB either way — so there is no schema migration to write in the first
place, and enabling `personal` for the fleet, say, is a deploy of the
definition file, not a database migration at all. Treating an ontology bump
as a Prisma migration would be modelling application-level, per-user data as
if it were the physical schema, and would additionally spend the *user's*
own AI provider key inside a `migrate deploy` step run on the operator's
behalf, precisely the objection CLAUDE.md's `note.retitle` entry (⚠ "a job
and deliberately not a migration") already raises for a different feature
facing the identical shape of mistake.

**`GET /api/graph/ontology`** (§12) publishes the caller's own effective
schema — `core` plus their enabled domains plus their own
`kg_attribute_defs` rows — and every form this feature ships is generated
from that one payload: the proposal panel (§8), the entity page's edit form
(§13), and the `Knowledge graph` settings card's own type/attribute browser.
There is no hand-coded form per entity type anywhere in `apps/web` — a form
for a type that does not yet exist when this section is written renders
correctly the day that type is added to the definition file, with zero web
changes, because it was never coded against a fixed list of types to begin
with.

## 18. Interoperability: RDF, JSON-LD and SHACL

### 18.1 Mapping

The definition file's `alignment` field (§17.1, §2) is what makes an export
possible without a second, hand-maintained mapping: every entity type, every
built-in attribute, and every relation type already names its standard-
vocabulary counterpart, and §18.2's generators read that field directly.

| kvox concept | RDF/OWL counterpart | Notes |
|---|---|---|
| Entity type | `rdfs:Class`, aligned via `alignment` | `schema:Person`, `schema:Organization` |
| Built-in attribute | `owl:DatatypeProperty`, with `rdfs:domain`/`rdfs:range` | Aligned where a standard property exists — `schema:jobTitle`, `schema:email` — and left as a `kv:`-namespaced property (§18.2) where none does |
| Relation type | `owl:ObjectProperty` | `schema:worksFor` for `WORKS_FOR`, and so on |
| A temporal edge (§5.4) | A per-edge reified node carrying `prov:startedAtTime`/`prov:endedAtTime`, or RDF-star (`<< :joe :worksFor :acme >> :validFrom "2019"`) where the consumer supports it | The choice is the consumer's, not the exporter's — both forms are emitted from the identical `valid`/`valid_precision` pair (§5.4, §10), never two separately maintained representations |
| Evidence (§5.3) | `prov:wasDerivedFrom` a segment or note-span IRI, plus an `oa:Annotation` carrying an `oa:TextPositionSelector` (the `char_start`/`char_end` range) and an `oa:FragmentSelector` (`t=102,118`, the `start_ms`/`end_ms` range) | The no-orphans invariant (§3.3) restated as two standard selector shapes rather than kvox-specific columns |
| Review status, confidence, `ontology_version` | `kv:` annotation properties | No standard vocabulary states an opinion about review workflow or a source ontology's version, so these stay in kvox's own namespace rather than being force-fit onto a property that means something narrower |
| User-defined attribute (§17.3) | `kv:attr/<def-id>`, `rdfs:label` set to the definition's own `label` | The definition id, not the label, is the stable part — identical to how `props` itself is keyed (§17.3) |
| Sensitivity (§5.6) | An export **filter**, not a shape | `sensitive` is never exported, under any setting — the same absolute rule §5.6 and §15 already state, restated here as an export-time behaviour rather than a SHACL constraint, because a constraint can be satisfied by omission just as well and a filter is the more honest way to say "this never leaves" |

IRIs follow §2's namespace pattern (`kv:` / `https://kvox.app/ns#`); every
`kg_*` row's own stable UUID becomes the IRI's local part, which is what
makes a round-trip (export, then re-import elsewhere, §18.3) lossless on
identity rather than merely on content.

### 18.2 Export — three artefacts from one source

Because all three are generated from the same definition file rather than
hand-authored beside it, they cannot drift from each other or from the live
schema the way three independently maintained documents could.

1. **The ontology** — `GET /api/graph/ontology.ttl`: OWL/RDFS generated
   directly from the definition file (§17.1), `owl:versionInfo` set to the
   file's own semver (§17.4).
2. **The shapes** — `ontology.shacl.ttl`: one `sh:NodeShape` per type,
   generated from the identical Zod declarations §18.1's mapping table
   reads — a `required` attribute becomes `sh:minCount 1`, a `select`'s
   options become `sh:in`, a relation's declared endpoint types become
   `sh:class`, an `email`-formatted field becomes `sh:pattern` — plus one
   shape per caller generated from their own `kg_attribute_defs` rows, and a
   shape requiring **at least one `prov:wasDerivedFrom`** on every node: the
   no-orphans rule (§3.3), expressed as a SHACL constraint an external
   validator can check without knowing anything about kvox's own
   `kg_evidence` table.
3. **The data** — `GET /api/graph/export?format=jsonld|turtle|nquads`:
   owner-scoped, `accepted`/`edited` rows only (an `unreviewed` or `rejected`
   row is not knowledge kvox stands behind, and §5.5 already keeps it out of
   every other read path this document defines), `sensitive` excluded
   (§18.1), with a JSON-LD `@context` mapping every `kv:` key to its aligned
   standard vocabulary. This runs as **`kg.export`** (§11), a queue job like
   `note.export`, producing a 7-day signed download exactly as
   `docs/specs/notes.md` §8 already establishes for a note's own exports.

**Because the shapes and the data are generated from the same definitions,
an export validates against its own shapes by construction** — there is no
way for the generator to produce data that violates a shape it also
produces, short of a bug in the shared generation code itself, and CI runs
the SHACL engine (§18.4) over a fixture export on every change specifically
to catch that one remaining failure mode: generator drift between the two
artefacts, not a design that could disagree with itself by intent.

### 18.3 Import — where SHACL earns its keep

Importing is the one direction where an external file cannot be trusted the
way this document's own extraction pipeline can, and the design reflects
that asymmetry at every step:

**Validate first.** The incoming Turtle/JSON-LD is checked against the
*current* SHACL shapes (§18.2) before anything else happens; the validation
report is what the user sees, and nothing invalid ever lands — an import
that fails validation fails all of it, not row by row.

**Everything imported is a proposal.** A validated import becomes a
`kg_proposals` row of kind `import` (§8), running through the identical §7
resolution pipeline as an extraction proposal — an imported "Joe Smith"
resolves against the graph's existing Joe exactly as a newly extracted
mention would — and committing only through the same "Send to graph" action
(§8). §8's rule that nothing else writes to the graph holds for imports too,
without a carve-out: an import is powerful precisely because it is *not* a
third way in.

**Evidence for an import is the import itself.** `kg_evidence.subject_kind`
(§5.3, §10) gains a fourth value, `'import'`, pointing at the stored source
file and the source IRI — the identical "content is evidence" principle
§3.1 states for a transcript or a note, applied to an external RDF document
instead. There is no exemption from §3.3's no-orphans rule for imported
rows; an imported fact is cited to its file exactly as a `kg.extract`
proposal is cited to a segment.

**Unknown properties are offered, not silently kept.** A property in the
incoming data with no counterpart in the effective schema is offered to the
importing user as a candidate `kg_attribute_defs` entry (§17.3) to create,
or rejected outright — never silently accepted, per §17.1's closed-by-default
rule holding for an import exactly as it holds for extraction.

**Version negotiation.** `owl:versionInfo` (§18.2) on the incoming
ontology's own export makes this checkable rather than assumed: a `1.x`
import into a `1.y` deployment applies directly; a `2.x` import against an
older deployment requires `kg.migrate` (§17.4, §11) to run first, because a
major version means a type's *meaning* changed and importing straight past
that would silently misinterpret the incoming data under the wrong
definition.

**Use cases**, stated concretely because "interoperability" alone
undersells what this unlocks: moving a graph between two of a user's own
kvox deployments; a backup of one's connected knowledge that is not a
Postgres dump and can be inspected or partially restored with ordinary RDF
tooling; handing a client an export of the meetings concerning them; and
importing a contacts or CRM export as a starting set of `Person` and
`Organization` rows rather than building a graph from zero meetings.

### 18.4 Tooling

`n3` (RDF/Turtle parsing and serialization), `jsonld` (JSON-LD processing),
`rdf-validate-shacl` (the SHACL engine §18.2 and §18.3 both depend on), and
optionally `@comunica/query-sparql` for a future read-only SPARQL surface
over an exported graph. All four are used **only by the export/import job
handlers** (`kg.export`, `kg.import`) — never in the API's ordinary request
path, and never as a dependency of anything §9's retrieval design touches,
because §1's non-goals already rule out any endpoint accepting or generating
a query language from a model or a user, and pulling a SPARQL engine into
the request path would be the first step toward exactly that.

## 19. Review UI and overrides

§8 established the commit gate; this section is everything a reviewer can
*do* before that gate, and the one thing they can undo after it. Nothing
here opens a second write path into the graph — every action below still
lands as a `kg_proposal_items` row decision or, for a revert, as an explicit
reversal of a specific committed row; §8's "nothing else writes to the
graph" rule holds unchanged.

### 19.1 Guide the graph, before extraction runs

A reviewer is not limited to reacting to whatever `kg.extract` (§6) proposed
— `POST /api/graph/notes/:noteId/extract` accepts an optional `userGuidance`
object, persisted onto the resulting `kg_proposals.user_guidance` (§10) and
read by the prompt builder (`buildExtractionContext`, §6) on this run:
**pinned entities** (force specific known-entities-list rows to the top
regardless of recency, for a meeting about someone the recency heuristic
would otherwise miss), a **type selection** (narrow this run to a subset of
the caller's effective schema — useful for "just re-check Commitments"
without re-litigating everything else), and **free-text instructions**
appended verbatim to the extraction prompt, the identical "an extra
paragraph the model reads, never a second code path" shape
`docs/specs/notes.md` §3.1's own Context field already takes for generation.
Guidance is never itself evidence — it steers what the model looks for, and
every row it helps produce still needs its own citation (§5.3) exactly like
any other proposed row.

### 19.2 Row-level overrides in the review panel

Every proposed row supports six actions beyond the plain accept/reject §8
already describes, each recorded as the item's `decision`/`edited_payload`/
`flags` (§10):

- **Edit**, including **changing the proposed type** — a row the model
  proposed as a `Claim` can be re-typed to a `PersonFact` (or the reverse)
  before acceptance, validated against the caller's effective schema
  (§17.4) exactly as a freshly-proposed row of that type would be; changing
  a *relation's* type re-validates its endpoints against the new type's
  declared `from`/`to` (§17.1) and is refused, inline, if they no longer fit.
- **Re-link** — replace §7's proposed entity match with a different one
  (search the caller's own graph), for the case where automatic resolution
  picked a plausible but wrong "Sarah."
- **Evidence add/remove** — a reviewer who read further in the transcript
  than the model's own cited range can attach another segment or note span
  as additional support, or remove a citation that does not actually say
  what the model claimed; the no-orphans invariant (§3.3) still applies at
  commit time, so removing a row's last remaining evidence line without
  adding another blocks that row's commit rather than silently committing an
  unsupported one.
- **Reject** — unchanged from §8, still kept and suppressed by statement
  hash (§7) rather than deleted.
- **Group actions** — `POST /api/graph/proposals/:id/items/bulk` applies one
  decision (`accept | reject`) to a set of `itemIds` in one call, for the
  ordinary case of clearing a whole type's worth of confidently-correct rows
  in one tap rather than one row at a time; a bulk `accept` still respects
  §8's `PersonFact` pre-check exclusion — a `PersonFact` row is never swept
  into a bulk accept, even when explicitly selected, without a distinct
  confirmation naming that it is about to expose a personal fact.
- **Add a missing item from a text selection** — §19.3, below.

### 19.3 "Add to graph" from a text selection

A reviewer reading the note or the transcript can select a span of text the
model missed entirely and turn it directly into a proposal row: `POST
/api/graph/proposals/:id/items` with the selection's `{ noteId, noteVersion,
charStart, charEnd }` (or the transcript equivalent, `{ transcriptId,
segmentId, segmentRev, startMs, endMs }`) and the entity/relation/item the
reviewer typed. **The selection itself becomes the row's evidence** — there
is no separate "now find a citation" step, because the reviewer's own act of
selecting the text *is* the citation, the identical "the review step and the
evidence step are the same click" economy §4's speaker-naming moment already
gets for free. The resulting row's `origin` is `user` (§10) — it never
counts toward `kg.extract`'s own precision/recall accounting (§6's eval
harness), for the same reason a human's typed correction is never scored as
a model error: this row was never proposed by the model to get wrong in the
first place.

### 19.4 Reverting a commit

`POST /api/graph/proposals/:id/revert` undoes exactly what that proposal's
commit did, and no more. Every `kg_proposal_items` row committed by this
proposal carries `committed_ref_id` (§10) — the exact
`kg_entities`/`kg_relations`/`kg_items` row it became — and revert walks
that list: a row **untouched since commit** (no edit, no new evidence, no
merge, no superseding fact recorded against it) is deleted outright, or, for
a relation that closed an earlier edge (§5.4's closing rule), the closed
edge is reopened; a row that **has** been touched since — a later proposal
added evidence to it, a merge folded another entity into it, a newer fact
superseded it — is left alone and named in the response's `untouched: false`
list, because undoing it here would silently discard work a later,
independent review step performed in good faith. A revert that could not
fully undo its commit is not a partial failure — it is reported as exactly
that, a proposal `status: reverted` (§10) whose `stats` records what came
back and what could not, so a reviewer sees the honest boundary of what
"undo" means once other work has happened downstream. Revert is audited as
`graph.proposal_reverted`.

### 19.5 Where review surfaces before a reviewer opens the note

`HomePage.tsx`'s (verified above) new **Knowledge** section carries a
**"Waiting for review"** card — every `draft` proposal the caller owns, most
recent first, each opening straight into that note's review panel — so a
proposal produced automatically the moment a note reaches `ready` (§6) does
not require a reviewer to remember which note it was attached to and go find
it. A proposal with no reviewer action taken is not chased by a notification
— reviewing one's own extraction is a pull action a user reaches for on
their own schedule, the same posture `docs/specs/notes.md` gives its own
`titleSource: template` sweep rather than nagging a user every time a note
finishes generating.

### 19.6 Phone layout

The review panel is a right-anchored side sheet at `sm` and above (§13); on
phone it takes the bottom-sheet-or-full-screen shape `NameSuggestionsPanel.tsx`
(verified above) already establishes for a page-level review surface — a
`Drawer` from the bottom for a short list of pending rows, promoted to a
full-screen route when a proposal is large enough that a partial-height
sheet would make scanning it worse than not showing it at all. This is the
page-level `down('sm')` read `LibraryPageFrame.tsx` already takes (CLAUDE.md's
Settings UI Pattern rule 5's own footnote) — a layout choice inside one page,
never a sixth breakpoint gate on app chrome.

## 20. Task models

Every AI-calling job type this document defines — `kg.extract`, `kg.resolve`'s
adjudication step, `kg.entity_digest`, and `ask.respond` (§21) — needs a
model, and none of them should
share `NoteGenerationRequestService.resolveModel()`'s notion of "the" model,
because a deployment reasonably wants a cheap, fast model doing bulk
extraction and a stronger one composing a brief a person actually reads, and
a user reasonably wants to override either with their own choice on their
own key. This section is the one place that policy is decided, read by every
call site above rather than several independent `resolveModel`-style
implementations drifting apart the way `note-generation-request.service.ts`
and `transcript-name-check.service.ts`'s own `resolveAi()` (verified above)
already have from each other.

### 20.1 The setting

`ai.taskModels: Partial<Record<TaskKey, { model: string; reasoningEffort?:
'low'|'medium'|'high' }>>` — a new field on the existing `ai` system-settings
namespace (CLAUDE.md's Database Tables section), following the identical
six-place settings-parity discipline every other `ai` field already follows
(verified above). `TaskKey` is `'graph.extract' | 'graph.adjudicate' |
'graph.digest' | 'graph.agent'` — one key per AI-calling *shape* this
design has, not one per job type, because `kg.resolve`'s
LLM-adjudication step (§7) and `kg.entity_digest` (§9.2) are different
shapes of call even though a deployment might reasonably point them at the
same model. A task with no entry falls back to `ai.defaultModel` (the
existing field), so enabling connected knowledge for the first time needs
zero new configuration to work at all — `ai.taskModels` is where an
administrator narrows the default per task, never a required setup step.

A second new field, `ai.graphEnabled: boolean`, default **`false`** —
connected knowledge is off for a fresh deployment until an administrator
turns it on, the identical "off by default until configured" posture
`nodes.jobSecretBrokerEnabled` and `databaseBackup.nodeOffloadEnabled`
(CLAUDE.md's Environment Variables section) already establish for a feature
with a real blast radius: turning this on is the moment every eligible note
starts spending the *owning user's own* AI provider credit on an extraction
they did not explicitly request per-note. `kg.extract` is never enqueued
while `ai.graphEnabled` is `false` (409 `graph_disabled`, §12).

There is deliberately no `graph.brief` task. The entity brief never calls a
model in a request: every AI call in this design runs in a queue job, and the
brief's prose is `kg.entity_digest`'s own output, shown as-is (§9.1). A
`graph.brief` task key would name a call that does not exist.

### 20.2 Capability flags

`generateStructured` (§6) and the tool-calling loop `ask.respond` needs
(§21) are both new `AiProvider` capabilities this epic adds to
`apps/api/src/ai/providers/ai-provider.interface.ts` — OpenAI's Chat
Completions path this codebase uses today (verified above: no tool calling,
no `json_schema` mode) gains `generateStructured(ctx, req)` using
`response_format: {type: 'json_schema', json_schema: {name, strict: true,
schema}}`, and `chat(ctx, req)` returning an `AsyncIterable` of
delta/tool-call/done events for the agent loop. Every model descriptor a
provider reports (`AiProvider.listModels`/`deriveModelDescriptor`, verified
above) carries two new boolean flags, `structuredOutput` and `toolCalling`,
alongside its existing context-window/output-ceiling numbers
(`ai-model-resolution.ts`'s five-rank chain, CLAUDE.md's `ai` namespace
entry) — a model with `structuredOutput: false` is not offered for
`graph.extract`/`graph.adjudicate`/`graph.digest`, and one with
`toolCalling: false` is not offered for `graph.agent`, at both save time
(§20.4) and resolution time (§20.3), so an unusable pairing is
unrepresentable rather than merely discouraged.

### 20.3 Resolution and the user override

`AiTaskModelResolver.resolve(userId, task, requested?)` (planned:
`apps/api/src/ai/ai-task-model-resolver.service.ts`) is the one function
every AI-calling call site in this feature calls, extracted from
`NoteGenerationRequestService.resolveModel()`'s own shape (verified above)
rather than reimplemented per call site: it resolves `ai.taskModels[task]`
(or `ai.defaultModel`) to a concrete `{ providerId, model, reasoningEffort,
countTokens }`, the same 409 `ai_not_configured`/`ai_key_missing` semantics
`resolveModel` already gives. When `requested` names a model the calling
user's own allow-list permits (the existing `allowedModels` mechanism,
unchanged by this epic), that model is used instead of the admin's per-task
default — **the user's own key pays for it either way**, so an override
changes which model runs, never who is billed. A `requested` model lacking
the capability the task needs (`structuredOutput` for the three
extraction/adjudication/digest tasks, `toolCalling` for `graph.agent`)
is refused with 409 `model_lacks_capability` (§12) rather than silently
falling back to the admin default — a silent fallback would mean a user who
explicitly asked for a specific model never learns their choice was ignored.

**Recorded, not just applied.** Every proposal (`kg_proposals.model`/
`.provider`, §10) and every agent turn (`ask_messages.model`/`.provider`,
§10) records exactly which model actually ran it — never re-derived from the
current setting at read time, because an administrator changing the default
tomorrow must not silently rewrite what an already-committed proposal used
yesterday, the identical "record the exchange, don't re-derive it"
discipline `NoteGeneration.systemPrompt`/`userContent` (verified above)
already establishes for generation's own history.

### 20.4 Admin UI

Per §13's own correction, above: two new sections — **Connected knowledge**
(the `graphEnabled` toggle) and **Task models** (one model picker per
`TaskKey`, each showing only models the active provider reports with the
capability that task requires) — are added to the *existing*
`AiSettingsPage.tsx` (`/admin/settings/ai`, verified above), never a new
registry card. Save-time validation runs the identical capability check
§20.3 gives at resolution time, so a deployment can never save a
`graph.agent` entry pointing at a model with no `toolCalling` — the error
surfaces on save, not months later on the first agent turn that tries to use
it.

## 21. Ask — the read-only graph agent

§9.3 named the toolset — `search`, `get_entity`, `neighbors`, `evidence`,
`timeline`, `entity_brief` — as re-exposable "for any future agent-style
consumer of this graph." Ask is that consumer, built now rather than left as
a forward reference: a conversational surface over the caller's own graph
that can take several steps (search, then look at what it found, then check
a timeline) before answering, always citing what it read, and never writing
anything.

### 21.1 Read-only, by construction, not by prompt instruction

**The agent never generates SQL, Cypher, or any other query language, for
the identical reason §1's non-goals and §9.3 already state for the toolset
it calls** — every tool it can invoke resolves to one of the fixed,
parameterized read shapes §12 already defines (a search, a neighbourhood
walk of a bounded depth, a timeline slice, an evidence lookup), so there is
no query surface for a prompt-injected instruction to escape into even in
principle. **It never writes to the graph, under any tool, at any
confidence.** This is the same "the write path itself does not exist"
posture §3.6 takes for extraction's own commit gate, extended here to a
second AI-calling surface: adding a `propose_entity`-shaped tool to the
agent's toolset — even one that only *drafted* a `kg_proposal_items` row for
a human to later review — would make Ask a second, parallel path into the
review pipeline, with its own prompt, its own failure modes, and its own
chance of quietly normalizing "the agent found something, so add it" as a
habit that erodes exactly the deliberate friction §3.6 built the single
commit gate to preserve. Ask answers questions; `kg.extract` and the review
panel (§19) are still the only way anything enters the graph.

### 21.2 Conversations

`ask_conversations` / `ask_messages` (§10) — a saved back-and-forth, listed
and reopened like any other saved item in this application, never ephemeral.
`scope_entity_id` (nullable) records when a conversation was started from an
entity page's Ask panel (§21.5) rather than the standalone `/ask` page, so a
scoped conversation's first turn is pre-seeded with that entity in context
without the user having to name it. `GET/POST/PATCH/DELETE
/api/ask/conversations[/:id]` (§12) are ordinary owner-scoped CRUD, gated on
`graph:read` alone (§12) — there is no `ask:*` permission pair, because a
conversation is the caller's own scratch history over data they can already
read.

### 21.3 One turn, one job

`POST /api/ask/conversations/:id/messages` `{ content, model? }` enqueues
**`ask.respond`** (§11) and returns **202** with both the new user message
and a `pending` assistant message — the identical two-row-per-turn shape a
chat UI needs to render immediately without waiting on the job.
`ask.respond` runs the tool-calling loop (§20.2's `chat()`) against the
resolved `graph.agent` model (§20.3, with the caller's own override honoured
exactly as §20.3 describes), reading prior turns in the conversation as the
message history, calling tools as needed, and writing every delta into
`ask_messages.content` on the way past — **the identical durable-buffer-not-
delivery-mechanism discipline** `note_generations` already establishes
(CLAUDE.md's Notes rule 1): a turn completes identically whether or not the
SSE stream below is open, and closing the tab loses nothing.

**Caps.** A hard **step cap** (a fixed number of tool calls per turn) and a
**token cap** (per turn, drawn from the resolved model's own output ceiling,
§20.2) bound a single turn's cost and latency; a turn that hits either cap
ends with its best answer so far and a `finishReason` the client can render
as "stopped early" rather than pretending the answer is complete. `profile:
{ maxRuntimeMs: 5m, maxAttempts: 1 }` (§11) — one attempt, for the identical
reason `note.generate`/`kg.extract` carry it: a retried turn would silently
re-spend the user's own provider credit to produce a different,
non-deterministic answer to a question whose partial stream the user may
already be reading. Throttled on `aiProviderThrottleKey(userId)` (§11), the
same per-user key every other AI-calling type in this design uses, for the
identical reason: every user brings their own vendor account.

**Citations are validated, not merely requested.** Every claim in an
assistant message names the tool result it came from (an entity id, an
evidence id, an item id); `ask.respond` checks each cited id against the ids
the tools it actually called returned in *this* turn before the message is
marked `complete` — a citation to something never fetched is dropped from
the rendered answer and counted in the message's own stats, the identical
"the model cites what it was given, never invents a new id" discipline §6
already enforces for extraction, applied here to an agent's answer instead
of a proposal.

### 21.4 The stream

`GET /api/ask/messages/:id/stream` — the same `delta | done | error` frame
contract, `Last-Event-ID` resume, and offset-addressed content
`src/notes/generation/note-stream.ts` (verified above) already defines for
`note_generations`, reused rather than reimplemented for the identical
reason §9.4's fusion discipline reuses `reciprocalRankFusion()`: a second,
independently-written SSE frame format for the same "stream durable text as
it is written" problem is a second place the two could quietly disagree
about what "resume from here" means.

### 21.5 Web surfaces

An **`/ask`** page (conversation list, a streaming answer view, citation
chips that open the exact ▶ segment, note span, or entity page a claim came
from, and a model picker honouring §20.3's override) and, on the entity page
(§13), an **Ask panel** pre-scoped to that entity (`scope_entity_id`, §21.2)
for "what does the graph know about Joe, and can I ask it something" without
leaving the page. Both routes — `/ask` and `/ask/:conversationId` — are
owned by the `home` destination exactly as §13 states for the rest of this
epic's routes; there is no new bottom-bar tab for Ask any more than there is
one for the graph itself.

### 21.6 Deletion

Ask's conversations are the caller's own generated content over their own
graph, so the Danger Zone (`docs/specs/user-data-deletion.md`) gains
coverage alongside `transcripts`/`notes`/`files`/the graph: deleting
`content` or `everything` removes the caller's `ask_conversations` (and, by
cascade, their `ask_messages`) — the identical fan-out pattern that
document's scope matrix already uses for every other category, with no new
purge job needed because a plain cascading delete is sufficient here —
unlike a transcript or a note, an Ask conversation has no external storage
object or provider-side state to clean up alongside the row.

## 22. Visualization — explorer and overview

Two views, one underlying graph model, deliberately not one: §13's
neighbourhood widget already answers "everything around this one entity,"
bounded and cheap; this section adds a dedicated **explorer** for navigating
that neighbourhood interactively across more than one entity, and a
**whole-graph overview** for the different question neither the entity page
nor the explorer answers — "what does my *whole* graph look like." Both
resolve the rendering-library decision §5.7 and §13 previously left open.

### 22.1 Library: sigma.js + graphology, chosen here

**sigma.js** (WebGL rendering) **+ graphology** (the graph data structure
and algorithm library both the client and, via
`graphology-communities-louvain`, the server's own `kg.graph_layout` job
use) is the one library choice this document makes rather than defers.
WebGL rendering is what makes the whole-graph overview's node count
tractable at all — an SVG-based renderer redraws every element on every
pan/zoom, which stops being smooth well before this design's own explorer
cap (below); a single graphology graph object, shared between the two views,
is what lets the overview's "drill into the explorer" transition (§22.3)
hand off an already-loaded subgraph instead of re-fetching it.
**react-force-graph and cytoscape**, both named as candidates in an earlier
draft of §5.7/§13, are recorded as rejected in "Rejected alternatives,"
below, rather than left open any further.

### 22.2 Explorer (`/graph/explore`)

Seeded from an entity page, a search result, or a bare visit to
`/graph/explore` itself (in which case it seeds from the caller's
most-recently-viewed entities, `kg_entity_views`, §9.2); **expand-on-click**
grows the visible graph one hop at a time from `POST /api/graph/explore/expand`
(§12) rather than ever fetching the whole graph up front, so a click always
costs one bounded request instead of the client silently downloading more of
the graph than the screen can usefully show. Filters — **entity/relation
type**, **domain** (§17.2 — hiding `personal`-domain rows for a user who has
that domain enabled but does not want it cluttering this particular view),
and an **`as_of` slider** (§9.1 — rendering the graph as it stood on a past
date, reusing the identical range-containment query the entity brief already
runs) — narrow what expansion is allowed to add, not merely what is
displayed, so a filtered-out type is never fetched at all. **A hard
300-node cap** — past it, expansion is refused with a message naming the cap
rather than silently degrading into an unreadable hairball or a frozen tab;
300 is chosen against sigma.js's own practical WebGL ceiling for a
force-directed layout that still redraws smoothly on an ordinary laptop, not
against any property of this design's own graph size, which §3.5's "shallow
by construction" scope means rarely approaches it during ordinary use.

### 22.3 Whole-graph overview (`/graph/overview`)

**Never computed client-side, and never client-side even in principle.** A
force-directed layout of an entire graph is $O(n^2)$-ish per frame and a
client cannot be trusted to have a machine capable of running it smoothly
the moment the graph crosses a few hundred nodes — exactly the "300-node
cap" reasoning above, but for a view whose entire purpose is showing
*everything*, which is precisely the case a client-side layout cannot
gracefully degrade out of. `kg.graph_layout` (§11) instead runs graphology's
Louvain community detection plus a force-directed layout **on the server**,
once, and writes the result — `clusters` (which community each node belongs
to) and `positions` (precomputed 2D coordinates) — to `kg_graph_layouts`
(§10); `GET /api/graph/overview` (§12) always reads the latest stored
snapshot, never recomputes at request time, the identical "precompute once,
read cheaply forever" economy `kg_entity_digests` (§9.2) already gives the
entity brief. `POST /api/graph/overview/refresh` (§12, `graph:write`) lets a
user ask for a fresh snapshot after a large commit changes the shape of
their graph enough to be worth re-clustering; it is never triggered
automatically on every commit, because a whole-graph re-layout is not the
kind of work that should run on every note a user finishes reviewing.

The overview itself renders clusters as the zoomed-out unit — a cluster's
size and label (its most central entities) rather than every individual
node at once — and **drilling into a cluster hands its member node ids
straight to the explorer** (§22.2) as its seed set, so the transition from
"here's the shape of my whole graph" to "let me look closely at this part of
it" is one click, sharing the same graphology graph object (§22.1) rather
than a second fetch.

### 22.4 What neither view ever does

Consistent with §9.4: neither the explorer nor the overview is ever the
thing a retrieval feature reads *from* — both are read-only navigation
surfaces over the same `GET /api/graph/...` endpoints §9 and §12 already
define, and neither renders `sensitive`-classified rows any differently
than the entity page already does not (§5.6's "never pre-checked" and §15's
"never leaves" apply identically to a node drawn on a canvas as to a fact
printed in a brief).

## Rejected alternatives

- **A Neo4j (or other graph-database) projection beside PostgreSQL.**
  Rejected per §3.2: a second store means sync invariants to hold (the v0.2
  draft's own §9.1 spent thirty lines specifying the no-orphans cascade and
  its projection-time fallback, plus a one-time backfill migration to heal a
  case where it briefly didn't), a second access-control surface to keep
  404-never-403 correct on, and a second backup/restore story. Named,
  concrete re-open triggers, none of which this product's roadmap states as
  a current goal: this product needing ≥4-hop path queries as a user-facing
  feature, needing graph algorithms (community detection, centrality) as a
  feature, or measuring p95 latency above 200ms on an indexed 2-hop walk at
  real scale — and even then, Apache AGE (a graph extension *inside*
  PostgreSQL) is the next thing to evaluate before reaching for a wholly
  separate server.
- **Full-corpus long-context Q&A instead of any structured store** — hand
  every transcript and note to a long-context model on every question.
  Rejected on cost and scale (this grows linearly with corpus size, forever,
  on every query) and because it performs no write-time entity resolution at
  all — every question re-derives "is this the same Sarah" from scratch,
  which is strictly worse than doing it once at review time (§7) and
  reusing the answer.
- **Microsoft GraphRAG's community-summary architecture.** Rejected because
  its target question — corpus-wide sensemaking, "what are the themes
  across everything" — is not the question this product's users are asking
  (§5.7); it is also the more expensive of the two designs to run
  (community detection plus a summary pass per community, repeated as the
  corpus grows), and a per-entity digest (§9.2) answers the actually-asked
  question ("what's new about *this*") for a fraction of the cost.
- **LazyGraphRAG-style deferred resolution** — resolve entities at query
  time instead of at write time, which the VentureBeat summary reports
  scoring within 0.1% of full GraphRAG on quality in that benchmark.
  Rejected specifically for kvox, despite that number, because entity
  resolution here is not pure overhead to be deferred — it **is** the review
  step a human already performs once, deliberately, over their own curated
  facts (§7, §8). Deferring it to query time would mean re-asking "is this
  the same Sarah" on every future question instead of once at commit time,
  discarding the one thing a human-in-the-loop design (§3.6) is supposed to
  buy: an answer, decided once, that stays decided.
- **The 44-type `graph_nodes` catalogue** the v0.2 draft used for every
  node type beyond `Person`/`Organization`/`Concept`. Rejected on precision:
  the catalogue's own boundaries were blurry by its own admission (a
  recurring meeting topic versus a `Project`, a `Task` versus a
  `Commitment`, an `Outcome` versus a `Decision`) in ways that would have
  made two reasonable extractors label the identical sentence two different
  ways with no test able to say which was "correct." §3.5's narrow,
  disambiguation-rule-per-type ontology exists specifically to make that
  kind of ambiguity structurally rare rather than merely documented against.
- **Extraction folded into the note-generation call itself**, as one more
  instruction in `note.generate`'s prompt. Rejected on three counts: it
  removes the template author's freedom to write instructions without also
  reasoning about graph extraction; it makes "re-extract after an edit"
  mean "regenerate the whole note," which is not what a user asking to
  re-run extraction wants; and it collapses two independent failure modes
  (a bad note, a bad extraction) into one job whose single failure could be
  either, defeating the specific, narrow error taxonomies `docs/specs/
  notes.md` §2.2 and this document's §6 each build for their own job.
- **Auto-commit above a confidence threshold, with no review panel at
  all.** Rejected outright as a default, not merely as a starting
  configuration: a silently wrong link committed with no review step is
  exactly the unsupported-assertion failure §3.3 and §3.6 exist to make
  structurally impossible, and "structurally impossible" cannot coexist
  with a code path that skips the only gate enforcing it. A *later*,
  narrowly-scoped, per-type, opt-in, default-off auto-commit setting is not
  ruled out as a future addition once §6's extraction metrics support it —
  but the write path that makes review skippable does not exist in this
  design at all, which is the point.
- **Bidirectional relation storage** — storing `EMPLOYS` beside `WORKS_FOR`,
  and similarly for every pair. Rejected per §5.2: Postgres joins are
  symmetric, so the only effect of storing both directions is a second row
  that can disagree with the first about a merge, a correction, or a
  reversal.
- **Chunk-based evidence anchoring**, following a generic RAG-style
  fixed-size-chunk convention rather than kvox's own segment ids. Rejected
  because chunks, in a generic chunking scheme, are rebuilt whenever the
  chunking strategy changes — re-chunking silently invalidates every
  citation that pointed into the old chunk boundaries. kvox's transcript
  segments are already stable across edits by construction
  (`docs/specs/transcription.md`, verified above), which is a strictly
  better anchor already sitting in this codebase; inventing a second,
  weaker anchoring scheme on top of a better one already available would be
  pure regression.
- **Storing anything user-owned in the existing `credentials` table.**
  Not directly applicable to this graph's own data, but named here because
  the same reasoning `docs/specs/notes.md`'s "Rejected alternatives" gives
  for `user_ai_credentials` (CLAUDE.md's Notes rule 5, the cascade argument) generalizes to
  every table this document defines: `credentials` has no foreign key to
  `users` and cannot grow one without complicating a table that exists to
  hold infrastructure secrets outliving whichever administrator configured
  them. Every `kg_*` table's `owner_id` **Cascade**s for the identical
  reason `user_ai_credentials.userId` does.
- **A `Concept`/topic layer in v1.** Deferred, not permanently rejected
  (§5.7) — today's `Meeting.topics[]` free-text property answers "what came
  up" without committing to a taxonomy this document has no evidence users
  need yet; promoting it to a graph node is a natural, low-risk v2 addition
  once real usage shows which topics recur enough to be worth linking.
- **A new bottom-bar destination for the graph.** Rejected per §13 and
  `apps/web/src/config/destinations.ts`'s own stated ceiling: the bar is at
  exactly four non-pinned destinations by design, and a fifth is "not an
  addition, it is a redesign" (the file's own words, verified above). The
  graph is reached from within existing surfaces instead.
- **Editing an edge in place when a newer note contradicts it.** Rejected
  per §5.4's "state is derived from dated facts" rule: overwriting a
  `WORKS_FOR` edge's `valid` range in place the moment a newer note
  disagrees would erase the very "what did we used to think, and when did
  that change" history §3.4 exists to keep, and would make an edge's value
  depend on which note happened to be reviewed last rather than on the facts
  actually in evidence for each period. A new dated fact is added instead,
  and the edge set is derived from the full set of facts, exactly as
  `materialize()` derives a transcript's current text from its version log
  rather than editing a segment's row in place.
- **Two nullable timestamps (`valid_from`, `valid_to`) instead of a range
  with a precision.** This was this document's own original design for
  §5.4 and is rejected here in favor of a single `tstzrange` +
  `valid_precision` pair: two nullable columns cannot express "true
  throughout 2026" without inventing a synthetic January 1st start and a
  synthetic January 1st end the UI then has to know to reconstruct as
  "2026" rather than display as two fabricated exact dates; a range column
  carries the precision it actually has, is GiST-indexable for the overlap
  and containment queries §5.4 and §10 both depend on, and makes an overlap
  check a native range operator instead of a pair of open-coded comparisons
  a migration or an extractor could get backwards.
- **LinkML/YAML as the definition format**, rather than TypeScript + Zod.
  Rejected per §17.1: LinkML is a Python toolchain, and this codebase is
  TypeScript end to end (CLAUDE.md's Technology Stack) — adopting it would
  mean a second language's build step wired into a Node/TypeScript monorepo,
  for capabilities (closed classes, slots, mixins) this design gets for free
  by reimplementing the *ideas* in Zod, the tool this codebase already uses
  as its single source of truth for settings. The ideas are credited in
  §17.1; the dependency is not taken.
- **EAV for user-defined attributes**, a generic
  `(entity_id, attribute_key, value)` table instead of JSONB `props`.
  Rejected per §17.3 on the same grounds the wider industry has settled on
  for this exact tradeoff: EAV's characteristic failure mode is slow,
  deeply self-joined queries once an entity accumulates more than a handful
  of dynamic attributes, while JSONB is indexable and on par with typed
  columns at this codebase's scale — the one real EAV advantage, schema
  validation for free, is not actually free (EAV still needs a definition
  row to validate a value's shape against), so JSONB plus an API-layer
  validation step against `kg_attribute_defs` gives the same safety with
  none of EAV's join cost.
- **User-defined entity types in v1.** Rejected per §17.3: a genuinely new
  type needs a prompt description precise enough for consistent extraction,
  a disambiguation rule against its nearest neighbour, evidence rules, and a
  place in the golden eval set (§6) before it can be trusted — none of which
  a settings-form text field can produce. Shipping this in v1 would
  reintroduce, per-user and uncentrally, exactly the blurry-boundary failure
  the 44-type `graph_nodes` catalogue rejection above documents for the v0.2
  draft's centrally-invented one. User-defined *attributes* on an
  already-disambiguated type carry none of that risk, which is the line
  drawn for v1; user-defined relation types wait for v2 under the identical
  constraint.
- **A Prisma migration per ontology change.** Rejected per §17.4: the
  physical `kg_*` tables do not change shape when the ontology changes —
  `props` is JSONB either way — so there is no schema migration to write in
  the first place, and modelling a per-user, application-level change (a
  user's own domain toggle, an ontology bump requiring row reshaping) as a
  `prisma migrate` step run by an operator would additionally spend a user's
  own AI provider key inside a deploy step performed on their behalf,
  exactly the mistake CLAUDE.md's `note.retitle` entry already documents
  and rejects for a different feature facing the identical shape of problem.
  `kg.migrate` (§11), a per-user, per-row, resumable job, is the actual
  mechanism.
- **Hand-maintained OWL/SHACL files beside the definition file.** Rejected
  per §18.2: a second, separately edited RDF/SHACL document is exactly the
  kind of "two things that can disagree" this document's own §3.2 rejects a
  Neo4j projection for, at a smaller scale but the identical failure mode —
  a contributor adds an attribute to the Zod definition, forgets the
  parallel Turtle file, and the exported shapes silently stop matching the
  live schema with no test able to catch it because nothing generates one
  from the other. Generating both from the single Zod source, as §18.1's
  mapping table and §18.2 both specify, makes that drift structurally
  impossible rather than a discipline to remember.
- **Importing straight into the graph, bypassing the proposal review
  step.** Rejected per §18.3 and, more fundamentally, per §3.6: an import is
  still an assertion from an external source about what is true, no more
  inherently trustworthy than an extraction run, and §3.6's commit gate is
  "the only write path into `kg_entities`/`kg_relations`/`kg_items` that
  exists at all, with two narrow, explicitly named exceptions" — neither of
  which is "the data arrived as RDF instead of as a note." Treating import
  as a third way in would mean a stranger's malformed or simply wrong CRM
  export could plant unreviewed "knowledge" directly into a user's graph,
  the identical unsupported-assertion failure §3.3 and §3.6 exist to rule
  out everywhere else in this design.
- **The agent generating SQL, Cypher, or any other query language.**
  Rejected per §21.1 for the identical reason §1's non-goals and §9.3
  already state for the toolset itself: a model that can be asked to *write*
  a query is a model that can be prompt-injected into writing a different
  one than intended, and every question this design needs to answer already
  fits one of a small number of fixed, parameterized shapes — there is
  nothing a free-form query buys that the fixed toolset does not already
  cover, and a great deal it would put at risk.
- **The agent writing to the graph, even a draft `kg_proposal_items` row a
  human still has to accept.** Rejected per §21.1 and, more fundamentally,
  per §3.6: the single commit gate's entire value is that it is the *only*
  way in, and a second, agent-shaped door into the same review pipeline —
  however gated — is still a second door, with its own prompt and its own
  chance of the "the agent found something, so add it" habit `note.generate`'s
  own bring-your-own-key discipline was built to keep at arm's length.
- **react-force-graph and cytoscape**, both named as open candidates in an
  earlier draft of §5.7 and §13. Rejected in favor of sigma.js + graphology
  (§22.1) once this document actually had to choose: react-force-graph
  renders to SVG/Canvas2D by default, which does not scale to the
  whole-graph overview's node counts as cleanly as sigma's WebGL renderer;
  cytoscape.js is a capable and mature library but ships its own graph-model
  abstraction rather than sharing one with a server-side layout algorithm,
  which would mean maintaining two different in-memory graph representations
  — one for the client's rendering library, one for the server's
  `graphology-communities-louvain` clustering — for what is conceptually the
  same graph.
- **Rendering the whole-graph overview client-side, without server-
  precomputed clusters.** Rejected per §22.3: a force-directed layout over
  an entire graph is exactly the workload §22.2's 300-node explorer cap
  already draws a line against, and the overview's whole purpose is showing
  more than that cap allows — computing it in the browser on every visit
  would either silently degrade into a frozen tab on a large graph or
  require the client to impose its own undocumented second cap, defeating
  the point of a *whole*-graph view.
- **A per-task model hardcoded by the administrator with no user override.**
  Rejected per §20.3: every AI-calling call site in this design already runs
  on the calling user's own provider key (§15) — an administrator's per-task
  default that a user could never override would mean the person paying for
  a call has no say in which model spends their money, the identical
  objection that already governs `NoteGenerationRequestService.resolveModel()`'s
  own user-choice-from-an-allow-list shape (verified above), extended here
  rather than special-cased away for this one feature.

## Verification

How this document's decisions will be checked against the code that
eventually implements them — the same purpose `docs/specs/transcription.md`'s
own Verification table and `docs/specs/transcript-name-correction.md` §13
serve for their own epics.

| Claim | Will be covered by |
|---|---|
| All eight job types (`kg.extract`, `kg.resolve`, `kg.entity_digest`, `kg.embed`, `kg.purge`, `kg.migrate`, `kg.export`, `kg.import`) declare no `nodeResultSchema`/`persistNodeResult`, and each declares exactly the `{ maxRuntimeMs, maxAttempts }` profile §11's table states | Unit assertions over each handler's declared members, mirroring `job-handler.registry.spec.ts`'s existing pattern |
| Every graph-touching `@Cron` (if any is added, e.g. a `graph.housekeeping` sweep) only enqueues | `apps/api/test/jobs/cron-enqueue-only.spec.ts`, extended |
| An `accepted`/`edited` entity, relation, or proposal item always has ≥ 1 `kg_evidence` row after a commit — the no-orphans invariant (§3.3, §8) | A dedicated integration test committing a proposal and asserting every resulting row's evidence count, plus a negative test asserting the commit transaction refuses to write an evidence-less row |
| The eval harness runs against the 30-meeting golden set and reports per-type precision/recall and auto-link precision, before any retrieval feature is built | `apps/api/scripts/kg-eval.ts` run in CI against `apps/api/test/fixtures/kg-golden/`, gating the targets stated in §6 |
| The rate-limit throttle key for `kg.extract`/`kg.resolve`/`kg.entity_digest` is `aiProviderThrottleKey(userId)`, distinct per user | A test asserting `registerProviderKey` is called with a key that varies by the run's `userId`, mirroring `note-generate.handler.spec.ts`'s existing pattern |
| Curated (`accepted`/`edited`) entities are never auto-merged with each other; when one side of a merge is curated, it is always the survivor | `apps/api/src/graph/resolution/resolution.service.spec.ts` |
| A merge is fully reversible: `POST .../merges/:id/reverse` restores the tombstoned entity, its reassigned relations/evidence/aliases, and re-queues the pair for review | An integration test performing a merge, reversing it, and asserting the graph state is byte-for-byte the pre-merge state |
| A confirmed-distinct pair is never re-proposed by a later `kg.resolve` run | `apps/api/src/graph/resolution/candidates.spec.ts` |
| An `as_of` query against the entity brief and the neighbourhood endpoint returns the edge open at that date, not the currently-open edge, for an entity with a closed and a superseding edge (§5.4's "as-of question" worked example) | An integration test seeding a person with two sequential `HAS_ROLE`/`REPORTS_TO` edges and asserting `as_of` inside the first edge's `valid` range returns it, not the second |
| Out-of-order ingestion — a note about an earlier meeting, reviewed and committed after a later meeting's note — attaches to the existing edge its `valid` range falls inside rather than reopening or splitting it, and proposes a new edge only when its `valid` range falls outside every known interval for that person and relationship type | An integration test committing a later-meeting note first, then an earlier-meeting note whose fact falls inside the resulting edge's `valid` range, asserting one edge with two evidence rows results, not two edges |
| A `sensitive` `PersonFact` is never pre-checked in a proposal, never appears in a note-generation prompt under any setting, and never appears in an entity brief unless directly requested | An RBAC/data-flow test sweeping every prompt-assembly and brief-composition call site for a `sensitive` fixture fact |
| `graph:read`/`graph:write` are seeded for Admin, Contributor and Viewer; no `graph:read_any` exists anywhere | `apps/api/test/prisma/seed-data.spec.ts`, extended |
| No access to a graph entity, relation, or proposal is ever a 403 | An RBAC matrix e2e distinguishing "no access" (404) from "wrong permission" (403) for every graph route |
| A transcript share does not expose the graph rows derived from it; revoking a share affects nothing on the graph side | An integration test sharing a transcript, asserting the sharee's `graph:read` cannot see entities derived from it |
| `GET /api/graph/entities/:id/brief` names a working citation (segment or note span) for every fact it states | An integration test against a seeded fixture entity, asserting every sentence in the composed brief carries a resolvable evidence reference |
| `reciprocalRankFusion()` is the same function instance `docs/specs/search.md`'s own retrieval and this document's entity brief both call — never a second implementation | A test importing both call sites' compiled output and asserting they resolve to the same module export |
| `kg.purge` scope `person` removes the entity, aliases, relations, items where subject/owner/counterparty, mentions and evidence, and leaves the source transcript/note text completely untouched | `apps/api/src/graph/handlers/kg-purge.handler.spec.ts` |
| The Danger Zone's `content`/`everything` scopes include graph rows after this epic ships | `apps/api/test/user-data/user-data-deletion.e2e.spec.ts`, extended |
| `pg_trgm` is enabled by the P1 migration and `kg_entity_aliases`'s trigram index is present and used by `EXPLAIN` for a fuzzy-alias query | A migration test plus a query-plan assertion, mirroring the existing HNSW-index verification discipline `SearchEmbedding`'s own migration takes |
| An export round-trips through import losslessly on a fixture graph — the same entity UUIDs, the same relations, and the same evidence citations come back after `kg.export` then `kg.import` into a second fixture account and accepting the resulting proposal in full | An integration test exporting a seeded fixture graph, importing it into a second account, accepting every proposed item, and asserting the two accounts' graphs are identical on entity id, relation set, and evidence set |
| A `sensitive` `PersonFact` never appears in any export format (JSON-LD, Turtle, or n-quads), under any setting | A test seeding a `sensitive` fixture fact alongside `business`/`personal` ones, running `kg.export` in each format, and asserting the sensitive fact's IRI and statement text appear in none of the three outputs |
| CI runs the SHACL engine over a fixture export against the generated shapes and fails the build on a violation | A CI job invoking `rdf-validate-shacl` against a fixture account's `kg.export` output and the same run's generated `ontology.shacl.ttl`, with a companion test asserting a deliberately-broken fixture (a missing `prov:wasDerivedFrom`) is reported as a violation rather than passing silently |
| A revert (`POST .../proposals/:id/revert`) removes every row untouched since its commit and leaves every touched row exactly as-is, naming which is which in its response | An integration test committing a proposal, editing one of its committed rows independently, then reverting, asserting the edited row survives untouched and named in the response while the rest are gone |
| Saving `ai.taskModels` refuses an entry whose model lacks the capability its task requires (`structuredOutput` for extract/adjudicate/digest, `toolCalling` for agent) | `apps/api/src/ai/ai-task-model-resolver.service.spec.ts` and a `PUT /api/ai-settings` integration test asserting the save is rejected, not merely warned about |
| Every citation in a `complete` Ask message resolves to an id one of that turn's own tool calls actually returned — no citation is ever invented or reused from a different turn | `apps/api/src/ask/ask-respond.handler.spec.ts`, asserting a deliberately fabricated citation id is stripped before the message is marked `complete` and counted in its stats |
| `POST /api/graph/explore/expand` refuses a request whose resulting node count would exceed 300, naming the cap in the response, rather than silently truncating the result | An integration test seeding a fixture graph large enough to cross the cap and asserting the specific refusal, distinct from an ordinary paginated/truncated response |

## Sources

- RAG vs. GraphRAG systematic evaluation —
  https://arxiv.org/html/2502.11371v3. Taken: single-hop RAG at 64.8 F1
  against graph-based methods' 60–63; multi-hop graph gains of +1–6%; only
  65.8%/65.5% of answer entities present in the built knowledge graphs
  (the extraction-coverage finding §9.4's design responds to directly);
  hybrid integration adding +6.4% over either arm alone.
- GraphRAG-Bench / "When to Use Graphs in RAG" (ICLR'26) —
  https://github.com/GraphRAG-Bench/GraphRAG-Benchmark. Taken: the framing
  of graph value as concentrated in multi-hop and corpus-wide sensemaking
  questions specifically, informing §1's scope line and §5.7's deferral of
  sensemaking features.
- VentureBeat practitioner summary of the same benchmark work —
  https://venturebeat.com/orchestration/stop-graphing-everything-when-graphrag-actually-beats-vector-rag.
  Taken: multi-hop recall rising 73.4%→87.8% with a graph in the loop; global
  comprehensiveness questions winning 72–83% of head-to-head comparisons;
  ~$48 indexing cost at benchmark scale; the LazyGraphRAG 0.1%-quality-gap
  figure this document's "Rejected alternatives" engages with directly.
- Zep: a temporal knowledge graph architecture for agent memory —
  https://arxiv.org/abs/2501.13956. Taken: the `valid_from`/`valid_to` +
  supersession pattern §5.4 adopts; +18.5% on LongMemEval and ~90% latency
  reduction over full-context baselines, cited for the *mechanism*, not as
  a benchmark this design claims to reproduce — its own LoCoMo numbers are
  publicly disputed and are explicitly not relied on here (§"Why this
  shape"); kvox measures itself against its own golden set (§6) instead.
- LLM extraction against scholarly Wikidata —
  https://arxiv.org/pdf/2411.08696. Taken: precision ≈ 0.80, recall
  0.81–0.97 for structured entity/relation extraction from real text with a
  capable model, used as the evidence base for §6's ≥0.95 auto-link
  precision and ≥0.85 commitment recall targets being realistic for a more
  structured domain (meeting transcripts) than the one this study measured.
- The superseded draft — `docs/ONTOLOGY.md` v0.2 (project name `knotes`,
  never implemented against kvox). Taken: the review-status lifecycle
  (§5.5), the "content is evidence" and "curated wins" principles (§3.1,
  §3.2 of that draft, restated as this document's §3.1 and §7), and the
  profile-based disambiguation approach to entity resolution (that draft's
  §9.8, restated as this document's §7). Explicitly not carried forward: the
  agent-execution-trace layer, the problem-resolution layer, the Neo4j
  projection, and the 44-type `graph_nodes` catalogue — see "Why this
  shape" and "Rejected alternatives" above for each.
