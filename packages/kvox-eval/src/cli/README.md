# cli

The `kvox-eval` command.

## Purpose and scope

`kvox-eval kg` (`runKgCommand`) scores knowledge-graph extraction: `--predictions <dir|gold>` or `--runner extract|extract-resolve` (`--run` is accepted) with `--provider openai|openai-compatible|copilot`, `--model`, `--base-url`, plus `--only`, `--tag`, `--json`, `--out`, `--enforce` and `--real-dir`. Exit codes (`KG_EVAL_EXIT`): 0 ok, 1 `--enforce` and a target failed, 2 usage, runner, load, a refused provider or a failed live call, 3 a real-data path inside the repository. `kvox-eval ask` exits 2: the headless Ask run is not available yet (`npm run ask:eval --workspace=api`). `main` and `runKgCommand` take their output streams and environment as arguments; the web app's `npm run kg:eval` calls `runKgCommand` under its own name with its own synthetic runs directory.

Status: issue #580.

## Entry point

`@marinoscar/kvox-eval` (the package root re-exports `runKgCommand`, `main` and the usage texts); the `bin` is `dist/cli/main.js`.

## Peer dependencies

`@marinoscar/kvox-api` (`KvoxAiError`) and `@marinoscar/platform-api` (only `@marinoscar/platform-api/ai`, a type). It imports the `fixtures`, `kg`, `live` and `real-data` slices.

## Configuration

`KVOX_EVAL_OPENAI_API_KEY` (via the `live` slice) and `KG_EVAL_REAL_DIR`.

## Extension-point catalog

None.
