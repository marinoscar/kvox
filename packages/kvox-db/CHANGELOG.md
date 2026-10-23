# @marinoscar/kvox-db

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
