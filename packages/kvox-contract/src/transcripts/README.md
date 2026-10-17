# transcripts

The transcript wire contract: list and detail responses, segments and words, editing operations, versions, exports, sharing and the AI name check.

## Purpose and scope

The transcript wire contract: list and detail responses, segments and words, editing operations, versions, exports, sharing and the AI name check. Plain Zod schemas, `as const` tuples and inferred types only: no Nest, no `nestjs-zod`, no Node built-in, so it loads in the browser too.

- `transcript.ts`: statuses, summaries, list and detail, segments, words, uploads and keyterms.
- `transcript-editing.ts` and `editing-ops.ts`: the edit request bodies and the recorded operations a version replays (`requestOpSchema`, `recordedOpSchema`).
- `transcript-export.ts`, `transcript-share.ts`, `transcript-name-check.ts`: exports, shares and name checks (with `NAME_CHECK_CONFLICT_REASONS`).
- `transcript-import.ts`: the `kvox.transcript/v1` document as a strict Zod schema (`transcriptDocumentV1Schema`, `TRANSCRIPT_DOCUMENT_V1_SCHEMA`) that the import validates against, the `POST /api/transcripts/imports` answer (`transcriptImportResponseSchema`, the transcript detail), and the typed refusal (`TRANSCRIPT_IMPORT_FAILURE_REASONS`, `transcriptImportErrorDetailsSchema`, `TRANSCRIPT_IMPORT_MAX_ISSUES`). A test proves the schema and the published JSON Schema accept and reject the same files.
- `media-audio-transcode.ts`: the result a worker node posts back for the `media.audio.transcode` job (`mediaAudioTranscodeResultSchema`), so a node package imports it from the contract.

The editing reducer itself stays in the API package (`packages/kvox-api/src/transcripts/editing/`, pure by rule); only the operation schemas moved.

Status: experimental. Moved out of the API DTO files by issue 5.2 (marinoscar/kvox#488) with no change to a field name or a value; every wire shape here is permanent (add, never rename).

## Entry point

`@marinoscar/kvox-contract/transcripts`. The slice depends on `errors` and `transcription`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`, required. The slice imports no other package.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes data shapes, not extension points.

### Desktop

Desktop's main process and renderer both import this slice, so the wire shapes cannot drift between them; install the same version in both. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#who-this-is-for-and-what-you-get).
