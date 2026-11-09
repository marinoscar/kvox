---
"@marinoscar/kvox-db": minor
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-web": minor
---

Graph extraction cites the stored source text of a note that was generated from a document (#789, epic #773). `kg.extract` used to read only the generated summary, so a span of the full document could not be cited. It now reads the document's extracted text (`{ extractedObjectId }`, spec notes §4.7) as the input, chunked as in #777, with the generated note shown whole as context, and the model cites the text as `D`.

`@marinoscar/kvox-db` adds the migration `20261107120000_add_kg_evidence_source_text`: `kg_evidence.source_object_id` (the stored text, `SET NULL`) and `kg_evidence.source_text_length` (the length its `char_start`/`char_end` index, and the durable marker of this anchor kind because it survives the `SET NULL`), plus the `kg_evidence_source_text_chk` constraint. The deferred `kg_assert_has_evidence` no-orphans trigger is unchanged and counts a source-text citation like any other evidence row.

`@marinoscar/kvox-contract`: `EvidenceInput` gains `sourceObjectId` and `sourceTextLength` (both default `null`; a source-text citation also carries the note), `EvidenceLink.source` gains `kind: 'source_text'` (with the deep link `/notes/<id>?source=<start>-<end>`), `EvidenceView.source` gains `'source_text'` and the evidence span input gains `source: 'source_text'`.

`@marinoscar/kvox-api`: `EvidenceValidator`, `GraphEvidenceService`, the proposal view mapper, the span validator (`SpanValidator.prepare` reads the source text before the transaction) and the proposal commit handle the new anchor; the RDF export leaves out the offsets of a source-text citation, which index the document and not the note version. `ExtractionInputLoader` takes an optional `KVOX_OBJECT_STORE`; `ExtractionInput.sourceText`, `ExtractionContext.source`, `SOURCE_ALIAS` and `readNoteSourceText` are new. Every code that builds an `EvidenceInput` literal sets the two new fields to `null`.

`@marinoscar/kvox-web`: the evidence chip, the explorer evidence card and the proposal review evidence list render a source-text citation ("Source of <note>", "Open source document").
