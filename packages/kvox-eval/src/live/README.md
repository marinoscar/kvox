# live

The model port a live evaluation runs on, and where its key comes from.

## Purpose and scope

`readEvalApiKey(env, warn?)` reads `KVOX_EVAL_OPENAI_API_KEY`, or one of the deprecated `KG_EVAL_OPENAI_API_KEY` / `ASK_EVAL_OPENAI_API_KEY` with a one-line note naming the variable (never the value). `createLiveKvoxAi({ provider, model, apiKey, baseUrl? })` returns `createKvoxAi` over `createDirectRuntime` and `staticTaskModelSource` (AI on, one enabled model, no reasoning parameter), plus a `failures` log of each failed round trip's error code and HTTP status. `assertLiveProvider` refuses `copilot` (its adapter arrives with #581) and unknown ids. `platformAdapter` builds the platform's OpenAI or OpenAI-compatible adapter outside Nest.

Status: issue #580. `platformAdapter` reads the adapter class off the platform module's metadata because `@marinoscar/platform-api/ai` exports the modules, not the classes (`PLATFORM-ADOPTION-SHIM(#578)`).

## Entry point

`@marinoscar/kvox-eval` (the package root re-exports this slice).

## Peer dependencies

`@marinoscar/kvox-ai` (`createKvoxAi`, `createDirectRuntime`), `@marinoscar/kvox-api` (`KvoxAiPort`) and `@marinoscar/platform-api` (only `@marinoscar/platform-api/ai`).

## Configuration

`KVOX_EVAL_OPENAI_API_KEY` (and the two deprecated names, for one release).

## Extension-point catalog

None: a test passes its own `adapters` to `createLiveKvoxAi`.
