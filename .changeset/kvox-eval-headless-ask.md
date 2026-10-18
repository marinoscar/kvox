---
"@marinoscar/kvox-eval": minor
---

Add the headless Ask evaluation (#608): the `ask-run` slice (`runAskEval`, `runAskReplay`, `startAskEvalHost`, `seedGoldenGraph`) runs the golden question set through the real `ask.respond` handler on an in-memory PGlite migrated with the platform and domain history, seeding the golden graph through `GraphWriteService`; `kvox-eval ask` (`--provider`, `--model`, `--base-url`, `--only`, `--category`, `--out`, `--min-match`, `--replay`) replaces the stub. New required peers: `@electric-sql/pglite`, `@electric-sql/pglite-pgvector`, `@electric-sql/pglite-socket`, `@prisma/client`, `@prisma/adapter-pg`, `pg`, `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs`.
