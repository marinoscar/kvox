// =============================================================================
// `TranscriptExporter` and its registry (issue #28, epic #19, spec §8.1)
// =============================================================================
//
// The same self-registration shape `docs/specs/job-queue.md` §1.2 establishes
// for job handlers and the email module already uses for providers: an exporter
// declares what it is, registers itself from `onModuleInit`, and nothing
// central enumerates the list. `TranscriptExporterRegistry.get(format)` is the
// ONLY thing the export service ever calls, so a future `docx` exporter is one
// new class — no change to the endpoint, the job handler, or the dialog beyond
// it picking the new format up from `GET /api/transcripts/exporters`.
//
// -----------------------------------------------------------------------------
// `render` STREAMS. IT IS NOT ALLOWED TO RETURN A BUFFER.
// -----------------------------------------------------------------------------
//
// The signature takes a `Writable` rather than returning `Buffer` or `string`
// because of the one document that cannot afford otherwise: a ten-hour
// recording's PDF runs to hundreds of pages, and `pdfmake` was rejected for
// this epic (spec §8.4, §11) precisely because it builds the whole document in
// memory. A signature that RETURNED bytes would make that rejection
// unenforceable — the PDF exporter would have to buffer to satisfy it, and the
// design decision would survive only as a comment.
//
// The contract, stated once so all three implementations agree:
//
//   * `render` writes the complete document to `out` and **ends it**;
//   * the returned promise settles only once `out` has finished — so a caller
//     that awaits it knows every byte has been handed on, which is what makes
//     "upload the stream and await both" safe in the job handler;
//   * a failure rejects AND destroys `out`, so a half-written export never
//     reaches storage looking complete.
//
// -----------------------------------------------------------------------------
// `format` IS PERMANENT, EXACTLY LIKE A JOB TYPE
// -----------------------------------------------------------------------------
//
// It is stored in `transcript_exports.format` (a plain string column, no enum,
// for this reason) and it is baked into `options_hash`. Renaming one orphans
// every existing row of that format and breaks every reuse lookup for it. A new
// output shape is a NEW format that coexists with the old one — the same
// posture spec §8.2 takes for `kvox.transcript/v1` itself.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import type { Writable } from 'node:stream';

import type { ExportDocument } from './export-document';
import type { ExportOptionField, ExportOptions, ExportOptionsSchema } from './export-options';

export interface TranscriptExporter {
  /** The registry key, and `transcript_exports.format`. Permanent. */
  readonly format: string;
  /** What the export dialog calls this format. */
  readonly label: string;
  /** Content type of the rendered file, for storage and the download. */
  readonly mimeType: string;
  /** Filename extension, WITHOUT the dot. */
  readonly extension: string;
  /** The declarative option list — the one source both of the two below. */
  readonly options: readonly ExportOptionField[];
  /** Derived from `options`; never hand-written beside it. */
  readonly optionsSchema: ExportOptionsSchema;

  /** Write the document to `out`. See the header for the full contract. */
  render(doc: ExportDocument, options: ExportOptions, out: Writable): Promise<void>;
}

@Injectable()
export class TranscriptExporterRegistry {
  private readonly logger = new Logger(TranscriptExporterRegistry.name);
  private readonly exporters = new Map<string, TranscriptExporter>();

  /**
   * Called by each exporter from its own `onModuleInit`.
   *
   * A duplicate `format` OVERWRITES and warns, matching
   * `JobHandlerRegistry.register` exactly — a fork deliberately shadowing the
   * framework's Markdown exporter with its own is a legitimate thing to do, and
   * it should be visible in the log rather than refused at boot.
   */
  register(exporter: TranscriptExporter): void {
    if (this.exporters.has(exporter.format)) {
      this.logger.warn(
        `Export format "${exporter.format}" is already registered; the later registration wins`,
      );
    }

    this.exporters.set(exporter.format, exporter);
    this.logger.log(`Registered transcript exporter "${exporter.format}" (${exporter.label})`);
  }

  /**
   * The exporter for `format`, or `undefined`.
   *
   * `undefined` rather than a throw, for the same reason `JobHandlerRegistry
   * .get` returns one: the caller is an HTTP path that owes the client a 400
   * naming the formats that DO exist, which is a better answer than an
   * exception raised three frames below it.
   */
  get(format: string): TranscriptExporter | undefined {
    return this.exporters.get(format);
  }

  /**
   * Every registered exporter, ordered by `format`.
   *
   * SORTED, NOT IN REGISTRATION ORDER. Registration order is the order Nest
   * happens to instantiate providers in, which is an implementation detail of
   * the module's `providers` array — so the dialog's format list would silently
   * reorder itself the day somebody alphabetises that array. A stable key that
   * is already permanent is the right thing to sort on.
   */
  all(): TranscriptExporter[] {
    return [...this.exporters.values()].sort((a, b) =>
      a.format < b.format ? -1 : a.format > b.format ? 1 : 0,
    );
  }

  /** The registered format strings, sorted. For error messages and tests. */
  formats(): string[] {
    return this.all().map((exporter) => exporter.format);
  }
}
