---
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-contract": minor
---

Add `@marinoscar/kvox-api/notes`, `@marinoscar/kvox-api/notes/templates` and `@marinoscar/kvox-api/notes/testing`: `NotesModule.forRoot` (the note, template, document-source and generation-stream routes, the six job handlers, the access rules, the three exporters, the built-in templates with an idempotent `seedNoteTemplates`, and `NotesUserDataService`) over the host ports and the transcripts and search slices, with `describeNotesConformance`, `describeNoteExporterConformance` and `createNotesServiceTestFactory`. A ready note now publishes `kvox.notes.note_ready` on `KVOX_EVENTS` after its commit; the slice no longer knows the knowledge graph. The ports gain, additively, `KVOX_JOBS.enqueueWithin` and, on `KVOX_OBJECT_STORE`, `setMetadata` and the `ownerId`, `managedBy` and `metadata` fields of `describe`. `docx` and `unpdf` join `pdfkit` as optional peers. `@marinoscar/kvox-contract/notes` gains the `note.source.extract` node result schema and the ready event payload.
