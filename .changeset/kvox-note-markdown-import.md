---
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-web": minor
---

Import a Markdown note export back into a note (#585). `@marinoscar/kvox-contract/notes` adds `parseNoteMarkdownExport` (pure: the title, the body without the exporter's heading and provenance block, the body format and the export's provenance, or a typed refusal), the format identifier `NOTE_MARKDOWN_EXPORT_SCHEMA` (`kvox.note/v1`), the four `NOTE_IMPORT_FAILURE_REASONS` (also in `KVOX_ERROR_CODES`), the import response, and `detectKvoxImport` / `KVOX_IMPORT_ROUTES`, which decide from a file's first bytes which import route a host sends it to (transcript JSON, note export, or a PDF/text/Markdown note source). `@marinoscar/kvox-api/notes` adds `POST /api/notes/import` (multipart, `notes:write`, `maxImportBytes` option, 5 MiB default) and `NoteImportService`: a `ready` note with version 1 as an `edit` by the importer, the file kept as its source document with its extraction queued, the search index queued and `kvox.notes.note_ready` published; the Markdown exporter's front matter now opens with `schema: "kvox.note/v1"` and carries `bodyFormat`. `@marinoscar/kvox-web/notes` adds `importNoteMarkdown`, `NotesPage`'s `secondaryAction`, and `NewNotePage`'s `?objectId=` (with `?documentName=`), which pre-selects a document the host already uploaded.
