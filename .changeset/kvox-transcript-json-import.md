---
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-web": minor
---

Import a `kvox.transcript/v1` JSON export as a transcript. `@marinoscar/kvox-contract/transcripts` adds the Zod mirror of the published schema (`transcriptDocumentV1Schema`), the import response and the six typed failure reasons (`TRANSCRIPT_IMPORT_FAILURE_REASONS`, also in `KVOX_ERROR_CODES`); the schema gains an optional, additive `transcript.recordedAt`. `@marinoscar/kvox-api/transcripts` adds `POST /api/transcripts/imports` (multipart, `transcripts:write`, `maxImportBytes` option, 25 MiB default) and `TranscriptImportService`, which writes the transcript, speakers, identities, segments and version 1 with no audio and no transcription job; the JSON exporter now emits `recordedAt`; the transcripts conformance kit gains a required `importer` target and two import invariants. `@marinoscar/kvox-web/transcripts` adds `importTranscript`, `ImportTranscriptButton` (an "Import transcript (JSON)" action on the library and new-transcript pages) and hides the player for an imported transcript; `LibraryPageFrame` gains an optional `secondaryAction`.
