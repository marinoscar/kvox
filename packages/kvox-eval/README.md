# @marinoscar/kvox-eval

The KVox knowledge-graph and Ask evaluation: the synthetic golden set, its schemas, the scorers, the report, the gold and live runners, the headless Ask run and the `kvox-eval` command. Written only against the model port, so every host measures the prompts, schemas and validators the product ships. CommonJS.

## Purpose and scope

One package for "how good is extraction (and Ask) on the golden set", shared by the web edition and KVox Desktop. A live run binds the same `KvoxAiPort` every host binds (`createKvoxAi` of `@marinoscar/kvox-ai`, over `createDirectRuntime` and the platform's provider adapters); the extraction pipeline it scores is `@marinoscar/kvox-api`'s own (`graph-extraction` internals), minus the loader and the writer. The package owns no prompt, schema or pipeline of the product.

The Ask run is headless (issue #608): `kvox-eval ask` starts an in-memory PGlite, applies the shipped migration SQL in order, seeds the golden graph through `GraphWriteService` and drives the real `ask.respond` handler, with no web app and no real database. `npm run ask:eval --workspace=api` is a thin wrapper over the same command. Exporting one of your own notes as an unlabelled skeleton (`--export-note`) reads the web app's tables and stays in `apps/api`.

Status: implemented by issue #580 (moved from `apps/api/scripts/kg-eval/`, `apps/api/scripts/ask-eval/` and `apps/api/test/fixtures/kg-golden/`), unreleased like the other packages. The web app's private OpenAI client (`direct-structured.ts`) is deleted; `npm run kg:eval --workspace=api` is a thin wrapper over `runKgCommand`.

Entry points:

- `@marinoscar/kvox-eval`: the package root, which re-exports the `kg`, `ask`, `live`, `real-data` and `cli` slices (not `ask-run`: import the subpath below). The root is still slow to import (about 2 s) because the kg runners import `@marinoscar/kvox-api/graph`. Slice READMEs: [kg](src/kg/README.md), [ask](src/ask/README.md), [live](src/live/README.md), [real-data](src/real-data/README.md), [cli](src/cli/README.md).
- `@marinoscar/kvox-eval/fixtures`: the golden set (`loadGoldenMeetings`, `GOLDEN_MEETINGS_DIR`, `ASK_QUESTIONS_PATH`, `loadGoldenAskQuestions`) and its schema (`goldenFixtureSchema`, `GoldenFixture`). Slice README: [fixtures](src/fixtures/README.md). The data is under [fixtures/kg-golden](fixtures/kg-golden/README.md).
- `@marinoscar/kvox-eval/ask-run`: the headless Ask evaluation (`runAskEval`, `runAskReplay`, `startAskEvalHost`, `seedGoldenGraph`, `runAskCommand`): an in-memory PGlite, the golden graph seeded through the graph write service, the real `ask.respond` handler. Slice README: [ask-run](src/ask-run/README.md).
- `@marinoscar/kvox-eval/parity`: the harness-parity scenario and its committed request snapshots (`parity/requests.*.json`), which prove two bindings of the model port send the same provider requests (`runParityScenario`, `createParityScript`, `loadParitySnapshot`). Slice README: [parity](src/parity/README.md).
- `kvox-eval` (the `bin`, `dist/cli/main.js`): `kvox-eval kg` and `kvox-eval ask`.

## Install and peer dependencies

```bash
npm install @marinoscar/kvox-eval@next @marinoscar/kvox-ai@next @marinoscar/kvox-api@next @marinoscar/kvox-contract@next @marinoscar/platform-ai-providers@0.1.0-next.6 openai zod \
  @electric-sql/pglite@0.5.10 @electric-sql/pglite-pgvector@0.0.11 @electric-sql/pglite-socket@0.2.13 \
  @prisma/client @prisma/adapter-pg pg @nestjs/common @nestjs/core reflect-metadata rxjs
```

Every slice is universal, so every peer is required, including those only `ask-run` imports (PGlite, Prisma, Nest):

| Package | Range | Needed by |
|---|---|---|
| `zod` | `^4.4.3` | `fixtures`, `ask`, `kg` (the fixture, prediction, report and question schemas) |
| `@marinoscar/kvox-contract` | `>=0.0.0-0 \|\| >=0.1.0-0` | `fixtures`, `kg` (the ontology registry), `ask` (the Ask wire types) |
| `@marinoscar/kvox-api` | `>=0.0.0-0 \|\| >=0.1.0-0` | `kg` (the extraction pipeline, `graph-extraction` and `graph`), `live` and `cli` (`KvoxAiPort`, `KvoxAiError`) |
| `@marinoscar/kvox-ai` | `>=0.0.0-0 \|\| >=0.1.0-0` | `live` (`createKvoxAi`, `createDirectRuntime`) |
| `@marinoscar/platform-ai-providers` | `0.1.0-next.6` (exact) | `live` and `cli`: `createOpenAiAdapter` and `createOpenAiCompatibleAdapter` from the `/openai` subpath; `parity`, `ask-run`: the provider event types. Only the package root and `/openai` are imported; `@marinoscar/platform-api` is not a peer and importing it is a violation. |
| `openai` | `^7.23.0` | `live`: the OpenAI SDK that the lean `/openai` factories build their client from. Required, because `live` constructs the SDK client. |
| `@electric-sql/pglite` | `0.5.10` (exact) | `ask-run`: the in-memory PostgreSQL |
| `@electric-sql/pglite-pgvector` | `0.0.11` (exact) | `ask-run`: the `vector` extension the migrations create |
| `@electric-sql/pglite-socket` | `0.2.13` (exact) | `ask-run`: the loopback socket the Prisma client connects to |
| `@prisma/client` | `^7.8.0` | `ask-run`: the client generated into `host/generated` |
| `@prisma/adapter-pg` | `^7.8.0` | `ask-run`: the driver adapter over `pg` |
| `pg` | `^8.23.0` | `ask-run` |
| `@nestjs/common`, `@nestjs/core` | `^11.1.12` | `ask-run`: the application context of the Ask slices |
| `reflect-metadata` | `^0.2.2` | `ask-run` |
| `rxjs` | `^7.8.1` | `ask-run` |

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

The Ask evaluation, headless (in-memory database, golden graph seeded through the graph write service, the real `ask.respond` handler):

```bash
kvox-eval ask --replay                          # the scripted self-test: 6 questions and the leak gate; no key, no network
export KVOX_EVAL_OPENAI_API_KEY=...
kvox-eval ask --model gpt-4o-mini --out /tmp/ask-run
kvox-eval ask --only q01,q22 --category negative --min-match 0.7
kvox-eval ask --provider openai-compatible --base-url http://localhost:8000/v1 --model local-model
```

Flags: `--provider openai|openai-compatible`, `--model`, `--base-url`, `--only`, `--category`, `--out` (writes `report.json` and `answers.md`; `replay.json` for `--replay`), `--min-match <0..1>`, `--replay`. Exit codes: 0 pass, 1 a gate failed (citation validity below 1, a sensitive-fact leak) or the answer match fell below `--min-match` (or a replay expectation failed), 2 configuration (no key, a refused provider, a bad flag, an unknown question id) or every model call failed. One failed model call marks that turn failed and the run goes on. The seeded graph is 36 meetings, 94 entities, 265 relations, 187 items and 731 evidence rows, 0 refused. Semantic search is off (no embeddings). `--replay` reproduces `apps/api/test/ask/ask-eval.replay.db.spec.ts`.

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

```ts
import { runAskReplay } from '@marinoscar/kvox-eval/ask-run'; // never from the root

const replay = await runAskReplay(); // no key; starts and closes its own PGlite
```

## Configuration

Environment only, read by the `live` slice and the CLI:

- `KVOX_EVAL_OPENAI_API_KEY`: the key of a live run (`kg` and `ask`; read only from here, never a flag). `kvox-eval ask --replay` needs none. `KG_EVAL_OPENAI_API_KEY` and `ASK_EVAL_OPENAI_API_KEY` are read for one more release, with a one-line deprecation note on standard error.
- `KG_EVAL_REAL_DIR`: stands in for `--real-dir`.

No settings key and no file. The models a live run uses are the command line's (`--provider`, `--model`, `--base-url`).

## Extension-point catalog

- `KgEvalRunner`: one fixture to one prediction. Register a factory in `KG_EVAL_RUNNERS` (a test's stub runner does) and it becomes `--runner <name>`.

## Data

The golden set, shipped in the tarball under `fixtures/kg-golden/`: 36 synthetic meetings (`meetings/mNN-<slug>.json`) and the Ask question file (`ask-questions.json`). **Synthetic only, ever**: no real recording, transcript, note, name, company, email address or phone number belongs there (the rule, the format and the coverage the set must keep: [fixtures/kg-golden/README.md](fixtures/kg-golden/README.md); `test/kg-golden-fixtures.spec.ts` asserts them). A fixture's and a question's id is permanent once committed. The package owns no table. The `ask-run` slice ships `host/prisma` and `host/generated` (the schema, migrations and Prisma client), generated at build time by `scripts/prepare-host.mjs`; the in-memory database they run on is created per run and discarded.

## Permissions and settings

None. A live run has no signed-in user: its calls carry the user id `kg-eval` and no organization.

## UI

None.

## Infra

None. A live run reaches the provider's API from the machine it runs on. The Ask run needs no database server: it never touches a real database.

## Observability

None: no log, metric or span (the Ask run's Nest context logs errors and warnings only). The CLI prints the report table to standard output and its notes (missing predictions, where predictions were written, deprecations) to standard error.

## Security notes

- The API key is read from the environment only, never a flag. It is handed to `createDirectRuntime`'s `keys()` per call and never logged, printed, put in an error or written into a prediction or a report (a prediction carries `model` alone). A failed live call is reported by its `KvoxAiError` class, the provider error code and the HTTP status, never a message body.
- Real meetings never enter the repository: `--real-dir`, `--out` of a real-data run and `KG_EVAL_REAL_DIR` are refused (exit 3) when they resolve inside the git work tree, symlinks included (`assertOutsideRepo`).
- The golden set is synthetic; its spec rejects a real-looking email address, a phone number and the product's name.
- The Ask run uses an in-memory PGlite only: it has no connection string to a real database, so it cannot read or write one. The key never enters that database.
- Apart from the `ask-run` slice (Prisma, Nest, PGlite), the source imports no Prisma, no `@app/shared`, and of the platform only `@marinoscar/platform-ai-providers` and its `/openai` subpath (rule `host-neutral` of `npm run check:kvox-slice-peers`).

## Conformance suite

None of its own to export. The package's specs (`npm run test:run -w @marinoscar/kvox-eval`) pin the scorer case by case, the golden set's validity and coverage, the extraction runners over a fake port (`createFakeKvoxAi` of `@marinoscar/kvox-api/testing`), the Ask question file and scorer, `runKgEval`, the key aliases, the copilot refusal and the real-data guard. `test/parity.spec.ts` runs the harness-parity scenario over the direct binding and compares it with the shipped `parity/` snapshots (`npm run test:run -w @marinoscar/kvox-eval -- parity`; `KVOX_EVAL_UPDATE_PARITY=1` rewrites them, see [parity](src/parity/README.md)); the web edition's twin is `apps/api/test/kvox/ai-parity.spec.ts`. The gold self-test (`kvox-eval kg --predictions gold`) must print 1.000 everywhere.

## Upgrade notes

First release. For code that imported these files from the web app: `apps/api/scripts/kg-eval/{fixture-schema,load,domains}.ts` are `@marinoscar/kvox-eval/fixtures`; `prediction-schema`, `scorer`, `report`, `targets`, `text`, `gold-runner`, `runner` and `runners/*` are the root; `apps/api/scripts/ask-eval/{question-schema,scorer,report}.ts` are the root. `loadPredictionFile` moved from `load.ts` to the root. A runner factory now takes `{ ai }` and a runner no longer receives `apiKey`. `KG_EVAL_API_KEY_ENV` is `KVOX_EVAL_API_KEY_ENV` (`KVOX_EVAL_OPENAI_API_KEY`). `assertOutsideRepo`'s option is `allowInside: <dir>` (the web app keeps its `allowSyntheticRunsDir` wrapper).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '@marinoscar/kvox-eval'` in `apps/api` | Build the packages first: `npm run build:kvox-packages`. |
| `reads its API key from KVOX_EVAL_OPENAI_API_KEY; it is not set` | Export the key in the shell that runs the command; it is never a flag. |
| `Cannot find module '@electric-sql/pglite'` (or `@prisma/client`, `@nestjs/core`) on `kvox-eval ask` | Install the `ask-run` peers listed above; they are required. |
| `the 'copilot' provider is not available yet` | The Copilot adapter arrives with #581; use `--provider openai` or `openai-compatible`. |
| `real meeting data must never be written inside the repository` (exit 3) | Point `--real-dir` / `--out` outside the git work tree. |

## Links

- The package standard: [docs/PACKAGES.md](../../docs/PACKAGES.md)
- The quality bar the report checks: [docs/specs/ontology.md](../../docs/specs/ontology.md) (§6)
- Consuming the packages from KVox Desktop (which runs the same evaluation over its own binding of the model port): [docs/guides/kvox-desktop.md](../../docs/guides/kvox-desktop.md)
- The model port: [packages/kvox-api/src/ports/README.md](../kvox-api/src/ports/README.md); its implementation: [packages/kvox-ai/README.md](../kvox-ai/README.md)
- Dev commands: `npm run build -w @marinoscar/kvox-eval`, `npm run typecheck -w @marinoscar/kvox-eval`, `npm run test:run -w @marinoscar/kvox-eval`, `npm run docs -w @marinoscar/kvox-eval`
