---
"@marinoscar/kvox-contract": minor
---

Contract for note libraries (#710, epic #708). `@marinoscar/kvox-contract/notes` adds `DOCX_MIME_TYPE` and `PPTX_MIME_TYPE` (both now in `NOTE_DOCUMENT_MIME_TYPES`); the extraction reasons `unsupported_office_format` and `archive_too_large` and the encoding `ooxml` (appended); a new `note_document` kind and `/notes/import-batches` route in `detectKvoxImport` / `KVOX_IMPORT_ROUTES`, which now recognises .docx and .pptx by ZIP entry names, PDFs, legacy Office (CFB) files, and routes Markdown and text that is not a KVox note export to `note_document` (the `document_pdf` and `document_text` kinds stay in the union, deprecated, and are no longer returned); `note-library.ts` with the importable extensions and `accept` string, the library, batch, item and stage tuples, `normalizeLibraryPath`, `NOTE_LIBRARY_MAX_MANIFEST_ENTRIES` and the library, manifest, scan and import-batch schemas; and optional `origin` and `bulk` on `NoteReadyEvent`.
