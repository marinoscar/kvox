# @marinoscar/kvox-eval

The KVox knowledge-graph and Ask evaluation: the synthetic golden set, its schemas, the scorers, the report, the gold and live runners and the `kvox-eval` command. Written only against the model port, so every host measures the prompts, schemas and validators the product ships. CommonJS.

## Purpose and scope

One package for "how good is extraction (and Ask) on the golden set", shared by the web edition and KVox Desktop. A live run binds the same `KvoxAiPort` every host binds (`createKvoxAi` of `@marinoscar/kvox-ai`, over `createDirectRuntime` and the platform's provider adapters); the extraction pipeline it scores is `@marinoscar/kvox-api`'s own (`graph-extraction` internals), minus the loader and the writer. The package owns no prompt, schema or pipeline of the product.

It does not own the Ask run itself: seeding a graph and driving the real `ask.respond` handler needs the web app's database and Nest application, so `npm run ask:eval --workspace=api` stays in `apps/api` and imports this package's question schema, scorer and report. Exporting one of your own notes as an unlabelled skeleton (`--export-note`) reads the web app's tables and stays there too.

Status: implemented by issue #580 (moved from `apps/api/scripts/kg-eval/`, `apps/api/scripts/ask-eval/` and `apps/api/test/fixtures/kg-golden/`), unreleased like the other packages. The web app's private OpenAI client (`direct-structured.ts`) is deleted; `npm run kg:eval --workspace=api` is a thin wrapper over `runKgCommand`.

Entry points:

- `@marinoscar/kvox-eval`: the package root, which re-exports the `kg`, `ask`, `live`, `real-data` and `cli` slices. Slice READMEs: [kg](src/kg/README.md), [ask](src/ask/README.md), [live](src/live/README.md), [real-data](src/real-data/README.md), [cli](src/cli/README.md).
- `@marinoscar/kvox-eval/fixtures`: the golden set (`loadGoldenMeetings`, `GOLDEN_MEETINGS_DIR`, `ASK_QUESTIONS_PATH`, `loadGoldenAskQuestions`) and its schema (`goldenFixtureSchema`, `GoldenFixture`). Slice README: [fixtures](src/fixtures/README.md). The data is under [fixtures/kg-golden](fixtures/kg-golden/README.md).
- `kvox-eval` (the `bin`, `dist/cli/main.js`).

## Install and peer dependencies

```bash
npm install @marinoscar/kvox-eval@next @marinoscar/kvox-ai@next @marinoscar/kvox-api@next @marinoscar/kvox-contract@next @marinoscar/platform-api@0.1.0-next.5 zod
```

Every slice is universal, so every peer is required:

| Package | Range | Needed by |
|---|---|---|
| `zod` | `^4.4.3` | `fixtures`, `ask`, `kg` (the fixture, prediction, report and question schemas) |
| `@marinoscar/kvox-contract` | `>=0.0.0-0 \|\| >=0.1.0-0` | `fixtures`, `kg` (the ontology registry), `ask` (the Ask wire types) |
| `@marinoscar/kvox-api` | `>=0.0.0-0 \|\| >=0.1.0-0` | `kg` (the extraction pipeline, `graph-extraction` and `graph`), `live` and `cli` (`KvoxAiPort`, `KvoxAiError`) |
| `@marinoscar/kvox-ai` | `>=0.0.0-0 \|\| >=0.1.0-0` | `live` (`createKvoxAi`, `createDirectRuntime`) |
| `@marinoscar/platform-api` | `0.1.0-next.5` (exact, the repository's platform pin) | `live` and `cli`: the OpenAI and OpenAI-compatible adapters. Only `@marinoscar/platform-api/ai`, as in `@marinoscar/kvox-ai`; an interim peer until the lean adapter package of #578. |

`@marinoscar/kvox-api`'s graph slices bring their own peers (Nest, among others). The per-slice data is `packages/kvox-slice-peers.json`; `node scripts/kvox-packages/check-slice-peers.mjs --table` prints it.

## Quick start

The harness self-test, and a score of predictions written earlier:

```bash
kvox-eval kg --predictions gold                 # 1.000 everywhere, or the scorer has a bug
kvox-eval kg --predictions ./runs/2026-10-17 --only m01,m07 --json report.json
```

A live run over the model port (the key comes from the environment only):

```bash
export KVOX_EVAL_OPENAI_API_KEY=...             # never a flag; never printed
kvox-eval kg --runner extract --provider openai --model gpt-5-mini --out /tmp/kg-run
kvox-eval kg --runner extract-resolve --provider openai-compatible --base-url http://localhost:8000/v1 --model local-model
```

From code:

```ts
import { createLiveKvoxAi, formatReport, readEvalApiKey, runKgEval } from '@marinoscar/kvox-eval';
import { loadGoldenMeetings } from '@marinoscar/kvox-eval/fixtures';

const gold = await runKgEval({ runner: 'gold' });
console.log(formatReport(gold));

const key = readEvalApiKey(process.env);
const { ai } = createLiveKvoxAi({ provider: 'openai', model: 'gpt-5-mini', apiKey: key?.apiKey ?? null });
const live = await runKgEval({ runner: 'extract', ai, model: 'gpt-5-mini', fixtures: ['m01'] });

loadGoldenMeetings(['m01', 'm07']); // the fixtures themselves
```

## Configuration

Environment only, read by the `live` slice and the CLI:

- `KVOX_EVAL_OPENAI_API_KEY`: the key of a live run. `KG_EVAL_OPENAI_API_KEY` and `ASK_EVAL_OPENAI_API_KEY` are read for one more release, with a one-line deprecation note on standard error.
- `KG_EVAL_REAL_DIR`: stands in for `--real-dir`.

No settings key and no file. The models a live run uses are the command line's (`--provider`, `--model`, `--base-url`).

## Extension-point catalog

- `KgEvalRunner`: one fixture to one prediction. Register a factory in `KG_EVAL_RUNNERS` (a test's stub runner does) and it becomes `--runner <name>`.

## Data

The golden set, shipped in the tarball under `fixtures/kg-golden/`: 36 synthetic meetings (`meetings/mNN-<slug>.json`) and the Ask question file (`ask-questions.json`). **Synthetic only, ever**: no real recording, transcript, note, name, company, email address or phone number belongs there (the rule, the format and the coverage the set must keep: [fixtures/kg-golden/README.md](fixtures/kg-golden/README.md); `test/kg-golden-fixtures.spec.ts` asserts them). A fixture's and a question's id is permanent once committed. The package owns no table.

## Permissions and settings

None. A live run has no signed-in user: its calls carry the user id `kg-eval` and no organization.

## UI

None.

## Infra

None. A live run reaches the provider's API from the machine it runs on.

## Observability

None: no log, metric or span. The CLI prints the report table to standard output and its notes (missing predictions, where predictions were written, deprecations) to standard error.

## Security notes

- The API key is read from the environment only, never a flag. It is handed to `createDirectRuntime`'s `keys()` per call and never logged, printed, put in an error or written into a prediction or a report (a prediction carries `model` alone). A failed live call is reported by its `KvoxAiError` class, the platform error code and the HTTP status, never a message body.
- Real meetings never enter the repository: `--real-dir`, `--out` of a real-data run and `KG_EVAL_REAL_DIR` are refused (exit 3) when they resolve inside the git work tree, symlinks included (`assertOutsideRepo`).
- The golden set is synthetic; its spec rejects a real-looking email address, a phone number and the product's name.
- The source imports no Prisma, no `@app/shared`, and of the platform only `@marinoscar/platform-api/ai` (rule `host-neutral` of `npm run check:kvox-slice-peers`).

## Conformance suite

None of its own to export. The package's specs (`npm run test:run -w @marinoscar/kvox-eval`) pin the scorer case by case, the golden set's validity and coverage, the extraction runners over a fake port (`createFakeKvoxAi` of `@marinoscar/kvox-api/testing`), the Ask question file and scorer, `runKgEval`, the key aliases, the copilot refusal and the real-data guard. The gold self-test (`kvox-eval kg --predictions gold`) must print 1.000 everywhere.

## Upgrade notes

First release. For code that imported these files from the web app: `apps/api/scripts/kg-eval/{fixture-schema,load,domains}.ts` are `@marinoscar/kvox-eval/fixtures`; `prediction-schema`, `scorer`, `report`, `targets`, `text`, `gold-runner`, `runner` and `runners/*` are the root; `apps/api/scripts/ask-eval/{question-schema,scorer,report}.ts` are the root. `loadPredictionFile` moved from `load.ts` to the root. A runner factory now takes `{ ai }` and a runner no longer receives `apiKey`. `KG_EVAL_API_KEY_ENV` is `KVOX_EVAL_API_KEY_ENV` (`KVOX_EVAL_OPENAI_API_KEY`). `assertOutsideRepo`'s option is `allowInside: <dir>` (the web app keeps its `allowSyntheticRunsDir` wrapper).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '@marinoscar/kvox-eval'` in `apps/api` | Build the packages first: `npm run build:kvox-packages`. |
| `reads its API key from KVOX_EVAL_OPENAI_API_KEY; it is not set` | Export the key in the shell that runs the command; it is never a flag. |
| `the 'copilot' provider is not available yet` | The Copilot adapter arrives with #581; use `--provider openai` or `openai-compatible`. |
| `real meeting data must never be written inside the repository` (exit 3) | Point `--real-dir` / `--out` outside the git work tree. |

## Links

- The package standard: [docs/PACKAGES.md](../../docs/PACKAGES.md)
- The quality bar the report checks: [docs/specs/ontology.md](../../docs/specs/ontology.md) (§6)
- Consuming the packages from KVox Desktop (which runs the same evaluation over its own binding of the model port): [docs/guides/kvox-desktop.md](../../docs/guides/kvox-desktop.md)
- The model port: [packages/kvox-api/src/ports/README.md](../kvox-api/src/ports/README.md); its implementation: [packages/kvox-ai/README.md](../kvox-ai/README.md)
- Dev commands: `npm run build -w @marinoscar/kvox-eval`, `npm run typecheck -w @marinoscar/kvox-eval`, `npm run test:run -w @marinoscar/kvox-eval`, `npm run docs -w @marinoscar/kvox-eval`
