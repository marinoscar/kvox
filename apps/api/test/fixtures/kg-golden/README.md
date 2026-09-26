# Knowledge-graph golden set

The labelled meetings that `kg.extract` (and later `kg.resolve`) are measured
against — `docs/specs/ontology.md` §6, issue #362. Scored by
`npm run kg:eval --workspace=api`; validated by
`apps/api/test/graph/kg-golden-fixtures.spec.ts`, which asserts every rule on
this page.

## Synthetic only — the one rule that is never relaxed

Every meeting here is **invented**. No real recording, transcript, note, name,
company, email address or phone number belongs in this directory, anonymised or
not: speech re-identifies people (voices, employers, events), and a private
conversation is exactly what this product never exposes to anyone else. Names
and organisations are made up (Larkspur Labs, Northwind Robotics, Halden
Freight, …); an email address, if one is ever needed, uses `@example.com`; the
product's own name never appears. The fixture test enforces the email, phone
and product-name rules with regexes.

To evaluate against **your own** real notes, use the local, opt-in mode:

```bash
# Export one of your notes as an UNLABELLED skeleton (read-only; your note only)
npm run kg:eval --workspace=api -- --real-dir ~/kg-real --export-note <noteId> --user <you@…>
# Label it by hand in ~/kg-real, then score a run against it
npm run kg:eval --workspace=api -- --real-dir ~/kg-real --predictions <dir>
```

`--real-dir`, `--out` and `--export-note` refuse (exit 3) any path inside the
git work tree, symlinks included. `KG_EVAL_REAL_DIR` may stand in for
`--real-dir`. Nothing from a real run is ever collected or committed.

## File format

One JSON file per meeting: `meetings/mNN-<slug>.json`, where `NN` is the
fixture `id` (`m01`…). The contract is `goldenFixtureSchema` in
`apps/api/scripts/kg-eval/fixture-schema.ts`; in outline:

