# cli

The `kvox-eval` command.

## Purpose and scope

`kvox-eval kg` (`runKgCommand`) scores knowledge-graph extraction: `--predictions <dir|gold>` or `--runner extract|extract-resolve` (`--run` is accepted) with `--provider openai|openai-compatible|copilot`, `--model`, `--base-url`, plus `--only`, `--tag`, `--json`, `--out`, `--enforce` and `--real-dir`. Exit codes (`KG_EVAL_EXIT`): 0 ok, 1 `--enforce` and a target failed, 2 usage, runner, load, a refused provider or a failed live call, 3 a real-data path inside the repository. `kvox-eval ask` (`runAskCommand` of the [ask-run](../ask-run/README.md) slice) runs the headless Ask evaluation: `--provider openai|openai-compatible`, `--model`, `--base-url`, `--only`, `--category`, `--out`, `--min-match` and `--replay` (the scripted self-test, no key). Exit codes (`ASK_EVAL_EXIT`): 0 ok, 1 a gate failed or the answer match fell below `--min-match`, 2 configuration or every model call failed. `main` loads the ask slice only when `ask` is the command, so `kvox-eval kg` does not pay for Nest and PGlite. `main` and `runKgCommand` take their output streams and environment as arguments; the web app's `npm run kg:eval` calls `runKgCommand` under its own name with its own synthetic runs directory.

Status: issue #580.

## Entry point

`@marinoscar/kvox-eval` (the package root re-exports `runKgCommand`, `main` and the usage texts); the `bin` is `dist/cli/main.js`.

## Peer dependencies

`@marinoscar/kvox-api` (`KvoxAiError`) and `@marinoscar/platform-ai-providers` (a type). It imports the `fixtures`, `kg`, `live` and `real-data` slices.

## Configuration

`KVOX_EVAL_OPENAI_API_KEY` (via the `live` slice) and `KG_EVAL_REAL_DIR`.

## Extension-point catalog

None.
