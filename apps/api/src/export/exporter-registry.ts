// =============================================================================
// `Exporter<TDoc>` and `ExporterRegistry<TDoc>` (issue #54, docs/specs/notes.md §8.1)
// =============================================================================
//
// A behaviour-preserving extraction of `TranscriptExporterRegistry`'s exact
// shape (issue #28, `docs/specs/transcription.md` §8.1), generic over the
// document type an exporter renders. `TranscriptExporterRegistry` is now a
// one-line instantiation over `ExportDocument`; `NoteExporterRegistry` is the
// same one line over `NoteExportDocument`.
//
// THE EXTRACTION IS THE POINT, AND IT IS NOT A TIDY-UP. Two independently
// maintained exporter registries in one codebase diverge on fonts, page setup
// and PDF generation within a release — and then a bug fixed in one is still
// open in the other. Issue #54 states that as the reason note export waited for
// #28 rather than shipping its own registry alongside it.
//
// -----------------------------------------------------------------------------
// `render` STREAMS. IT IS NOT ALLOWED TO RETURN A BUFFER.
// -----------------------------------------------------------------------------
//
// Carried across verbatim from `transcript-exporter.interface.ts`, because it
// is the one part of this contract a second document type could plausibly think
// did not apply to it. It does. The signature takes a `Writable` rather than
// returning `Buffer` or `string` because of the one document that cannot afford
// otherwise — a ten-hour recording's PDF runs to hundreds of pages, and
// `pdfmake` was rejected for that epic (`docs/specs/transcription.md` §8.4,
// §11) precisely because it builds the whole document in memory. A signature
// that RETURNED bytes would make that rejection unenforceable.
//
// The contract, stated once so every implementation agrees:
//
//   * `render` writes the complete document to `out` and **ends it**;
//   * the returned promise settles only once `out` has finished — so a caller
//     that awaits it knows every byte has been handed on, which is what makes
//     "upload the stream and await both" safe in a job handler;
//   * a failure rejects AND destroys `out`, so a half-written export never
//     reaches storage looking complete.
//
// -----------------------------------------------------------------------------
// `format` IS PERMANENT, EXACTLY LIKE A JOB TYPE
// -----------------------------------------------------------------------------
//
// It is stored in `transcript_exports.format` / `note_exports.format` (a plain
// string column, no enum, for this reason) and it is baked into `options_hash`.
// Renaming one orphans every existing row of that format and breaks every reuse
// lookup for it. A new output shape is a NEW format that coexists with the old.
// =============================================================================

import { Logger } from '@nestjs/common';
import type { Writable } from 'node:stream';

import type { ExportOptionField, ExportOptions, ExportOptionsSchema } from './export-options';

/** One renderer, for one document type, in one format. */
export interface Exporter<TDoc> {
  /** The registry key, and the export row's `format`. Permanent. */
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
  render(doc: TDoc, options: ExportOptions, out: Writable): Promise<void>;
}

/**
 * The registry every exporter self-registers into from its `onModuleInit`.
 *
 * Generic over the document type so that a note exporter cannot be registered
 * into the transcript registry by accident: the two are different types, not
 * one type with a discriminator field somebody has to remember to check.
 */
export class ExporterRegistry<TDoc> {
  protected readonly logger = new Logger(ExporterRegistry.name);
  private readonly exporters = new Map<string, Exporter<TDoc>>();

  /**
   * Called by each exporter from its own `onModuleInit`.
   *
   * A duplicate `format` OVERWRITES and warns, matching
   * `JobHandlerRegistry.register` exactly — a fork deliberately shadowing the
   * framework's Markdown exporter with its own is a legitimate thing to do, and
   * it should be visible in the log rather than refused at boot.
   */
  register(exporter: Exporter<TDoc>): void {
    if (this.exporters.has(exporter.format)) {
      this.logger.warn(
        `Export format "${exporter.format}" is already registered; the later registration wins`,
      );
    }

    this.exporters.set(exporter.format, exporter);
    this.logger.log(`Registered ${this.kind} exporter "${exporter.format}" (${exporter.label})`);
  }

  /**
   * The exporter for `format`, or `undefined`.
   *
   * `undefined` rather than a throw, for the same reason `JobHandlerRegistry
   * .get` returns one: the caller is an HTTP path that owes the client a 400
   * naming the formats that DO exist, which is a better answer than an
   * exception raised three frames below it.
   */
  get(format: string): Exporter<TDoc> | undefined {
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
  all(): Exporter<TDoc>[] {
    return [...this.exporters.values()].sort((a, b) =>
      a.format < b.format ? -1 : a.format > b.format ? 1 : 0,
    );
  }

  /** The registered format strings, sorted. For error messages and tests. */
  formats(): string[] {
    return this.all().map((exporter) => exporter.format);
  }

  /**
   * What this registry's exporters render, for the registration log line only.
   *
   * A subclass overrides it so the boot log still reads "Registered transcript
   * exporter ..." rather than a generic sentence naming neither document type.
   */
  protected get kind(): string {
    return 'document';
  }
}
