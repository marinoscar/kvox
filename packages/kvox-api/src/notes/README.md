# notes

AI notes generated from a transcript, another note or an uploaded document, and everything a user does with them: the note and template routes, the live generation stream, document sources, versions and restore, exports in three formats, the ready event, and the six job types behind them, as one Nest module a host configures with `NotesModule.forRoot`.

## Purpose and scope

What the slice owns: `POST/GET/PATCH/DELETE /api/notes` and the routes around a note (the summary, the version list, a version, restore, regenerate, retitle, the stored generation context, the exporter list and the export routes), `POST /api/notes/sources/documents` (a PDF, plain text or Markdown source), `POST /api/notes/import` (a Markdown note export back into a ready note, #585; the parser is `parseNoteMarkdownExport` in `@marinoscar/kvox-contract/notes`), the template routes (`/api/note-templates`, duplicate, preview, hide and unhide), the two server-sent streams (`GET /api/notes/:id/stream` and `GET /api/note-generations/:id/stream`), the six job handlers (`note.generate`, `note.retitle`, `note.source.extract`, `note.export`, `note.purge`, `notes.housekeeping`), the prompt assembly and the title derivation, the access rules (`NoteAccessService`, no access answers 404), the three built-in exporters (Markdown, PDF, Word) with the exporter kit, the structural database types (`data/notes-db.ts`), the built-in template data and an idempotent seed function, `NotesUserDataService` (what a deletion would remove, and how a derived note loses its link), and the housekeeping cron. What it does not own: the tables themselves (installed by `@marinoscar/kvox-db`), the transcript and search slices it builds on (peers), the knowledge graph (the host subscribes to the ready event; the slice imports no graph code), anything that needs the platform (the permission registry, the notification and email layer, the onboarding step, the user-data registry, the settings manifest), and the AI provider keys (the host's AI adapter resolves them per call).

Status: experimental (issue #495). Every export carries `@stability experimental`.

### Quick start

```ts
import { NotesModule } from '@marinoscar/kvox-api/notes';
import { SearchIndexingModule } from '@marinoscar/kvox-api/search';
import { TranscriptsModule } from '@marinoscar/kvox-api/transcripts';

const searchIndexing = SearchIndexingModule.forRoot();
const transcripts = TranscriptsModule.forRoot({ peers: { searchIndexing } });

@Module({
  imports: [
    searchIndexing,
    transcripts,
    NotesModule.forRoot({
      schedules: true,
      peers: { transcripts, searchIndexing },
      appUrl: () => process.env.APP_URL,
    }),
  ],
})
export class DomainModule {}
```

The host binds `KVOX_PRISMA`, `KVOX_OBJECT_STORE`, `KVOX_JOBS`, `KVOX_NOTIFY`, `KVOX_EVENTS`, `KVOX_AUDIT`, `KVOX_AI`, `KVOX_SETTINGS` and `KVOX_IDENTITY` first (`KvoxPortsModule.forRoot`), registers the four permission strings, the two notification events and the email templates (below), and seeds the built-in templates:

```ts
import { seedNoteTemplates } from '@marinoscar/kvox-api/notes/templates';

await seedNoteTemplates(prisma); // idempotent: a second run creates nothing
```

The `/templates` entry has no Nest import, so a plain seed script can load it. A test uses `createKvoxTestingModule` from `@marinoscar/kvox-api/testing` and `createNotesServiceTestFactory` from `@marinoscar/kvox-api/notes/testing`.

### Data

Six tables, installed by `@marinoscar/kvox-db`: `notes`, `note_templates`, `user_hidden_note_templates`, `note_generations`, `note_versions` and `note_exports`. It reads, and never writes, `transcripts` and `transcript_versions` (the source of a note). Objects (an uploaded document, its extracted text, an export) are the object store port's: every one the slice stores is owned by the `notes` module, and a purge deletes only an object it owns.

The slice sees rows through structural types (`KvoxNotesDb` and the row interfaces of `data/notes-db.ts`) and imports no generated client. The host proves its client satisfies them with one compile-time assignment (`apps/api/test/kvox/prisma-shape.typecheck.ts`). The built-in templates are data (`NOTE_BUILTIN_TEMPLATES`) with fixed ids, so the seed is idempotent and never touches a user's copy of one.

### Permissions and settings

- Permissions: `notes:read` and `notes:write` (`NOTES_PERMISSIONS`), `note_templates:read` and `note_templates:write` (`NOTE_TEMPLATES_PERMISSIONS`). The slice exports them as data: it declares nothing to the host, which registers the sets (the web edition: `registerPermissionSet`, org scope, granted to `org_admin`, `contributor` and `viewer`). Every route carries `@KvoxAuth` with one of them. There is no `notes:read_any`; a caller with no access gets a 404, never a 403.
- Settings: none of its own. The deployment's AI spend caps (`ai.maxInputTokens`, `ai.maxOutputTokens`) are read through the settings port.
- Secrets: none. A generation spends the owner's own AI key, resolved by the host's AI adapter per call; no key reaches this slice.
- Notification events: `notes.note_ready` and `notes.note_failed` (`NOTES_NOTIFICATION_EVENTS`, with the email template names `note-ready` and `note-failed`). The slice raises them with `KVOX_NOTIFY.notify` after the write commits, never inside a transaction; the host owns the templates. Keys and template names are persisted: never rename one.
- Domain event: `kvox.notes.note_ready` (`NOTE_READY_EVENT`), published on `KVOX_EVENTS` with `{ noteId, ownerId, version }` once a generation has committed a ready note. It is how a host reacts to a new note without the slice knowing about it (the web edition hands it to its knowledge graph). A listener runs after the commit and its failure never undoes the note.
- Job types (permanent): `note.generate` (server-only, one attempt, ten minutes), `note.retitle` (server-only, one attempt), `note.source.extract` (node-eligible: it carries `nodeResultSchema` and `persistNodeResult`, plus `deriveOutputKey`; three attempts), `note.export` (two attempts), `note.purge` and `notes.housekeeping`. The two AI types spend the owner's own key, so no worker node ever receives it, and they are tried once so a retry cannot bill for text nobody asked to see twice. A provider rate limit throws a `KvoxRateLimitError` on the user's own throttle bucket, so one busy account never parks another's notes.

### Security notes

No access answers 404, never 403, on every route (`NOTE_NOT_FOUND_MESSAGE`). A source the caller can no longer read resolves to no name and is redacted from the stored generation context, so a title or a passage never leaks through a list. Every enqueue states its organization through the jobs port. A domain failure in a handler records the outcome on the row and returns, so it spends no attempt; only an unclassified error is rethrown. The stream is a read-only view of the generation row: the note completes identically with nobody watching. The housekeeping cron only decides whether a sweep is due and enqueues it. An exporter that fails destroys the output stream, so a half-written file never reaches storage looking complete. No export, log line or error carries a provider key, and the PDF and Word documents carry the host's brand name (`KVOX_BRAND`), never a literal.

### Conformance suite

`describeNotesConformance(name, build, { describe, it, expect })` from `@marinoscar/kvox-api/notes/testing` holds a binding to the pipeline's invariants: the six pinned job type strings are registered, `note.generate` and `note.retitle` are server-only, flagged as AI and tried once, `note.source.extract` carries both node members and an output key, every other type is server-only, and `kvox.notes.note_ready` is published exactly once, after the transaction that marks the note ready has committed and never inside it. `describeNoteExporterConformance(exporter, harness)` holds an exporter to the declaration (format, label, media type, extension, option fields and the schema derived from them) and the behaviour (it renders the fixture document, ends its stream, and refuses an unknown option). The package runs both (`test/notes-conformance.spec.ts`), the web application runs them over its own binding (`apps/api/test/conformance.spec.ts`), and the document fixtures (`markdownFile`, `multiPagePdf`, `scannedPdf`) and the export fixtures are also exported from `/testing`.

## Entry point

`@marinoscar/kvox-api/notes`, `@marinoscar/kvox-api/notes/templates` for the built-in template data and the seed function (no Nest), and `@marinoscar/kvox-api/notes/testing` for tests. The slice depends on `ports`, `core`, `transcripts` and `search` (`packages/kvox-slices.json`), and imports `@marinoscar/kvox-contract/notes` for the wire schemas (the `note.source.extract` node result and the ready event payload moved there with this slice so a worker-node package can import them).

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common`, `@nestjs/core` and `zod`, which every slice needs, plus `@nestjs/swagger` and `nestjs-zod` (the controllers' OpenAPI decorators and DTO classes), `@nestjs/schedule` (the housekeeping cron; loaded only when `schedules` is not `false`), `rxjs`, `fastify` (the request and reply types of the multipart upload and the stream; optional), and the optional document libraries `pdfkit` (the PDF exporter), `docx` (the Word exporter) and `unpdf` (reading a PDF source), each loaded on first use. The PDF fonts ship in the package (`assets/fonts`). The per-slice data is `packages/kvox-slice-peers.json`.

## Configuration

`NotesModule.forRoot(options)` returns a non-global dynamic module. It exports `NotesService`, `NoteAccessService`, `NoteOriginService`, `NoteSourceNameService`, `NoteTemplatesService`, `NoteExportService`, `NoteExporterRegistry`, `NotesUserDataService` and `NotesHousekeepingEnqueuer`. The package reads no environment variable.

| Option | Default | What it does |
|---|---|---|
| `exporters` | markdown, pdf and docx on | `{ markdown, pdf, docx }` switch a built-in exporter off; `extra` adds exporter classes (a new format is one class). |
| `documentSources` | pdf and text on | `{ pdf, text }` choose which uploaded document formats can be a source. |
| `pdf.fontDir` | the package's `assets/fonts` | Where the PDF exporter loads its fonts. |
| `stream` | the slice's defaults | `{ flushIntervalMs, flushChars, maxDurationMs }` tune the stream flusher and the connection cap. |
| `schedules` | `true` | `false` registers no `@nestjs/schedule` task; the host calls `NotesHousekeepingEnqueuer.enqueue()` on its own timer. |
| `imports` | none | Extra modules the slice's providers need. |
| `peers` | a fresh `TranscriptsModule.forRoot()` and `SearchIndexingModule.forRoot()` | The very module objects the host imports, so the container sees one module and registers each handler once. |
| `appUrl` | none | Returns the application's base URL for the links in the ready and failed notifications. |
| `maxImportBytes` | 5 MiB | The largest file `POST /api/notes/import` accepts; the multipart read stops there and answers 413. |

The routes document themselves through `documentKvoxAuth` (called by `forRoot`).

## Extension-point catalog

| Symbol | What a host does with it |
|---|---|
| `NotesModuleOptions` | The options of `NotesModule.forRoot`. |
| `NOTE_READY_EVENT`, `NoteReadyEvent` | The domain event a host subscribes to on `KVOX_EVENTS` to react to a ready note (queue an extraction, refresh a feed). |
| `NoteExporter`, `NotesModuleOptions.exporters` | A new format is one class registered through `exporters.extra`; the controller, the service and the job handler do not change. |
| `NOTES_PERMISSIONS`, `NOTE_TEMPLATES_PERMISSIONS` | The four permission strings and their default grants, for the host to register with its permission catalog. |
| `NOTES_NOTIFICATION_EVENTS` | The two notification events, for the host to register with its notification registry (the slice also declares them through `KVOX_NOTIFY` when it starts). |
| `NOTE_BUILTIN_TEMPLATES`, `seedNoteTemplates` | The built-in template data and its idempotent seed, from `@marinoscar/kvox-api/notes/templates`. |
| `NotesUserDataService` | What a deletion would remove (`summary`) and how a note derived from a deleted one loses its link (`clearDerivedReferences`); the host's user-data registry delegates to it. |
| `KvoxNotesDb` | The narrowed client the slice casts `KVOX_PRISMA` to; the host proves its client satisfies it with a compile-time assignment. |
| `NotesHousekeepingEnqueuer` | Queues one housekeeping sweep unless one is in flight; a host without a scheduler calls it itself. |
| `describeNotesConformance`, `describeNoteExporterConformance` | The conformance kits and the bindings they are run against. |

### Desktop

Desktop sets `schedules: false` and calls `NotesHousekeepingEnqueuer.enqueue()` on its own timer; its "Import…" sends a note export to `POST /api/notes/import`, a PDF, text or Markdown file to `POST /api/notes/sources/documents`, and a transcript JSON to `POST /api/transcripts/imports`, as `detectKvoxImport` (`@marinoscar/kvox-contract/notes`) decides; generation needs the Copilot adapter online, while reading and editing work offline. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#jobs-offline).
