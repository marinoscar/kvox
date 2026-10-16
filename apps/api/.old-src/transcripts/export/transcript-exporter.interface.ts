// =============================================================================
// `TranscriptExporter` and its registry (issue #28, epic #19, spec §8.1)
// =============================================================================
//
// ⚠ SINCE ISSUE #54 THIS FILE IS A THIN INSTANTIATION, NOT AN IMPLEMENTATION.
// The interface and the registry were extracted, behaviour-preserving, into the
// generic `apps/api/src/export/exporter-registry.ts` (`docs/specs/notes.md`
// §8.1) so that note export reuses them rather than growing a second registry
// that diverges on fonts, page setup and PDF generation within a release. That
// file's header carries the whole contract — the streams-never-buffers rule,
// why `format` is permanent, and why a duplicate registration warns rather than
// throws. Everything that was true of transcript export before the extraction
// is still true; this file's own test suite (`transcript-exporter.registry
// .spec.ts`) passes unmodified against the identical public API, which is the
// evidence that the extraction changed nothing.
//
// The one thing that stays here is the binding of the generic document
// parameter: a `TranscriptExporter` renders an `ExportDocument` and nothing
// else, so a note exporter cannot be registered into this registry by accident.
// =============================================================================

import { Injectable } from '@nestjs/common';

import { ExporterRegistry, type Exporter } from '../../export/exporter-registry';
import type { ExportDocument } from './export-document';

/**
 * An exporter that renders a transcript. See `Exporter<TDoc>` for the contract.
 *
 * An alias rather than a re-declaration: two structurally identical interfaces
 * are two places to edit, and the one that is not edited becomes the one a
 * future exporter is written against.
 */
export type TranscriptExporter = Exporter<ExportDocument>;

@Injectable()
export class TranscriptExporterRegistry extends ExporterRegistry<ExportDocument> {
  /** Keeps the boot log reading "Registered transcript exporter ...". */
  protected override get kind(): string {
    return 'transcript';
  }
}
