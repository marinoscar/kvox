# calibration

The harness that measures the graph's embedding thresholds per model: a labelled calibration set, precision and recall per threshold, the three recommendation rules and the `kvox-eval calibrate` command.

## Purpose and scope

Entity resolution and item dedup compare embedding cosines against cut-offs (`vectorFloor`, `itemCosine`, `itemSameConfidentCosine`). They were tuned to OpenAI text-embedding-3-small and now live on each catalog model (`KvoxEmbeddingModel.graphCalibration` of `@marinoscar/kvox-ai`, issue #681). This slice is how a model's numbers are checked and re-derived.

- `buildCalibrationSet(fixtures, hand?)`: entity-name pairs (same / different) and statement pairs (duplicate / distinct). Derived from the golden meetings (a label against its own aliases; the lexically closest other entities of the type; same-subject items with different statements) plus the hand-authored hard cases in `fixtures/embedding-calibration/pairs.json`. Every name and statement is invented. Deterministic. The texts are the product's own profile texts (`buildEntityProfileText`, `buildItemProfileText`), so a vector here is comparable to a vector in the product.
- `evaluateModel(model, set, vectors, { calibration })`: per-cosine precision and recall (`cosineSweep`), where the negatives sit (`negativeCosineP95`, `negativeCosineMax`), and the DECISIONS the product makes with a calibration replayed through its own functions (`scoreCandidate` + `bandFor`; `selectCandidates` + `mapItemVerdicts`): entities surfaced to adjudication, entities auto-linked (also in the best-case context), item candidates kept, and confident `same` verdicts left unflagged.
- The three rules behind `recommended`: `vectorFloor` is the LOWEST entity cosine with precision >= 0.95; `itemCosine` is the HIGHEST item cosine with recall >= 0.95 (it only gates the adjudicator's input); `itemSameConfidentCosine` is the LOWEST item cosine with precision >= 0.99, never below `itemCosine`. A rule no threshold satisfies is `null` and the model keeps its current value. The result is an input to a person's decision, never applied automatically.
- `mapCutoffByHeadroom(cutoff, { from, to })`: the first calibration for a model nobody has measured. It keeps the same fraction of headroom above the model's unrelated-pair ceiling and rounds UP to 0.01. The bge-small-en-v1.5-int8 numbers (0.83 / 0.87 / 0.95) are the OpenAI ones (0.75 / 0.80 / 0.92) mapped from a 0.35 to a 0.55 ceiling (the search baseline: unrelated 0.28-0.55); a spec pins the derivation.
- Vectors come from a recorded file (`recordedVectors`: `{ "model": "<id>", "vectors": { "<text>": [..] } }`) or, for the harness's self-test, `hashedNgramVectors` (deterministic character-trigram hashing; NOT a semantic model; `anisotropy` lifts every cosine the way a high-baseline model does).

### Re-running calibration for a model

```bash
kvox-eval calibrate --dump-texts texts.json     # the distinct texts to embed (about 400)
# Embed each text as a DOCUMENT (no query prefix) with the host's real model, through the same
# createKvoxAi port, and write { "model": "<catalog id>", "vectors": { "<text>": [..] } }.
kvox-eval calibrate --vectors bge.json --vectors openai.json --json report.json
kvox-eval calibrate --self-test                  # harness check only: says nothing about a model
```

Read the report against the catalog value it prints: the acceptance bar for a model is that its auto-link and confident-merge precision on the set is at least the OpenAI baseline's, and that `surfaced` precision does not fall. Then edit `graphCalibration` on the catalog entry in `packages/kvox-ai/src/embedding/embedding-catalog.ts` (a changeset for `@marinoscar/kvox-ai`; a re-embed is NOT needed, the numbers are read at decision time).

Limits to know: the vector arm alone can never auto-link at the default preferences (its base tops out at 0.60 and the context boosts at 0.27, below 0.90), so the auto-link rows measure the name arms and show that a calibration leaves them alone; the vector floor's effect shows in `surfaced` and in the cosine sweep. Entity texts here are bare names (no co-mention or organization lines), so real profile vectors sit a little higher than the set suggests.

Status: issue #681 (bge numbers derived, not yet measured on recorded vectors).

## Entry point

`@marinoscar/kvox-eval` (the package root re-exports this slice), and the `kvox-eval calibrate` command.

## Peer dependencies

`@marinoscar/kvox-ai` (the catalog entries the command compares against), `@marinoscar/kvox-api` (through the `kg` slice's internals: the scorer, `selectCandidates`, `mapItemVerdicts`, the profile-text builders) and `zod` (the pairs and recorded-vectors schemas). It imports the `fixtures` and `kg` slices.

## Configuration

None: every option is an argument of `evaluateModel`, or a flag of the command (`--self-test`, `--dump-texts`, `--vectors`, `--json`). Exit code 2 is a usage error or an unreadable file.

## Extension-point catalog

None. A new model is a recorded-vectors file and a catalog entry, not code here.
