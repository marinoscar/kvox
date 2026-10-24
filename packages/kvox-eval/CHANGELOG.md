# @marinoscar/kvox-eval

## 0.1.0-next.16

## 0.1.0-next.15

## 0.1.0-next.14

### Patch Changes

- 5a36b44: Dependency and peer ranges on the platform packages move from 0.1.0-next.10 to 0.1.0-next.11, the release that hands deploy checks the deployment's recorded compose project. No code in these packages changes.

## 0.1.0-next.13

### Patch Changes

- b2d260a: Dependency and peer ranges on the platform packages move from 0.1.0-next.9 to 0.1.0-next.10, the release that fixes the deploy update retry after a failed run. No code in these packages changes.

## 0.1.0-next.12

### Minor Changes

- 3a48293: Extraction, resolution and evaluation for ontology 1.3.0 (#665, epic #661). `@marinoscar/kvox-api`: the `kg.extract` system prompt gains two rules derived from the offered schema, a Project / Topic / Product boundary rule and a worked example of the Joe / Company A / Microsoft Copilot rollout (entities, `INVOLVED_IN {role, stance}`, `USES {stage}`, `OFFERED_BY`, `CONCERNS`, a Risk), each printed only for the types, relations and property choices the run offers; entity resolution counts a Product's vendor as its organization (`OFFERED_BY`, and a mention's `vendorName`) so "Copilot", "M365 Copilot" and "Microsoft 365 Copilot" resolve to one Product (the same affiliation list serves `kg.resolve`, `kg.embed` and the proposal stage); the item adjudication prompt adds a Risk rule (a risk raised again is the same risk with more evidence). `@marinoscar/kvox-eval`: the Joe / Company A / Copilot rollout scenario (m56, m57: note-only fixtures with a no-stance negative), Ask questions q43 and q44, and `citeFromMin` on an Ask question (at least N distinct `citeFrom` sources must be cited, default 1) with `scoreCiteFromHit`'s optional `min` argument.
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

### Minor Changes

- 38bf270: `@marinoscar/kvox-ai` and `@marinoscar/kvox-eval` no longer require `@marinoscar/platform-api`: they depend on the lean `@marinoscar/platform-ai-providers` (provider adapters and the provider-agnostic AI core, no Nest runtime) as an exact-version peer, and `kvox-eval` gains an `openai` peer for its live runs (#578). `kvox-ai` exports `isAiError()`, which recognises the lean `AiError` and the web host's distinct `AiError` class, so error classification is unchanged in both editions.

## 0.1.0-next.0

### Minor Changes

- 7310f9d: Add the headless Ask evaluation (#608). The new `@marinoscar/kvox-eval/ask-run` subpath (`runAskEval`, `runAskReplay`, `startAskEvalHost`, `seedGoldenGraph`, `runAskCommand`) runs the golden question set through the real `ask.respond` handler on an in-memory PGlite migrated with the platform and domain history, seeding the golden graph through `GraphWriteService`. It never touches a real database. `kvox-eval ask` (`--provider`, `--model`, `--base-url`, `--only`, `--category`, `--out`, `--min-match`, `--replay`) replaces the stub that exited 2; `--replay` needs no key. Exit codes are 0, 1 and 2, and the key is read only from `KVOX_EVAL_OPENAI_API_KEY`.

  The root entry does not export `ask-run`; import the subpath. The package now ships `host/prisma` and `host/generated`, built by `scripts/prepare-host.mjs`.

  New required peers: `@electric-sql/pglite` (0.5.10), `@electric-sql/pglite-pgvector` (0.0.11), `@electric-sql/pglite-socket` (0.2.13), `@prisma/client`, `@prisma/adapter-pg`, `pg`, `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs`.

- c060a77: New package `@marinoscar/kvox-eval`: the KVox knowledge-graph and Ask evaluation (#580), written only against the model port (`KvoxAiPort`, bound with `createKvoxAi` of `@marinoscar/kvox-ai`). It moves in from the web app unchanged in behaviour: the synthetic golden set (`./fixtures`: 36 meetings and the Ask question file, with their schema and loaders), the prediction schema, the scorer, the report and the gold, `extract` and `extract+resolve` runners, `runKgEval`, the pure half of the Ask evaluation (question schema, scorer, report), the real-data path guard, and the `kvox-eval` CLI (`kvox-eval kg`; `kvox-eval ask` is not headless yet). Live runs go through `createDirectRuntime` over the platform's OpenAI and OpenAI-compatible adapters with the key from `KVOX_EVAL_OPENAI_API_KEY` (`KG_EVAL_OPENAI_API_KEY` and `ASK_EVAL_OPENAI_API_KEY` are read for one more release); the web app's private OpenAI client is gone.
- 8dfebb9: Harness parity (#580). `@marinoscar/kvox-ai/testing` gains request recorders: `createRecordingRuntime` (every runtime round trip, without user, org, job or signal), `createRecordingAdapter` (a scripted provider adapter for `createDirectRuntime` that records what it receives) and `normalizeRecordedValue` (ids, timestamps and request ids numbered by first appearance, nothing dropped). `@marinoscar/kvox-eval/parity` drives notes generation, `kg.extract`, adjudication and three Ask questions through the real package code over any `KvoxAiPort` and ships the request snapshots (`parity/requests.*.json`) every host binding must reproduce; `kg` also exports `runExtraction` and `fixtureToInput`. `@marinoscar/kvox-api/notes` exports `budgetFromTarget` and the `AiTokenCaps` type.
