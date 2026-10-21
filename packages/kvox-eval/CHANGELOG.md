# @marinoscar/kvox-eval

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
