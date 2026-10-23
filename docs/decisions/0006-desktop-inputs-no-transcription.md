# ADR-0006: Desktop inputs: text transcripts and notes only, no transcription

- Status: Accepted
- Date: 2026-10-17
- Related issues: epic #574, #571, #585, epic #708

## Context

Desktop v1 builds notes and a knowledge graph from meetings that already have text. Audio transcription needs provider keys, large uploads and worker capacity that a single-user local application should not carry.

## Decision

Desktop accepts these inputs:

| Input | Route | Issue |
|---|---|---|
| PDF transcript | Notes document source, parsed with `unpdf` | |
| KVox transcript export JSON (`transcript-export.v1`) | Import added to the transcripts slice; keeps speakers, so `ATTENDED` relations exist | #571 |
| Markdown or text | Notes document source | |
| KVox note exports | Import added to the notes slice | #585 |
| Word (`.docx`) note | Notes import, converted to Markdown by a pure OOXML extractor in the notes slice | #708 |
| PowerPoint (`.pptx`) note | Notes import, converted to Markdown by a pure OOXML extractor in the notes slice | #708 |
| Note library (a folder) | Rescanned (and on Desktop watched) folder of md, txt, pdf, docx and pptx files, imported file by file as notes | #708 |

The transcription and transcripts slices are still mounted, because notes depend on them, with no transcription provider configured. Dropped md, txt, pdf, docx and pptx files import as notes (no AI generation); "use as AI source" is the secondary action ([../specs/notes.md §8.8](../specs/notes.md#88-note-libraries-and-import-batches-epic-708)). All parsing lives in packages ([ADR-0001](0001-packages-first.md)). The export schema is [../specs/transcript-export.v1.schema.json](../specs/transcript-export.v1.schema.json).

## Consequences

- No audio path, no upload of recordings, no transcription cost on Desktop.
- A PDF or text transcript has no speaker structure unless the user supplies it, so `ATTENDED` relations come from JSON exports only.
- Imports benefit the web edition too, since they are package features.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Local audio transcription on Desktop | Large models and per-platform builds; out of scope for v1. |
| Cloud transcription from Desktop | A second cloud egress path, against [ADR-0004](0004-desktop-data-local-only.md). |
| Unmount the transcription slices | Notes depend on them. |

## Enforcement

- Importer tests in the transcripts and notes slices.
- No transcription provider is configured in the Desktop host (reviewed with the host bindings, #583).
- Review item: no parser in the Desktop repository.

## Related issues

#571, #585, #708.
