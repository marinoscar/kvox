# ask-run

The Ask evaluation, headless: an in-memory PostgreSQL, the golden graph, the real `ask.respond` handler, over any model port.

## Purpose and scope

`runAskEval({ ai, model, questions?, fixtures?, minMatch?, log? })` starts the host, seeds the golden set and runs every selected question through the Ask slice of `@marinoscar/kvox-api` (a conversation from `AskConversationsService`, the post through the real `AskMessagesService`, then `AskRespondHandler.process(job)` called directly), capturing every `chat()` request the port receives; it returns the answers, the `idMap`, the seeder's report, the scores and the report of the `ask` slice. `runAskReplay()` is the harness's self-test: the six scripted questions of `ASK_REPLAY_SCENARIOS` on a scripted runtime (`createScriptedRuntime` under `createKvoxAi`, model `openai`/`gpt-replay`), checked for citation validity, completion and the sensitive-fact leak gate.

The lower levels: `startAskEvalHost({ ai })` (PGlite with `vector`, `pg_trgm` and `uuid-ossp`, every shipped migration applied in process, a loopback `PGLiteSocketServer` and a one-connection `PrismaPg` client; the default organization adopted, the evaluation user created; a Nest application context of the transcription, search, transcripts, notes, graph and Ask slices with their optional features off), `startAskEvalSession` (the host plus the seeded graph and an `ask(question, model)` turn), `seedGoldenGraph(host, fixtures)` (every entity, alias, relation, item, citation and supersession through `GraphWriteService` with the user's effective schema, one transaction per fixture; refusals are reported, never dropped) and the ports (`createAskEvalSettings`, `createAskEvalJobs`, `createAskEvalIdentity`).

What a run does:

- The database is an in-memory PGlite, migrated by applying the shipped migration SQL in order. It never touches a real database and dies with the process.
- The golden graph is seeded through `GraphWriteService`: 52 meetings, 214 entities, 330 relations, 209 items, 965 evidence, 0 refused. An item gets a `meetingId` only where the ontology has the column. The personal domain is turned on for the eval user when fixtures are personal-tagged (Ask still hides personal facts). Supersession goes through `supersedesId`. Semantic search is off (no embeddings).
- A failed model call marks that turn failed and the run continues; when every turn fails, `kvox-eval ask` exits 2.
- `kvox-eval ask --replay` needs no key: the 6 scripted questions plus the leak gate, reproducing `apps/api/test/ask/ask-eval.replay.db.spec.ts`.

Not here: extraction and RDF (the graph is the fixtures' hand labels), any real database (the run is in memory and dies with the process), the pure scoring (`ask` slice).

Status: issue #608 (from the web app's `apps/api/scripts/ask-eval/run.ts` and `seed-graph.ts`, #382). `kvox-eval ask` is headless; `npm run ask:eval --workspace=api` is a thin wrapper (its `--keep` and `--allow-db` flags are accepted and ignored).

## Entry point

`@marinoscar/kvox-eval/ask-run` (kept off the package root, which stays light for the pure scorer; `kvox-eval ask` loads it only when run); the root entry does not export `ask-run`. It also holds the command itself, `runAskCommand`, whose flags and exit codes (0 ok, 1 a gate failed, 2 configuration or every call failed) are in the [package README](../../README.md#quick-start). The schema, migrations and client it runs on are built into `host/` by `scripts/prepare-host.mjs` (the package's `build`, `typecheck` and `test` run it first) and shipped in the package.

## Peer dependencies

`@electric-sql/pglite` (0.5.10), `@electric-sql/pglite-pgvector` (0.0.11), `@electric-sql/pglite-socket` (0.2.13), `@prisma/client`, `@prisma/adapter-pg`, `pg`, `@nestjs/common`, `@nestjs/core` (with `reflect-metadata` and `rxjs`), `zod`, `@marinoscar/kvox-api` (the slices and `testing`), `@marinoscar/kvox-ai` (`createKvoxAi`, and `testing` for the replay), `@marinoscar/kvox-contract` (types) and `@marinoscar/platform-api` (only `@marinoscar/platform-ai-providers`, the provider event types of the replay). The domain slices' own peers (`@nestjs/swagger`, `nestjs-zod`, `graphology` and so on) are `@marinoscar/kvox-api`'s.

## Configuration

No environment variable of its own; the command reads `KVOX_EVAL_OPENAI_API_KEY` only (the `live` slice). The model port is the caller's (`createLiveKvoxAi` of the `live` slice, or a scripted one), and every setting is fixed (graph switch on, no spend caps, no reasoning parameter, semantic search off).

## Extension-point catalog

None: a caller passes its own `KvoxAiPort`.
