---
"@marinoscar/kvox-contract": minor
---

Publish the domain wire contract: the Zod schemas of the transcription, transcripts, search, notes, graph and Ask slices (moved out of the API DTO files with no change to a field name or value), the `KVOX_ERROR_CODES` catalogue, the ontology (moved from `packages/shared`, `@app/shared/ontology` now re-exports it) and the transcript export JSON schema (`./schemas/transcript-export.v1.json`).
