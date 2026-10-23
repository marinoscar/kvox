---
'@marinoscar/kvox-api': minor
---

Note libraries and import batches API (#714): `POST/GET /api/notes/libraries`, `GET/PATCH/DELETE /api/notes/libraries/:id`, `POST /api/notes/libraries/:id/scan` (manifest diff), `POST/GET /api/notes/import-batches`, `GET /api/notes/import-batches/:id` and `/items`. New exports `NoteLibrariesService`, `NoteLibraryPolicy` (`forNote`), `diffLibraryManifest`, `deriveItemStage`, `recomputeBatchStatus`. `KvoxNotesDb` gains the `noteLibrary`, `noteLibraryFile`, `noteImportBatch`, `noteImportBatchItem` and read-only `kgProposal` delegates.