| Field | Meaning |
|---|---|
| `id`, `title`, `tags` | Identity and scenario tags (see coverage below). |
| `recordedAt` | The meeting date — every relative date ("next Tuesday", "in three weeks") resolves against it (§5.4). |
| `contextText` | What the user typed into the note's Context field, or `null`. |
| `hasTranscript` | `false` for a note-only meeting: no `speakers`, no `segments`, and every citation is `source: "note"`. |
| `speakers`, `segments` | Diarized speakers and their lines. Segment ids are `<id>-sNNN`, unique across the set, sorted and non-overlapping. 20–120 segments per transcript. |
| `note.body` | The generated note, written the way `note.generate` writes one: `# Title`, a `**Date:**` and an `**Attendees:**` line, then sections. 200–700 words. |
| `knownEntities` | The graph as it stood **before** this meeting (ids like `g-person-sarah-chen`), with aliases and the earlier fixtures each attended. What resolution may link to. |
| `labels.entities` | Gold `Person` / `Organization` / `Project` / `Meeting` rows. `key` is local to the file; `existingId` says which known entity the mention must link to. Every fixture labels its own `Meeting` (key `meeting`). |
| `labels.relations` | Gold edges, using only the ontology's extractable relation types. `from`/`to` are keys or known ids. Temporal types carry `validFrom`/`validTo`/`precision` per §5.4 (half-open; month/year bounds on the first of the unit; `unknown` means both bounds `null`). Non-temporal ones are `unknown` with `null` bounds. |
| `labels.items` | Gold `commitment` / `decision` / `claim` / `person_fact`. `owner` and `counterparty` are the `ASSIGNED_TO`/`OWED_TO` columns; `status` only on commitments; `sensitivity` only on person facts. `supersedesLabel` names an earlier item as `<fixtureId>#<kind>-<n>` (`n` = 1-based position among that fixture's items of that kind), e.g. `m01#claim-1`. |
| `labels.negatives` | Text a correct extractor must **not** turn into a row (§5.1), each with why. |

Every label carries `evidence`: `{ source: "segment", segmentId, quote }` or
`{ source: "note", quote }`. A quote must appear **verbatim** (after whitespace
collapse) in that segment or in the note body. Every type key must exist in the
ontology registry's `core ∪ work` schema — or, for a fixture tagged
`personal`, `core ∪ work ∪ personal` (#383: the story of a user who turned the
`personal` domain on; `scripts/kg-eval/domains.ts`) — and every endpoint must
satisfy its relation's `from`/`to` lists — both are read from
`@app/shared/ontology`, never from a list in the test. A personal type in an
untagged fixture fails the test: the untagged set is what proves a user who
never enables `personal` is offered none of it.

## Adding a fixture

1. Pick the next free id and write `meetings/mNN-<slug>.json`. Keep it
   plausible: a real meeting's texture, distinct content, invented people.
2. Reuse the existing cast where the story continues (the `g-…` ids in other
   files' `knownEntities`), so resolution traps stay meaningful.
3. Label what a careful human reviewer would accept, and nothing else. When in
   doubt, prefer `unknown` precision to a guessed date, and a negative example
   to a force-fitted commitment.
4. Run `npx jest test/graph/kg-golden-fixtures.spec.ts` (from `apps/api`) and
   `npm run kg:eval --workspace=api -- --predictions gold`, which must print
   1.000 everywhere.

## Coverage the set must keep (asserted by the fixture test)

- ≥ 30 fixtures; ≥ 10 gold instances of each entity type (Person, Organization,
  Project, Meeting); ≥ 15 of each item kind; ≥ 3 of every extractable relation
  type and of each item-column relation (owner, counterparty, supersedes …);
  ≥ 10 labels with `existingId`.
- Temporal (§5.4): a promotion (`HAS_ROLE` change, tag `promotion`), a manager
  change (`REPORTS_TO`, tag `manager-change`), a company change with an open
  commitment owned by the leaver (`company-change`), an out-of-order 2020
  meeting arriving after 2026 ones (`out-of-order`), an "in 2026" year-precision
  fact, relative dates resolved against `recordedAt` (`relative-date`), and
  ≥ 3 `unknown`-precision facts.
- §5.1 negatives, each in `labels.negatives`: a role ("the CIO",
  `negative-role`), "whoever's on call" (`negative-on-call`), a team mentioned
  in passing (`negative-passing-team`), a recurring topic that is not a
  Project (`negative-topic`), "we should probably look into that"
  (`negative-vague-task`).
- `PersonFact` at all three sensitivity levels, ≥ 3 `sensitive`.
- Resolution traps: two different Sarahs at different organisations
  (`two-sarahs`), a misspelling ("Sara Chen", `misspelling`), a nickname
  matching a known alias ("JJ", `nickname`), an abbreviation ("NWR" /
  "Northwind Robotics", `abbreviation`).
- Supersedes chains: a decision reversed in a later fixture, and "the pilot
  moved to Q2" after "the pilot is scheduled for Q1".
- ≥ 2 note-only meetings (`note-only`).
- Personal domain (#383), in fixtures tagged `personal` (≥ 5): every
  `personal` type and relation labelled at least once — a spouse, parents and
  children, a friendship, a trip with dates, a birthday `Milestone` — a known
  symmetric relation restated the other way round (it must dedup to the one
  stored edge), and a work trip that must not become a `Trip`
  (`negative-work-trip`, in `labels.negatives`).

## The Ask evaluation's question file (issue #382, epic #348)

`ask-questions.json` (beside this README) is a **separate** golden set, over
the **same** meetings: ≥ 40 hand-written questions with expectations, scored
against the Ask agent (#377/#378) rather than against extraction. It is
validated by `apps/api/test/ask/ask-eval-questions.spec.ts`, scored by
`npm run ask:eval --workspace=api`, and its schema lives in
`apps/api/scripts/ask-eval/question-schema.ts`. See that file's own comments
for the full contract (`category`, `expected.{entities,answerAll,answerNone,
citeFrom,notFound}`); the short version:

- `citeFrom` names a segment id **exactly as this set's own `mNN-sNNN` ids
  read** (e.g. `"m01-s009"`), or `"mNN#note"` for a meeting's note — never a
  new naming scheme.
- A question's `id` (`q01`, `q02`, …) is **permanent** once committed, for the
  identical reason a fixture's `id` is: a report stays comparable run over
  run. Retire a question by noting it here, never by renumbering.
- The seeder (`apps/api/scripts/ask-eval/seed-graph.ts`) always loads **every**
  fixture in this directory and writes the meetings' hand LABELS (never a
  model's extraction) as the graph the agent is asked about — so a question's
  `fixtures` field is provenance for a reviewer, not a scoping instruction.
- Adding a fixture here (a new meeting) is safe and additive: it does not
  break an existing question's `citeFrom`/entity expectations, because those
  reference specific ids this set already has. Adding a QUESTION instead
  requires only that its `citeFrom`/`entities` name real ids/labels somewhere
  in this directory — `ask-eval-questions.spec.ts` checks that referential
  integrity on every run.
