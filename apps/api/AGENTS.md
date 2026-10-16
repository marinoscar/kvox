# apps/api rules

Root rules ([AGENTS.md](../../AGENTS.md)) apply. This file is what to get right when editing the NestJS API. Endpoint reference: [docs/API.md](../../docs/API.md) (by `###` group); testing: [docs/TESTING.md](../../docs/TESTING.md).

## Layout

- `src/<module>/` per feature (`transcripts`, `notes`, `graph`, `ask`, `user-data`, `onboarding`, `notifications-registry`, `email-templates`, ...). Job handlers live in the owning module's `handlers/`.
- `prisma/schema.prisma` is one hand-edited file; `prisma/migrations/` holds the SQL. `test/` holds integration specs; `*.db.spec.ts` need real Postgres (`npm run test:db --workspace=api`).

## Rules

- **Every route declares `@Auth()`** and, where it has a permission, the exact string the card/UI uses. A route with no permission is ownership-scoped (`/api/pat`, `/api/ai-credentials`, `/api/user-data`, `/api/onboarding`). Add routes to RBAC coverage in `test/rbac/`.
- **Validate input with Zod** DTOs; annotate OpenAPI; run `npm run openapi:dump && npm run openapi:lint` from the repo root after route changes.
- **Adding an endpoint**: controller method (auth/RBAC decorators), service method (all business logic), OpenAPI annotations, unit + integration tests, update `docs/API.md`.
- **Adding a setting**: a `system_settings` or `user_settings` namespace is one declaration (with its `merge`) appended to `src/app-registrations/settings.ts`; the platform settings slice composes schemas and OpenAPI from the registries (`src/settings/registry/`). No local settings services or DTOs. See [DEVELOPMENT.md](../../docs/DEVELOPMENT.md#settings-namespace-registry).
- **Secrets** go through the platform `CredentialsService` (`src/platform/credentials/`), never a local cipher. A credential purpose is its sub-key domain: never rename one.
- **Long-running work is a queue job** (root rules 1-4). The queue is `@marinoscar/platform-api/jobs`; recipe: the [`add-job-type` skill](../../.claude/skills/add-job-type/SKILL.md). Handlers declare their own `label`; pass `orgId` explicitly on every enqueue. Onboarding steps and user-data categories: declare in the domain module plus a manifest line. Enqueue later-registered types only behind a registry guard, or they sit `pending` forever.
- **`notify()` after commit**, outside any `$transaction`; recipe: the [`add-notification` skill](../../.claude/skills/add-notification/SKILL.md). `NotificationsService` is the platform's (`@marinoscar/platform-api/notifications`); register events in `src/notifications-registry/`, templates in `src/email-templates/`. Use `notifyAddress` for recipients with no account.
- **Prisma**: use `npm run prisma:*`, never bare `npx prisma`. Partial unique and expression indexes are hand-written in `migration.sql` only (intentional drift, see root Invariants).
- **A behaviour change carries tests** in the same or the next commit. Specs run through `scripts/jest.js`; `npm test` skips `*.db.spec.ts`.

## Domain rules

- **Transcripts** ([spec](../../docs/specs/transcription.md)): `src/transcripts/editing/` stays pure (no `PrismaService`, `@Injectable`, `randomUUID()`); `transcript.find_replace` expands into concrete `segment.update_text` ops with every server-chosen id fixed before recording; a snapshot is a compaction, never a second source of truth.
- **`transcription.poll` re-enqueues itself with `skipDedup: true`** (`TranscriptPipelineService.enqueuePoll`, pinned by its spec). Without it the enqueue returns the running row, no backoff is scheduled and the transcript sits in `submitted` forever with no error.
- **Domain failures do not spend a job attempt** (`ProviderAuthError`, `ProviderInputError`): set `failure_reason`, return normally. A 429 throws `RateLimitError`, deferred via the shared `'transcription-provider'` throttle key.
- **Exporters cost one class** (`src/transcripts/export/`, `TranscriptExporterRegistry`, `onModuleInit` self-registration); nothing in a controller or handler branches on a format string. `transcript.export` and `note.export` stay server-only (renderers live in the API).
- **Notes** ([spec](../../docs/specs/notes.md)): the SSE stream is a view over `note_generations.content`, never the delivery mechanism; `note.generate` is `maxAttempts: 1` (regenerate is the retry); the throttle key is per user (`aiProviderThrottleKey(userId)` in `src/notes/job-types.ts`); over-budget prompts are refused with numbers, never truncated.
- **AI keys**: per user in `user_ai_credentials`, never in `credentials`; `AiTaskModelResolver` is the one place that resolves provider, model and effort.
- **User data** ([spec](../../docs/specs/user-data-deletion.md)): `user.data.purge` clears `Restrict` FKs first, never catches an FK violation, and fans out to `transcript.purge`/`note.purge`/`ObjectsService.delete`; it deletes no bytes itself. `confirmation` is the scope uppercased.
- **Onboarding** ([spec](../../docs/specs/onboarding.md)): completion is derived on every read; a step never issues its own query. Permissionless `@Auth()` routes leave `request.requestUser` unset, so go through `normalizeCaller`/`toRequestUser` (`src/onboarding/onboarding.service.ts`) or permissioned steps silently vanish.
- **Graph** ([spec](../../docs/specs/ontology.md)): every write through `GraphWriteService` (`src/graph/write/`), only `kg.migrate` excepted; evidence on every accepted/edited row (`kg_assert_has_evidence`, write subject and evidence in one transaction); `kg.purge` is re-entrant and `maxAttempts: 1`; speaker naming writes the graph only via `kg.speaker_link`; `kg.graph_layout` coalesces 120 s (`GRAPH_LAYOUT_COALESCE_MS`); RDF libs (`n3`, `jsonld`, `rdf-validate-shacl`) only in their allowed files. Edit ontology sources in `packages/shared/src/ontology/`, run `npm run build:ontology --workspace=@app/shared`, commit the compiled output with the source.
- **Ask** (`src/ask/`): `ask.respond` is `maxAttempts: 1`; text before a tool call is held and discarded (`answer-hold.ts`); every write is `WHERE status = 'streaming'`; the handler imports no write service.

Run: `npm test --workspace=api`, `npm run test:db --workspace=api`, `npm run typecheck --workspace=api`.
