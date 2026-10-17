---
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-contract": minor
---

Add `@marinoscar/kvox-api/transcripts` and `@marinoscar/kvox-api/transcripts/testing`: `TranscriptsModule.forRoot` (the upload hook, the nine job handlers, the correction, export, name-check and share routes, the pure editing core, the access rules and the three exporters) over the host ports, with `TranscriptSharing` as the extension point for who else may open a transcript (owner-only by default), `describeTranscriptsConformance` and `describeTranscriptExporterConformance`. The ports gain, additively, `KVOX_JOBS.onSettled`, `findActive` and `tempPath`, `KVOX_OBJECT_STORE.adopt`, `describe`, `onAborted` and an `onUploaded` content-type filter, an idempotent `put`, `$transaction` options and an array form, `KVOX_AI.resolveTask` `requireKey`, and an optional `brand` on `KvoxPortsModule.forRoot`. `@marinoscar/kvox-contract/transcripts` gains the `media.audio.transcode` node result schema.
