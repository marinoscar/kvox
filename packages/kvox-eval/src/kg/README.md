# kg

The knowledge-graph evaluation: the prediction schema, the scorer, the report, the gold and live runners, and `runKgEval`.

## Purpose and scope

`runKgEval(opts)` scores one run: `gold` (predictions synthesised from the labels, the harness's self-test), a `predictionsDir` (`<dir>/<fixtureId>.json`), or a live runner (`extract`, `extract+resolve`, alias `extract-resolve`) over a `KvoxAiPort`. It reads no environment and writes no file; `onPrediction` and `onMissingPrediction` let a caller persist and report. `scoreFixture` / `scoreRun` are pure and deterministic; `buildReport` / `formatReport` / `kgEvalReportSchema` are the report and its JSON contract; `KG_EVAL_TARGETS` is the §6 bar (docs/specs/ontology.md). The runners run `kg.extract`'s own pure pipeline (through `@marinoscar/kvox-api/graph-extraction/testing`'s `internals`, gathered in `internals.ts`, not exported).

Status: issue #580 (from `apps/api/scripts/kg-eval/`; #362, #363, #364, #365, #383 before it).

## Entry point

`@marinoscar/kvox-eval` (the package root re-exports this slice).

## Peer dependencies

`@marinoscar/kvox-api` (`/graph`, `/graph-extraction`, `/graph-extraction/testing`, `/ports`), `@marinoscar/kvox-contract` (`/ontology`, `/graph`) and `zod`. It imports the `fixtures` slice.

## Configuration

None: everything is an option of `runKgEval` or of a runner.

## Extension-point catalog

- `KgEvalRunner`, registered as a lazy factory in `KG_EVAL_RUNNERS` (a test adds a stub and deletes it afterwards).
