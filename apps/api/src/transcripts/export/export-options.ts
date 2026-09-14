// =============================================================================
// Re-export shim: the option machinery is generic now (issue #54, epic #45)
// =============================================================================
//
// `docs/specs/notes.md` §8.1 extracts the exporter registry — and with it the
// declarative option fields, their derived Zod schema and the content-address
// hash — out of `transcripts/export/` into `apps/api/src/export/`, so that the
// note exporters reuse them rather than growing a second, silently diverging
// copy. This file stays because deleting it would have meant editing every
// transcript exporter, fixture and spec in the same commit as the extraction —
// and then "the transcript export suite passes unmodified" would no longer be
// available as evidence that the extraction changed nothing.
//
// New code should import from `../../export/export-options` directly.
// =============================================================================

export * from '../../export/export-options';
