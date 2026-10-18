# live

The model port a live evaluation runs on, and where its key comes from.

## Purpose and scope

`readEvalApiKey(env, warn?)` reads `KVOX_EVAL_OPENAI_API_KEY`, or one of the deprecated `KG_EVAL_OPENAI_API_KEY` / `ASK_EVAL_OPENAI_API_KEY` with a one-line note naming the variable (never the value). `createLiveKvoxAi({ provider, model, apiKey, baseUrl? })` returns `createKvoxAi` over `createDirectRuntime` and `staticTaskModelSource` (AI on, one enabled model, no reasoning parameter), plus a `failures` log of each failed round trip's error code and HTTP status. `assertLiveProvider` refuses `copilot` (its adapter arrives with #581) and unknown ids. `platformAdapter` builds the OpenAI or OpenAI-compatible adapter with `createOpenAiAdapter` / `createOpenAiCompatibleAdapter` from `@marinoscar/platform-ai-providers/openai`: plain factories, no Nest.

Status: issue #580; on the lean provider package since #578 (the former read of the adapter class off the platform module's metadata is gone).

## Entry point

`@marinoscar/kvox-eval` (the package root re-exports this slice).

## Peer dependencies

`@marinoscar/kvox-ai` (`createKvoxAi`, `createDirectRuntime`), `@marinoscar/kvox-api` (`KvoxAiPort`) and `@marinoscar/platform-ai-providers` (the root types and the `/openai` factories), plus the `openai` peer the factories need.

## Configuration

`KVOX_EVAL_OPENAI_API_KEY` (and the two deprecated names, for one release).

## Extension-point catalog

None: a test passes its own `adapters` to `createLiveKvoxAi`.
