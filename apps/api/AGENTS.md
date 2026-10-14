# apps/api rules

Root rules ([AGENTS.md](../../AGENTS.md)) apply, including the queue-job rules. This file is what to get right when editing the NestJS API. Reference: [docs/API.md](../../docs/API.md), [docs/specs/job-queue.md](../../docs/specs/job-queue.md).

## Layout

- `src/<module>/` one Nest module per feature (`transcripts`, `notes`, `graph`, `ask`, `jobs`, `nodes`, `db-backup`, `onboarding`, `user-data`, ...); shared code in `src/common/`.
- `prisma/schema.prisma` is ONE hand-edited file; migrations in `prisma/migrations/`.
- `test/` mirrors features; `*.spec.ts` is mocked, `*.db.spec.ts` needs real Postgres (`test:db`). RBAC coverage lives in `test/rbac/`.

## Rules

- **Every route declares `@Auth()`**; a route without it is public. A web card's `permission` must equal the string the controller enforces.
- **Validate input with Zod DTOs**, annotate with `@ApiOperation`/`@ApiResponse`, and run `npm run openapi:dump --workspace=api` after route changes.
- **Long-running work is a queue job** (root rules). Recipe: [src/jobs/handlers/README.md](src/jobs/handlers/README.md) or the add-job-type skill. A `@Cron` only enqueues (`src/jobs/housekeeping.enqueue.ts`); `test/jobs/cron-enqueue-only.spec.ts` lists the three exemptions.
- **`notify()` after commit**, outside any `$transaction` ([src/notifications/README.md](src/notifications/README.md)).
- **Prisma**: use `npm run prisma:*`, never bare `npx prisma` (they build `DATABASE_URL`). Partial unique indexes and generated columns are hand-written in `migration.sql` only, never `@@unique`; that drift is intentional.
- **System-settings namespace = six edits.** `src/common/schemas/settings-parity.spec.ts` (header) lists them; miss the wire DTOs and every PATCH silently returns 200 doing nothing. User settings: `user-settings-parity.spec.ts`.
- **Adding an endpoint**: controller method with auth/RBAC decorators; service method; OpenAPI annotations; unit + integration tests; update `docs/API.md`.
- **Adding a setting**: Zod schema; migration if structure changes; TS types; frontend UI if user-facing.

## Domain rules

- **Transcript editing** (`src/transcripts/editing/`): pure, no `PrismaService`, no `@Injectable`, no `randomUUID()` in a reducer. `transcript.find_replace` expands into concrete `segment.update_text` ops, with every server-chosen id, before recording. A snapshot compacts replay, never a second source of truth. [transcription.md](../../docs/specs/transcription.md) s4.
- **`transcription.poll`** re-enqueues itself via `TranscriptPipelineService.enqueuePoll` with `skipDedup: true`; without it the transcript sits in `submitted` forever, silently (`transcript-pipeline.service.spec.ts` pins it).
- **Exporters cost one class** (`src/transcripts/export/`): register from `onModuleInit`; no controller, handler or web code branches on a format string.
- **`note.generate` is `maxAttempts: 1`**: a retry would double-bill the user's own key. Regenerate is the only retry. [notes.md](../../docs/specs/notes.md)
- **`aiProviderThrottleKey(userId)`** (`src/notes/job-types.ts`) is per user, never a shared `'ai-provider'` key.
- **Over-budget prompts are refused with numbers** (`AiBudgetError`), never truncated.
- **Per-user AI keys live in `user_ai_credentials`**, not `credentials`: the cascade deletes them with the user.
- **`user.data.purge`** clears `Restrict` FKs first, never catches an FK violation, and fans out to `transcript.purge`/`note.purge`/`ObjectsService.delete`; it deletes no bytes itself. [spec](../../docs/specs/user-data-deletion.md)
- **Onboarding** completion is derived per read, never stored; a step issues no query of its own. A permissionless `@Auth()` route yields an `AuthenticatedUser` with `permissions` undefined: use `normalizeCaller` (`src/onboarding/onboarding.service.ts`). [spec](../../docs/specs/onboarding.md)
- **Graph** ([ontology.md](../../docs/specs/ontology.md)): every `kg_*` write goes through `GraphWriteService` (`src/graph/write/`); the one exception is `kg.migrate` (`src/graph/migrate/`, [runbook](../../docs/runbooks/ontology-migration.md)). `kg.purge` is re-entrant and `maxAttempts: 1`. Speaker naming writes the graph only via `kg.speaker_link`. No orphans: every accepted row cites evidence. `sensitive` PersonFacts never reach a model.
- **`ask.respond`** (`src/ask/handlers/`) appends `ask_messages.content` append-only; pre-tool-call text is held and discarded (`src/ask/answer-hold.ts`); a 429 before any flush resets the row to `pending`.

Run: `npm test --workspace=api`, `npm run test:db --workspace=api`, `npm run typecheck --workspace=api`.
