---
"@marinoscar/kvox-eval": minor
---

Add the headless Ask evaluation (#608). The new `@marinoscar/kvox-eval/ask-run` subpath (`runAskEval`, `runAskReplay`, `startAskEvalHost`, `seedGoldenGraph`, `runAskCommand`) runs the golden question set through the real `ask.respond` handler on an in-memory PGlite migrated with the platform and domain history, seeding the golden graph through `GraphWriteService`. It never touches a real database. `kvox-eval ask` (`--provider`, `--model`, `--base-url`, `--only`, `--category`, `--out`, `--min-match`, `--replay`) replaces the stub that exited 2; `--replay` needs no key. Exit codes are 0, 1 and 2, and the key is read only from `KVOX_EVAL_OPENAI_API_KEY`.

The root entry does not export `ask-run`; import the subpath. The package now ships `host/prisma` and `host/generated`, built by `scripts/prepare-host.mjs`.

New required peers: `@electric-sql/pglite` (0.5.10), `@electric-sql/pglite-pgvector` (0.0.11), `@electric-sql/pglite-socket` (0.2.13), `@prisma/client`, `@prisma/adapter-pg`, `pg`, `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs`.
