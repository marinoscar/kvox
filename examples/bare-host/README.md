# Bare host

A minimal NestJS (Fastify) application that hosts the KVox domain without being the KVox web edition: it installs the **packed** `@marinoscar/kvox-contract`, `-db` and `-api` tarballs, does **not** install `@marinoscar/platform-api`, binds every host port to a small local implementation, migrates an embedded PostgreSQL, boots the transcription, search, transcripts and notes slices and passes one recording through all of them over real HTTP. CI runs it on two databases: a `pgvector/pgvector:pg16` container and PGlite.

It is the first host that is not the web edition, so it is where a port that leaks a platform assumption shows up (a foreign key to a table the host does not create, a closed list, an optional peer that is really required) instead of months later in KVox Desktop. The local port implementations in `src/ports/` are reference code, not a package: the Desktop guide ([#506](https://github.com/marinoscar/kvox/issues/506)) takes them as a starting point. Epic: [#498](https://github.com/marinoscar/kvox/issues/498), this issue: [#505](https://github.com/marinoscar/kvox/issues/505). Package standard: [PACKAGES.md](../../docs/PACKAGES.md); the ports: [kvox-ports.md](../../docs/specs/kvox-ports.md).

## What it proves

A workspace link resolves everything through the monorepo, so it hides what a published package gets wrong. `run.mjs` copies this project to a directory **outside the repository**, installs the tarballs, and then:

| Risk a workspace link hides | How the smoke app shows it is absent |
|---|---|
| A file missing from a package's `files`, a wrong `exports` condition, a missing `.js` extension | `npm install` of the tarballs, then `tsc` (NodeNext, CommonJS) and Node load every entry the host uses (`core`, `ports`, `testing`, `transcription`, `transcription/testing`, `search`, `transcripts`, `notes`, `notes/templates`, `/contract`, `-db`) |
| A dev-only dependency, or a declaration that needs a package the host does not have | `skipLibCheck: false`: the host typechecks the packages' own `.d.ts` files |
| A duplicated singleton (Nest, Zod, the contract, Prisma) | `scripts/kvox-packages/check-single-instance.mjs` over the temporary project |
| A platform package that came in through the side door | `node_modules/@marinoscar/platform-api` and `platform-web` must not exist (asserted right after the install) |
| An optional peer that is really required | `pdfkit`, `docx`, `unpdf` and `@nestjs/schedule` are not installed (asserted) and the application boots and runs; `forRoot` switches the features that need them off |
| An app that uses a slice without listing its peers | `scripts/kvox-packages/check-slice-peers.mjs --app <project>` (rule 5) |
| A host table or foreign key the host must satisfy | The platform and domain history is applied to an **empty** database, and `kvox-db check --database` passes (extensions, the 17 raw-SQL indexes, the 4 constraint triggers) |
| A closed list (a provider id outside the built-in ones) | The transcription provider is a host-registered `fake` selected through the settings |
| A real-database claim that only a mock proved | The nine end-to-end steps below run against PostgreSQL 16 with pgvector and against PGlite |

## Run it

```bash
# From the repository root: build and pack the three packages the host installs.
npm ci && npm run build:kvox-packages
mkdir -p /tmp/kvox-tarballs
for p in contract db api; do npm pack -w @marinoscar/kvox-$p --pack-destination /tmp/kvox-tarballs; done

# PGlite: nothing else to start.
node examples/bare-host/run.mjs --from tarballs /tmp/kvox-tarballs --db pglite

# PostgreSQL with pgvector (a role that may create databases and extensions).
docker run -d --name kvox-pg -e POSTGRES_PASSWORD=pg -p 5433:5432 pgvector/pgvector:pg16
DATABASE_URL=postgresql://postgres:pg@127.0.0.1:5433/postgres \
  node examples/bare-host/run.mjs --from tarballs /tmp/kvox-tarballs --db service
docker rm -f kvox-pg
```

```
node examples/bare-host/run.mjs [--from pack|tarballs <dir>|registry <tag>] [--db service|pglite] [--keep] [--dir <dir>]
```

| Option | Meaning |
|---|---|
| `--from pack` | Default. `npm pack` the three workspace packages (build them first). |
| `--from tarballs <dir>` | Use the `marinoscar-kvox-{contract,db,api}-*.tgz` already in `<dir>`. What CI does. |
| `--from registry <tag>` | Install `@marinoscar/kvox-*@<tag>` from the registry (a published `next`). |
| `--db service` | Default. `DATABASE_URL` names the server; a throwaway database is created on it and dropped afterwards. |
| `--db pglite` | An in-process PGlite served on a loopback socket. |
| `--keep` | Keep the temporary project and print its path (`node dist/main.js` there boots the application). |

Exit code 0 when every step passed, 1 when a step failed, 2 on a usage error. The runner refuses a temporary directory inside the repository (set `TMPDIR` elsewhere). The steps, in order: copy and rewrite the manifest (the three kvox specs; the `@marinoscar/platform-db` pin must equal the repository's, because `check:platform-pin` does not read this folder), `npm install`, assert nothing forbidden is installed, `scripts/prepare-db.mjs`, `tsc`, `npm test -- --db <leg>`, `check-single-instance`, `check-slice-peers --app`. A full run takes about a minute and a half, most of it the install.

To poke at the application by hand, keep the project and start it:

```bash
node examples/bare-host/run.mjs --from tarballs /tmp/kvox-tarballs --db pglite --keep   # prints the path
cd /tmp/kvox-bare-host-XXXXXX/app && BARE_HOST_DB=pglite node dist/main.js               # prints BARE_HOST_URL=...
curl -H 'x-local-user: 1' "$BARE_HOST_URL/api/transcription/config"
```

## The end-to-end test

`test/happy-path.e2e.test.ts` drives the application with `fetch`, one recording through the domain. The application is loaded from `dist/` with `require`, not through Vitest's transformer: Nest's dependency injection needs the decorator metadata `tsc` emits.

1. `GET /api/transcription/config` answers **401** without `x-local-user: 1` and `available: true` with it.
2. `POST /api/transcripts` creates the transcript and answers the upload init with the part URLs.
3. The fixture bytes are PUT to the part URL (a tampered signature is refused first), then `POST /api/storage/objects/{id}/upload/complete` seals the upload.
4. The jobs are drained; `GET /api/transcripts/{id}` is `ready` and the segments equal the fake provider's script.
5. `POST /api/transcripts/{id}/operations` with a `segment.update_text`; the version rises.
6. `POST /api/notes` from the transcript; after the drain the note is `ready`, its body is the fake model's text and `GET /api/notes/{id}/stream` replays `delta` then `done`.
7. After the `search.index` jobs, `GET /api/search?q=zebracorn` finds the note and the transcript on full text with `semanticReason: embeddings_unavailable` (the fake model reports no embeddings), and the index state records why nothing was embedded.
8. `POST /api/transcripts/{id}/exports` `{ "format": "markdown" }`; after the drain the signed download URL serves the corrected text.
9. `DELETE` the note and the transcript; after the drain the rows and the files are gone.

`test/local-ports.test.ts` holds the local ports to the promises of the ports spec, one rule each: job dedup and `skipDedup`, retries up to `maxAttempts` and the settled listeners, a rate limit that defers without spending an attempt and `runNow`, `enqueueWithin` joining a transaction, an object store that refuses keys leaving its folder, is idempotent on a key, lists a module's files and signs URLs that reject a tampered, foreign or expired signature, settings that keep versions and merge patches across a restart, and the 401 of every guarded route.

## The ports

Ten ports, each bound to a small class (or a package fake) in `src/bootstrap.ts` and handed to `KvoxPortsModule.forRoot` in `src/app.module.ts`. **Desktop takes this as a starting point** means: keep the contract (the ports spec and the conformance kit are the definition of correct), replace what the note names.

| Port | Implementation | Notes for Desktop |
|---|---|---|
| `KVOX_OBJECT_STORE` | `src/ports/local-fs-object-store.ts` and `src/local-store.controller.ts`: every object is a `storage_objects` row (the domain tables reference it) and a file under `.data/objects/<key>`. `initUpload` returns `http://127.0.0.1:<port>/local-store/parts/<id>/<n>?exp=&sig=` URLs served by a Fastify route; the signature is an HMAC with a random per-process key and a 15-minute expiry; `completeUpload` concatenates the parts, marks the row `ready` and fires `onUploaded`. The route rejects non-UUID ids; the store refuses `..`, absolute and NUL keys. | Keep the row: `transcripts.source_object_id` and the others are foreign keys to it. `managedBy` is a reserved key of the row's `metadata` (the web edition keeps it in a side table). A desktop shell may let the renderer write straight to disk and call `adopt`, instead of loopback part URLs. |
| `KVOX_JOBS` | `src/ports/pg-table-jobs.ts`: an in-process runner over the platform `jobs` table. `enqueue` inserts with a `dedup_key` and `ON CONFLICT DO NOTHING` against the platform's partial unique index; `drain()` claims with `FOR UPDATE SKIP LOCKED` (one statement, no transaction held while a handler runs), writes `succeeded` or `failed`, honours `scheduled_for`, `skipDedup`, `maxAttempts` and `KvoxRateLimitError`, and fires `onSettled` after the write. A 200 ms loop calls it; tests call it directly. | A job is a real row because `kg_proposals.job_id`, `ask_messages.job_id` and `kg_exports.job_id` reference it. Not here: `maxRuntimeMs` is not enforced, a failed attempt retries at once, and a crash leaves a `running` row nothing resets (the platform queue has a lease and a reaper). The two housekeeping crons are not scheduled (`schedules: false`): call `TranscriptsHousekeepingEnqueuer.enqueue()` and `NotesHousekeepingEnqueuer.enqueue()` on a timer. |
| `KVOX_IDENTITY` | `src/ports/local-single-user-identity.ts`: one seeded user holding every permission, recognised by the header `x-local-user: 1`; `null` without it, so every 401 stays tested. | No header on a real desktop: a loopback server with a per-launch token the shell hands to its own window. The principal must name a real `users.id` and `organizations.id`. |
| `KVOX_SETTINGS` | `src/ports/file-settings.ts`: one JSON file, versions for the system scope, JSON Merge Patch, schema-validated before anything is written, atomic rewrite. A missing row reads as the defaults at version 0. | Same file in the user's application-data folder, or a table. |
| `KVOX_SECRETS` | `src/ports/memory-secrets.ts`: a map; `status` never returns material. | The operating-system keychain. |
| `KVOX_AI` | `createFakeKvoxAi` from `@marinoscar/kvox-api/testing`, scripted to stream a fixed note body and to report `embeddings: null`. | The Copilot SDK adapter (guide, #506). |
| `KVOX_NOTIFY` | `createRecordingKvoxNotify` from `/testing`. | Operating-system notifications. |
| `KVOX_PRISMA` | A `PrismaClient` over `@prisma/adapter-pg` (a pool of one on PGlite). | The same, or an in-process PGlite adapter (see below). |
| `KVOX_EVENTS` | The default `KvoxEventEmitterEvents` (no binding). | Same. |
| `KVOX_AUDIT` | The default no-op (no binding). | A local log. |

The transcription provider is `src/fake-provider.ts`: `createFakeTranscriptionProvider` from `@marinoscar/kvox-api/transcription/testing` in a small class, because `extraProviders` takes classes. `src/seed.ts` writes the user and adopts the default organization the platform migrations create, seeds the built-in note templates and, after the application initialised, turns transcription on with the fake provider and a key for it.

`src/app.module.ts` is the whole wiring:

```ts
KvoxPortsModule.forRoot({ ports, brand: { appName: 'BareHost', appSlug: 'barehost' } }),
TranscriptionModule.forRoot({ providers: { assemblyai: false }, extraProviders: [BareHostTranscriptionProvider] }),
SearchModule.forRoot(), SearchIndexingModule.forRoot(),
TranscriptsModule.forRoot({ schedules: false, media: { transcode: false }, exporters: { pdf: false }, peers: { transcription, searchIndexing } }),
NotesModule.forRoot({ schedules: false, exporters: { pdf: false, docx: false }, documentSources: { pdf: false }, peers: { transcripts, searchIndexing } }),
```

What each `false` buys: `schedules` needs no `@nestjs/schedule`, `exporters.pdf` and `documentSources.pdf` need no `pdfkit` and no `unpdf`, `exporters.docx` needs no `docx`, `media.transcode` leaves the ffmpeg transcoder out. The `peers` option hands the slices the very module objects the host imports, so each job handler registers once.

## What the host owes that the ports do not say

Found by this app. Each is now written down where the next host will read it (the ports spec, the slice READMEs, the `kvox-db` README); the fixes in the packages are listed below.

- **Four host tables, not three.** The domain references `users`, `storage_objects` and `jobs` and also `organizations`: `transcripts.org_id` and `storage_objects.org_id` are NOT NULL. The platform migrations create the default organization; the host adopts it (`src/seed.ts`) and puts its id in the principal.
- **The system `ai` settings namespace.** The notes, transcripts (name check) and graph slices read the AI spend caps (`maxInputTokens`, `maxOutputTokens`, `maxDocumentBytes`) from it through the settings port and do not declare it. The host declares it (`src/bootstrap.ts`); without it `POST /api/notes` is a 500.
- **A global `ZodValidationPipe`.** `TranscriptionSettingsController` takes its body as a `nestjs-zod` DTO class (`APP_PIPE` in `src/app.module.ts`).
- **The upload completion route.** `POST /api/transcripts` answers with part URLs and nothing seals the upload: that is the object store's, hence the host's (`LocalUploadsController`, the same path and verbs as the web edition's platform route).
- **Binary request bodies.** Fastify refuses `audio/mpeg` unless a content-type parser is registered, and the signed-URL routes live outside the `/api` prefix (`src/bootstrap.ts`).
- **Row-level security.** `storage_objects` is under forced RLS (`org_id = ...`). This host connects as a superuser, which bypasses it. A host that connects as an ordinary role must set `app.org_id` (or `app.rls_bypass`) per transaction, as the web edition's application role does.

## Fixes this app forced in the packages

1. `@marinoscar/kvox-db` did not create `transcripts.org_id`: the fragment declared the NOT NULL column, the package's history did not (the web app's own migration did), so on a host with no domain history the first `POST /api/transcripts` failed with `column "org_id" of relation "transcripts" does not exist`, and `kvox-db check --database` did not notice. The package now ships `20261016120000_transcripts_org_id`, byte for byte the web app's, which `kvox-db sync` adopts; `organizations` joined `KVOX_HOST_TABLES`.
2. `@marinoscar/kvox-api` declaration files named pdfkit: `export/pdf.exporter.d.ts` of the notes and transcripts slices imports pdfkit's types, so a host that left the optional peer out failed `tsc` with `skipLibCheck: false` (TS2307). The exported drawing helpers now take `KvoxPdfDocument` (`object`).
3. `TranscriptionRuntimeService` resolved `policy.providers[provider.id]` without a default, so a provider registered through `extraProviders` (which has no block in the settings shape) failed every job with `settings ... are not valid: (root)`. It now gets `{}`, as the connection test already did.

Still the web app's and not a gap for this host: `20261016120100_transcript_shares_to_grants` (it moves rows into the platform `grants` table). A fresh host keeps an empty `transcript_shares` table and its enum from the first transcripts migration; nothing reads them.

## PGlite

PGlite 0.5.10 (PostgreSQL 18.6, `vector` 0.8.7, `pg_trgm` 1.6) applies the whole history, 37 platform and 19 domain migrations, in about three seconds: the partial unique indexes, GiST, HNSW, trigram and generated `tsvector` columns, `CREATE INDEX CONCURRENTLY` and the deferred constraint triggers included. `kvox-db check --database` passes against it and so does every test above. What a PGlite host must know (recorded in the `kvox-db` README as well):

- Load `uuid_ossp` with `vector` and `pg_trgm`: the platform's first migration creates it.
- PGlite is one session. `src/db.ts` gives the client a pool of one and the socket one connection; never await a pool query while a transaction holds the connection.
- `@electric-sql/pglite-socket` 0.2.13 closes the connection after any SQL error, so the next query on it fails once with `Connection terminated unexpectedly` (the pool recovers on the one after). The tests never provoke an SQL error on purpose. A host that runs PGlite in its own process should use an in-process driver adapter rather than the socket; the socket stays here because `prisma migrate deploy` and `kvox-db check --database` are separate processes and the leg is meant to exercise the same path as the server.
- PGlite's declarations use the global Emscripten types without depending on them: `tsconfig.json` adds `@types/emscripten`.

## Layout

```
examples/bare-host/
  package.json  tsconfig.json  prisma.config.ts  vitest.config.mts  run.mjs  .gitignore
  scripts/prepare-db.mjs   platform db sync/compose, kvox-db sync --names after-host, compose, prisma generate
  scripts/test.mjs         npm test -- --db <leg>
  src/main.ts  bootstrap.ts  app.module.ts  db.ts  seed.ts  fake-provider.ts  permissions.ts  local-store.controller.ts
  src/ports/               local-fs-object-store, pg-table-jobs, local-single-user-identity, file-settings, memory-secrets
  test/                    happy-path.e2e.test.ts, local-ports.test.ts, fixtures/hello.mp3
```

This folder is not an npm workspace and has no committed lockfile; `prisma/` (fragments, schema, migrations) and `.data/` are generated and git-ignored. The only dependency pinned by hand is `@marinoscar/platform-db`, to the platform version of the repository (`run.mjs` fails when they differ). Out of scope: the graph, graph-extraction, graph-rdf and Ask slices (a follow-up can add them; the graph needs structured-output scripts for the fake model and `rdf-validate-shacl`) and any web UI.
