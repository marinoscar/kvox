// =============================================================================
// `NoteExporter` and its registry (issue #54, docs/specs/notes.md §8.1)
// =============================================================================
//
// A thin instantiation of the generic `ExporterRegistry<TDoc>` extracted from
// `transcripts/export/` — see `apps/api/src/export/exporter-registry.ts` for
// the whole contract (the streams-never-buffers rule, why `format` is
// permanent, why a duplicate registration warns rather than throws).
//
// ADDING A FORMAT COSTS ONE CLASS, and that discipline now applies to a second
// document type. `NoteExportService.listExporters()` publishes this registry,
// the export dialog renders whatever it returns, and the Zod schema validating
// a request is DERIVED from each exporter's own option list. Nothing in the
// controller, the `note.export` handler or `apps/web` may branch on a format
// string; `apps/api/src/notes/export/` is the whole surface.
//
// The generic parameter is what keeps the two registries apart: a
// `TranscriptExporter` renders an `ExportDocument` and a `NoteExporter` renders
// a `NoteExportDocument`, so registering one into the other's registry is a
// compile error rather than a runtime surprise.
// =============================================================================

import { Injectable } from '@nestjs/common';

import { ExporterRegistry, type Exporter } from '../../export/exporter-registry';
import type { NoteExportDocument } from './note-export-document';

/** An exporter that renders a note. See `Exporter<TDoc>` for the contract. */
export type NoteExporter = Exporter<NoteExportDocument>;

@Injectable()
export class NoteExporterRegistry extends ExporterRegistry<NoteExportDocument> {
  /** Keeps the boot log reading "Registered note exporter ...". */
  protected override get kind(): string {
    return 'note';
  }
}
