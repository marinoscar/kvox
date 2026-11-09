# @marinoscar/kvox-db

## 0.1.0-next.25

### Minor Changes

- 82eadd9: Graph extraction cites the stored source text of a note that was generated from a document (#789, epic #773). `kg.extract` used to read only the generated summary, so a span of the full document could not be cited. It now reads the document's extracted text (`{ extractedObjectId }`, spec notes §4.7) as the input, chunked as in #777, with the generated note shown whole as context, and the model cites the text as `D`.

  `@marinoscar/kvox-db` adds the migration `20261107120000_add_kg_evidence_source_text`: `kg_evidence.source_object_id` (the stored text, `SET NULL`) and `kg_evidence.source_text_length` (the length its `char_start`/`char_end` index, and the durable marker of this anchor kind because it survives the `SET NULL`), plus the `kg_evidence_source_text_chk` constraint. The deferred `kg_assert_has_evidence` no-orphans trigger is unchanged and counts a source-text citation like any other evidence row.

  `@marinoscar/kvox-contract`: `EvidenceInput` gains `sourceObjectId` and `sourceTextLength` (both default `null`; a source-text citation also carries the note), `EvidenceLink.source` gains `kind: 'source_text'` (with the deep link `/notes/<id>?source=<start>-<end>`), `EvidenceView.source` gains `'source_text'` and the evidence span input gains `source: 'source_text'`.

  `@marinoscar/kvox-api`: `EvidenceValidator`, `GraphEvidenceService`, the proposal view mapper, the span validator (`SpanValidator.prepare` reads the source text before the transaction) and the proposal commit handle the new anchor; the RDF export leaves out the offsets of a source-text citation, which index the document and not the note version. `ExtractionInputLoader` takes an optional `KVOX_OBJECT_STORE`; `ExtractionInput.sourceText`, `ExtractionContext.source`, `SOURCE_ALIAS` and `readNoteSourceText` are new. Every code that builds an `EvidenceInput` literal sets the two new fields to `null`.

  `@marinoscar/kvox-web`: the evidence chip, the explorer evidence card and the proposal review evidence list render a source-text citation ("Source of <note>", "Open source document").

- 72db610: Note context attachments schema (issue #810): `note_context_attachments` (documents and images attached to a note as generation context; Cascade on the note, Restrict on the storage object, unique `(note_id, object_id)`, a `kind` CHECK) and `note_generations.context_attachments` (a JSON snapshot of what was sent), with the migration `20261106120000_add_note_context_attachments` and back-relations on `Note` and `StorageObject`.

## 0.1.0-next.24

## 0.1.0-next.23

### Minor Changes

- e908255: Commit the confident rows of every note's graph proposal automatically, by default (#779). The auto-commit job now runs for every note, not only notes of a note library, and applies the same safe policy as the Review Queue: ambiguous or possible-duplicate matches, closings, low-confidence rows and sensitive person facts still wait for a person. A new graph preference, `review.autoCommitSafeRows` ("Commit confident rows automatically", on by default, no backfill needed), controls it; a note library's own auto-commit setting, when set to on or off, overrides the preference for that library's notes. The library setting is now three-way: `autoCommit` is `null` (follow the preference), `true` or `false`, in the contract, the API and the library page. The domain migration makes the column nullable and turns the old never-chosen `false` into `null`. The note page gains a "Re-run extraction" action, which replaces an earlier open draft once the new one is ready.
- 88236d3: The graph now knows who the account owner is (#778). A new per-user graph preference, `self.entityId` (none by default), names the Person that is you; Settings, Knowledge graph has a "You in the graph" control to pick an existing Person, accept a suggestion that matches your profile name, or add a Person by hand. Nothing is ever chosen for you. When it is set, extraction tells the model those names are the note's owner and offers the Person as a known entity, a mention of the owner's name or an alias links to it at or above the auto-link threshold, and the graph explorer draws the node as "You" with its own ring and always labels it. The read APIs mark it with `isSelf`. A graph without a chosen Person is unchanged, and so is the extraction prompt.

## 0.1.0-next.22

## 0.1.0-next.21

## 0.1.0-next.20

### Minor Changes

- 97585da: Add the `kg_synonyms` table (`KgSynonym`): the owner's personal synonym dictionary for the knowledge graph, with a GIN index on `normalized` and a cardinality CHECK.

  Add the personal synonym dictionary (issue #767): `GET/POST /graph/synonyms`, `PATCH/DELETE /graph/synonyms/{id}` (`GraphSynonymsController`, `SynonymsService`, contract `synonyms.ts`). Entity resolution matches a mention against every term of a synonym group that contains one of its names, the possible-duplicates list proposes same-type entities whose names share a group (new reason `synonym`, score 0.9) and entity search finds an entity under any name of a matching group.

  Add the Synonyms page (`/graph/synonyms`, `GraphSynonymsPage`) with the `listSynonyms`/`createSynonym`/`updateSynonym`/`deleteSynonym` client and the `useGraphSynonyms` hook, "Synonyms" links on Possible duplicates and the Knowledge index menu, and an "Also add these names to my synonyms" option in the merge dialog.

## 0.1.0-next.19

## 0.1.0-next.18

## 0.1.0-next.17

## 0.1.0-next.16

## 0.1.0-next.15

### Minor Changes

- 22adaf9: Note libraries schema (issue #713, epic #708): `note_libraries`, `note_library_files`, `note_import_batches` and `note_import_batch_items`, with the migration `20261023033028_add_note_libraries` and back-relations on `Note`, `User` and `StorageObject`.

## 0.1.0-next.14

## 0.1.0-next.13

## 0.1.0-next.12

### Minor Changes

- bf5ba86: The graph explorer gets an Insights panel (GIC-16, #677, epic #661). API: `kg.graph_layout` also computes approximate betweenness centrality (sampled Brandes from at most 200 seeded sources, capped by a work budget, its own rng stream so positions and clusters are unchanged) and stores the top 50 "connectors" with the clusters each one bridges in the snapshot's `clusters` JSON (an optional field: no migration, older snapshots read as `connectorsReady: false`). New `GET /graph/insights?window=30d|90d|365d` (`graph:read`, owner-only, sensitive facts excluded): `themes` (the snapshot's clusters), `connectors` (top betweenness entities with a plain-language reason), `rising` (at least 3 conversations in the window and at least 2x the window before), `fadingTies` (People/Organizations with at least 3 evidence rows before the window and none in it) and `openRisks`; themes and connectors carry `stale`/`pending` like the overview and are never recomputed by the request, the window queries run inside the 3 s graph budget (503 `graph_query_timeout`). Contract: `graphInsightsQuerySchema`, `graphInsightsResponseSchema` and their types. Web: `getGraphInsights()`, `useGraphInsights()`, `InsightsPanel` (Themes, Connectors, Rising, Fading ties, Open risks; in the facets pane, rail popover or drawer by window class; every item seeds the canvas through `useInsightSelect`; 44px targets on a coarse pointer) and the exported `InsightSeeds`, `InsightSectionKey`, `InsightsPanelProps`, `UseInsightSelectOptions`, `InputModality`. the database package is bumped with the fixed group only; it has no schema change.
- 0965f84: Ontology 1.3.0, step 3 (#664, epic #661). `@marinoscar/kvox-contract/ontology`: the `Risk` item type (work, `itemKind: 'risk'`, statuses `open | mitigated | closed | superseded`, subjects Person, Organization, Project, Product or Topic, attributes `severity`, `riskKind`, `mitigation`), `ABOUT` starts at a Risk and `SUPERSEDES` allows Risk to Risk; the wire schemas learn the `risk` item kind, the `Risk` proposal group and the brief's optional `openRisks` section. `@marinoscar/kvox-db`: migration `add_kg_item_kind_risk` adds `risk` to the `kg_item_kind` enum (additive; no row changes). `@marinoscar/kvox-api`: the extraction prompt, output schema and RDF exports offer Risk, `GraphWriteService` writes it with evidence, the Ask toolset gains the read-only `list_risks` tool (subject, status, severity; highest severity first), and the entity brief of a Project, Product or Organization gains an "Open risks" section (cited, never a model call, omitted when empty or when the work domain is off). `@marinoscar/kvox-eval`: 18 gold Risk items (m50-m55). `@marinoscar/kvox-web`: the brief card shows "Open risks" when the API sends it, and the review, timeline and add-to-graph surfaces handle the Risk kind.

## 0.1.0-next.11

## 0.1.0-next.10

## 0.1.0-next.9

## 0.1.0-next.8

## 0.1.0-next.7

## 0.1.0-next.6

## 0.1.0-next.5

## 0.1.0-next.4

## 0.1.0-next.3

## 0.1.0-next.2

## 0.1.0-next.1

## 0.1.0-next.0

### Minor Changes

- 1d98ec7: Fixes found by the bare-host smoke app (`examples/bare-host`, a host that installs the packed tarballs and is not the web edition). `@marinoscar/kvox-db` gains the migration `20261016120000_transcripts_org_id` (byte for byte the web app's, which `kvox-db sync` adopts): the transcripts fragment already declared the NOT NULL `org_id` column, but a host with no domain history never got it, so no transcript could be created. `organizations` joins `users`, `storage_objects` and `jobs` as a host table a domain migration may reference (`KVOX_HOST_TABLES`, `KVOX_HOST_MODELS`). `@marinoscar/kvox-api`: resolving a provider a host registers through `extraProviders` no longer fails for want of a stored settings block; the PDF exporters' exported drawing helpers take the new `KvoxPdfDocument` type (an `object`, from `core`) instead of pdfkit's, so the package's declaration files typecheck with `skipLibCheck: false` in a host that left the optional `pdfkit` peer out; and the `ai` system settings namespace the slices read, the global `ZodValidationPipe` and the host's upload-completion route are documented as host duties.
- 7a9b5dd: The domain schema moves into `@marinoscar/kvox-db`: the five fragments (`schema/kvox.{transcripts,notes,search,graph,ask}.prisma`), the 18 domain migrations byte for byte with `migrations/manifest.json`, the raw-SQL index, extension and schema-object inventories, and the `kvox-db` command (`sync`, `check`, `check --database`, `promote`) that installs them into a host app with `prisma/kvox.lock`.
- 45f8f99: Document how to consume the domain packages from a host that is not the web edition. Every package README and every slice README gains a `### Desktop` note that links the new KVox Desktop consumer guide (`docs/guides/kvox-desktop.md`): the packages and slices, the install lines and optional peers, the embedded database (PGlite or a bundled PostgreSQL, the `kvox-db sync --names after-host` prepare sequence), the ten ports to implement with their rules and the bare-host reference classes, a sketch of the GitHub Copilot SDK `KVOX_AI` adapter, the in-process job runner, the API and web wiring, what changes offline feature by feature, the conformance kits to run and the version policy. No code or contract changes.
- d38a85d: First pre-release of the KVox domain packages: empty, documented and buildable skeletons of the contract, db, api and web packages, with the `kvox-db` command printing its usage. The domain code moves in with Epic 5 and Epic 6.

### Patch Changes

- 0f32e34: Add the `stable` naming policy to `kvox-db sync` (`--names stable`) and export `stableName(id)`: an installed domain migration is named `<package timestamp>_kvox_<slug>`, a pure function of the package migration id, so it no longer shifts when the platform or another package adds a migration. It is the new default for a host with no domain history (a fresh host should run `platform db sync --timestamp 2024-01-01T00:00:00Z` first so the platform tables sort before the domain's); `after-host` and `afterHostNames` are deprecated because their names move by a second whenever another package adds a migration. Existing installs keep their recorded names: the web app's `original` names and any `kvox.lock` policy are inferred from the lock and never changed.
