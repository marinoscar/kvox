# notes

The notes wire contract: notes and their versions, templates, source documents and exports.

## Purpose and scope

The notes wire contract: notes and their versions, templates, source documents and exports. Plain Zod schemas, `as const` tuples and inferred types only: no Nest, no `nestjs-zod`, no Node built-in, so it loads in the browser too.

- `note-source-extract.ts`: the result schema a worker node posts back for `note.source.extract`, with the extraction reason and encoding tuples.
- `note-events.ts`: the `kvox.notes.note_ready` event name and its payload type.
- `note.ts`: create, update, regenerate and restore bodies, the note and version responses, `NOTE_CONFLICT_REASONS`.
- `note-template.ts`: templates, the preview and the body formats.
- `note-source.ts`, `note-export.ts`, `document-format.ts`: uploaded source documents, exports and the accepted document MIME types.
- `note-library.ts` (#710, epic #708): note libraries. `NOTE_IMPORT_EXTENSIONS`, `NOTE_IMPORT_ACCEPT`, `noteImportMimeTypeForExtension`, the file, batch, item-action, item-status and derived item-stage tuples, `normalizeLibraryPath`, `NOTE_LIBRARY_MAX_MANIFEST_ENTRIES` and the library, manifest, scan and import-batch schemas. The `note.library.import` job type string lives in `kvox-api` (`NOTE_LIBRARY_IMPORT_JOB_TYPE`). `document-format.ts` now also exports `DOCX_MIME_TYPE` and `PPTX_MIME_TYPE`; `NoteReadyEvent` carries optional `origin` and `bulk`.
- `note-import.ts` (#585): reading a Markdown note export back. `parseNoteMarkdownExport` (pure, total: the note, or a typed refusal), the format identifier `NOTE_MARKDOWN_EXPORT_SCHEMA` (`kvox.note/v1`), `NOTE_IMPORT_FAILURE_REASONS`, the `POST /api/notes/import` response, and `detectKvoxImport`: which import route a local file goes to (`/transcripts/imports`, `/notes/import` or, for the new `note_document` kind covering PDF, .docx, .pptx, Markdown and text, `/notes/import-batches`: create a batch, then upload each file to `/notes/import-batches/:batchId/files`) and the media type to send, decided from its first `KVOX_IMPORT_SNIFF_BYTES` bytes, the name only separating Markdown from plain text. A host routes a dropped or chosen file with it instead of keeping its own table.

Token budgets and model allow-lists stay in the API: they are policy, not wire shape.

Status: experimental. Moved out of the API DTO files by issue 5.2 (marinoscar/kvox#488) with no change to a field name or a value; every wire shape here is permanent (add, never rename).

## Entry point

`@marinoscar/kvox-contract/notes`. The slice depends on `errors` and `transcripts`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`, required. The slice imports no other package.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes data shapes, not extension points.

### Desktop

Desktop's main process and renderer both import this slice, so the wire shapes cannot drift between them; install the same version in both. Desktop's import ("Import…" and drag and drop) calls `detectKvoxImport` in the main process on the file's first bytes and streams the file to the route it names. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#who-this-is-for-and-what-you-get).
