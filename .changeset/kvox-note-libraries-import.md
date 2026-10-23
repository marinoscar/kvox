---
'@marinoscar/kvox-api': minor
---

Note libraries import (#715, epic #708). `POST /api/notes/import-batches/:id/files` uploads one document into a batch (multipart `file`, optional `path` and `mtime`; bounded by `maxDocumentImportBytes`; a file whose bytes the library already imported answers `skipped`) and queues the new server-only `note.library.import` job, which turns it into a note (a new file) or a new version of the note an earlier import made (a changed file, flagged `diverged` when the note was edited since). `POST /api/notes/import-batches/:id/retry` re-queues failed items. Exports `NoteLibraryImportHandler`, `NoteLibraryUploadService`, `NoteLibraryUploadController` and `NOTE_LIBRARY_IMPORT_JOB_TYPE`; `kvox.notes.note_ready` is published with `origin: 'library'` and `bulk: true` when the library's `autoExtract` is on.
