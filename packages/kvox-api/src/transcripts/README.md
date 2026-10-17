# transcripts

The transcript pipeline and everything a user does with a transcript: the upload and the nine job types that turn audio into a corrected, versioned, exportable document, the correction routes with their pure editing core, exports, the AI name correction and the access rules, as one Nest module a host configures with `TranscriptsModule.forRoot`.

## Purpose and scope

What the slice owns: `POST/GET/PATCH/DELETE /api/transcripts` and the lifecycle routes (retry, cancel, audio, words, segments, summary, the exporter list), the correction routes (`POST :id/operations`, `GET :id/search`, the version list, a version, restore), exports (`POST :id/exports`, `GET :id/exports/:exportId`, the three built-in exporters and the exporter kit), the AI name check (`POST/GET :id/name-checks...`), the four deprecated `:id/shares` routes (thin adapters over the sharing extension point), the nine job handlers (`media.audio.transcode`, `transcription.submit`, `transcription.poll`, `transcription.ingest`, `transcript.snapshot`, `transcript.export`, `transcript.purge`, `transcript.name_check`, `transcripts.housekeeping`), the upload hook, the job-failure listener, the housekeeping cron, `editing/` (the pure op reducers, which stay free of Nest and the database so `materialize()` replays through the same functions as a live edit), `name-check/` (the pure prompt, parser and estimate code), the structural database types (`data/transcripts-db.ts`) and the export kit (`export/export-kit.ts`). What it does not own: the tables themselves (installed by `@marinoscar/kvox-db`), the speech-to-text providers and their settings (the `transcription` slice, a peer), search indexing (the `search` slice, a peer), anything that needs the platform (the sharing system, the onboarding step, the settings manifest, the notification templates and the email layout, all of which stay in the host), and the user-data deletion entries (the host's registry delegates a transcript purge to the `transcript.purge` job).

Status: experimental (issue #493). Every export carries `@stability experimental`.

### Quick start

```ts
import { TranscriptsModule } from '@marinoscar/kvox-api/transcripts';
import { TranscriptionModule } from '@marinoscar/kvox-api/transcription';
import { SearchIndexingModule } from '@marinoscar/kvox-api/search';

const transcription = TranscriptionModule.forRoot();
const searchIndexing = SearchIndexingModule.forRoot();

@Module({
  imports: [
    transcription,
    searchIndexing,
    TranscriptsModule.forRoot({
      schedules: true,
      peers: { transcription, searchIndexing },
      appUrl: () => process.env.APP_URL,
    }),
  ],
})
export class KvoxModule {}
```

The host binds `KVOX_PRISMA`, `KVOX_OBJECT_STORE`, `KVOX_JOBS`, `KVOX_NOTIFY`, `KVOX_EVENTS`, `KVOX_AUDIT`, `KVOX_AI`, `KVOX_SETTINGS`, `KVOX_SECRETS` and `KVOX_IDENTITY` first (`KvoxPortsModule.forRoot`), and registers the two permission strings and the two notification events (below). A test uses `createKvoxTestingModule` from `@marinoscar/kvox-api/testing`.

### Data

Seven tables, installed by `@marinoscar/kvox-db`: `transcripts`, `transcript_speakers`, `transcript_segments`, `transcript_versions`, `transcript_exports`, `transcript_name_checks` and `transcript_name_suggestions`. It reads, and never writes, `users` (an owner's or an author's display name), `organizations` (the default organization, for a caller with no active one) and `notes` (the delete pre-check: a note generated from a transcript blocks its deletion with a 409 because `notes.source_transcript_id` is `Restrict`).

The slice sees rows through structural types (`KvoxTranscriptsDb` and the row interfaces of `data/transcripts-db.ts`) and imports no generated client. The host proves its client satisfies them with one compile-time assignment (`apps/api/test/kvox/prisma-shape.typecheck.ts`). Objects (the audio, the rendition, snapshots, raw provider results, exports) are the object store port's; their keys are `transcripts/<transcriptId>/...`, and `transcript.purge` removes a transcript's whole prefix.

### Permissions and settings

- Permissions: `transcripts:read` and `transcripts:write` (`TRANSCRIPTS_PERMISSIONS`, `TRANSCRIPTS_READ_PERMISSION`, `TRANSCRIPTS_WRITE_PERMISSION`). The slice exports them as data: it declares nothing to the host, which registers the set (the web edition: `registerPermissionSet`, org scope, granted to `org_admin`, `contributor` and `viewer`). Every route carries `@KvoxAuth` with one of them; who may open a given transcript is `TranscriptAccessService`, and a caller with no access gets a 404, never a 403.
- Settings: none of its own. Transcription policy is the `transcription` slice's namespace (`transcription.abandonedUploadHours`, `transcription.playback.bitrateKbps`, `transcription.transcodeNodeOffloadEnabled`, ...), read through the settings port; the AI spend caps (`ai.maxInputTokens`, `ai.maxOutputTokens`) are read the same way.
- Secrets: none. The provider key is the transcription slice's; the name check spends the requester's own AI key, resolved by the host's AI adapter per call, and no key reaches this slice.
- Notification events: `transcripts.transcript_ready` and `transcripts.transcript_failed` (`TRANSCRIPTS_NOTIFICATION_EVENTS`, with the email template names `transcript-ready` and `transcript-failed`). The slice raises them with `KVOX_NOTIFY.notify` after the write commits; the host owns the templates. Keys and template names are persisted: never rename one.
- Job types (permanent): `media.audio.transcode` (node-eligible: it carries `nodeResultSchema` and `persistNodeResult`, plus `deriveOutputKey` and `nodeOffloadEnabled`; `maxAttempts` 3, three hours), `transcription.submit` (3), `transcription.poll` (5), `transcription.ingest` (3), `transcript.snapshot` (3), `transcript.export` (2, five minutes), `transcript.name_check` (1, twenty minutes; server-only because it spends the requester's own key, and tried once so a retry cannot bill for text nobody asked to see twice), `transcript.purge` and `transcripts.housekeeping`. Every one except the transcode is server-only. The three provider-facing types share one throttle bucket (`TRANSCRIPTION_THROTTLE_KEY`). The poll chain re-enqueues itself with `skipDedup: true`; without it the new link would collapse into the running one and the transcript would sit in `submitted` forever.

### Security notes

No access answers 404, never 403, on every route (`TRANSCRIPT_NOT_FOUND_MESSAGE`), and there is no `transcripts:read_any`. A share lookup never reveals whether an address has an account (one generic 404). A domain failure in a handler records the outcome on the row and returns, so it spends no attempt and no retry rediscovers it; only an unclassified error is rethrown. The housekeeping cron only decides whether a sweep is due and enqueues it; the sweep is a job. An exporter that fails destroys the output stream, so a half-written file never reaches storage looking complete. No export, log line or error carries a provider key. The editing core has no database, no Nest and no clock or random source in a reducer.

### Conformance suite

`describeTranscriptsConformance(name, build, { describe, it, expect })` from `@marinoscar/kvox-api/transcripts/testing` holds a binding to the pipeline's invariants: the nine pinned job type strings are registered, the poll re-enqueue passes `skipDedup` and lands as a distinct job beside the running one, `transcript.name_check` is server-only and has `maxAttempts: 1`, `media.audio.transcode` carries both node members, every other type is server-only, and the three provider types share the transcription bucket. `describeTranscriptExporterConformance(exporter, harness)` holds an exporter to the declaration (format, label, media type, extension, option fields and the schema derived from them) and the behaviour (it renders the fixture document, ends its stream, and renders with every option off). The package runs both (`test/transcripts-conformance.spec.ts`), the web application runs them over its own binding (`apps/api/test/conformance.spec.ts`), and `fixtureDocument` and `longDocument` (also exported from `/testing`) are the shared export fixtures.

## Entry point

`@marinoscar/kvox-api/transcripts`, and `@marinoscar/kvox-api/transcripts/testing` for tests. The slice depends on `ports`, `core`, `transcription` and `search` (`packages/kvox-slices.json`), and imports `@marinoscar/kvox-contract/transcripts` for the wire schemas (including the `media.audio.transcode` node result, which moved there with this slice so a worker-node package can import it).

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common`, `@nestjs/core` and `zod`, which every slice needs, plus `@nestjs/swagger` and `nestjs-zod` (the controllers' OpenAPI decorators and DTO classes), `@nestjs/schedule` (the housekeeping cron; loaded only when `schedules` is not `false`), `fastify` (the request and reply types of the conditional reads; optional) and `pdfkit` (the PDF exporter; optional, loaded when a PDF is rendered). The PDF fonts ship in the package (`assets/fonts`). The per-slice data is `packages/kvox-slice-peers.json`.

## Configuration

`TranscriptsModule.forRoot(options)` returns a non-global dynamic module. It exports `TranscriptsService`, `TranscriptAccessService`, `TranscriptMaterializeService`, `TranscriptEditingService`, `TranscriptPipelineService`, `TranscriptExporterRegistry`, `MarkdownTranscriptExporter` and `TranscriptsHousekeepingEnqueuer`. The package reads no environment variable.

| Option | Default | What it does |
|---|---|---|
| `sharing` | `OwnerOnlyTranscriptSharing` | A `Type<TranscriptSharing>`: who else may open, edit or delete a transcript, and the four share verbs. |
| `exporters` | json, markdown and pdf on | `{ json, markdown, pdf }` switch a built-in exporter off; `extra` adds exporter classes (a `docx` exporter is one class). |
| `pdf.fontDir` | the package's `assets/fonts` | Where the PDF exporter loads its fonts. |
| `media.transcode` | `true` | `false` leaves the transcoder and `FfmpegService` out; playback then uses the original and transcription never waits for a rendition. |
| `media.ffmpegPath`, `media.ffprobePath` | `ffmpeg`, `ffprobe` | The binaries. |
| `schedules` | `true` | `false` registers no `@nestjs/schedule` task; the host calls `TranscriptsHousekeepingEnqueuer.enqueue()` on its own timer. |
| `imports` | none | Extra modules the slice's providers need (the web edition's sharing module). |
| `peers` | a fresh `TranscriptionModule.forRoot()` and `SearchIndexingModule.forRoot()` | The very module objects the host imports, so the container sees one module and registers each handler once. |
| `playbackUrlTtlSeconds` | `21600` | The lifetime of the signed audio URL. |
| `staleUploadHours` | `72` | How old a `pending` or `uploading` object must be before the housekeeping sweep treats its upload as dead. |
| `appUrl` | none | Returns the application's base URL for the links in the ready and failed notifications. |

The routes document themselves through `documentKvoxAuth` (called by `forRoot`).

## Extension-point catalog

| Symbol | What a host does with it |
|---|---|
| `TranscriptsModuleOptions` | The options of `TranscriptsModule.forRoot`. |
| `TranscriptSharing`, `OwnerOnlyTranscriptSharing` | The host's sharing system: `decide`, `roleFor`, `rolesFor`, `sharedWhere`, `listGrants`, `grant`, `updateGrant`, `revokeGrant` and `forget`. The default makes a transcript private to its owner; the web edition binds the platform's access policy and grants. |
| `TranscriptExporter`, `TranscriptsModuleOptions.exporters` | A new format is one class registered through `exporters.extra`; the controller, the service and the job handler do not change. |
| `TRANSCRIPTS_PERMISSIONS` | The two permission strings and their default grants, for the host to register with its permission catalog. |
| `TRANSCRIPTS_NOTIFICATION_EVENTS` | The two notification events, for the host to register with its notification registry (the slice also declares them through `KVOX_NOTIFY` when it starts). |
| `KvoxTranscriptsDb` | The narrowed client the slice casts `KVOX_PRISMA` to; the host proves its client satisfies it with a compile-time assignment. |
| `TranscriptsHousekeepingEnqueuer` | Queues one housekeeping sweep unless one is in flight; a host without a scheduler calls it itself. |
| `describeTranscriptsConformance`, `describeTranscriptExporterConformance` | The conformance kits and the bindings they are run against. |
