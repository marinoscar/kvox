---
"@marinoscar/kvox-eval": minor
---

New package `@marinoscar/kvox-eval`: the KVox knowledge-graph and Ask evaluation (#580), written only against the model port (`KvoxAiPort`, bound with `createKvoxAi` of `@marinoscar/kvox-ai`). It moves in from the web app unchanged in behaviour: the synthetic golden set (`./fixtures`: 36 meetings and the Ask question file, with their schema and loaders), the prediction schema, the scorer, the report and the gold, `extract` and `extract+resolve` runners, `runKgEval`, the pure half of the Ask evaluation (question schema, scorer, report), the real-data path guard, and the `kvox-eval` CLI (`kvox-eval kg`; `kvox-eval ask` is not headless yet). Live runs go through `createDirectRuntime` over the platform's OpenAI and OpenAI-compatible adapters with the key from `KVOX_EVAL_OPENAI_API_KEY` (`KG_EVAL_OPENAI_API_KEY` and `ASK_EVAL_OPENAI_API_KEY` are read for one more release); the web app's private OpenAI client is gone.
