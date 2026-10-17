import { defaultOptions } from '../../transcripts/index.js';
import type { NoteExporter } from '../export/note-exporter.registry.js';
import type { NoteExportDocument } from '../export/note-export-document.js';
import { collect, noteDocument } from './export-fixtures.js';

// =============================================================================
// The note exporter kit (issue #495, epic #491)
// =============================================================================
//
// `describeNoteExporterConformance` is what a fork runs against a new format (a `rtf` exporter
// is one class in `exporters.extra`): the contract every note exporter keeps, stated once. It
// checks the DECLARATION (format, label, media type, extension, option fields and the schema
// derived from them) and the BEHAVIOUR (`render` writes bytes for the fixture document and ends
// the stream; an unknown option is refused rather than ignored).
//
// `render` STREAMS and may not return a buffer; this kit hands it a `PassThrough` and collects
// after the render settles, so a truncated render cannot pass as a complete one. The three
// built-in exporters (Markdown, PDF, Word) run it in the package's own specs and in the
// application's conformance run.
// =============================================================================

/**
 * The test runner's functions, so the kit runs under Jest or Vitest.
 *
 * @stability experimental
 */
export interface NoteExporterConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: (...args: any[]) => any): void;
  /** Starts an assertion. */
  expect(actual: any): any;
}

/**
 * Options of {@link describeNoteExporterConformance}.
 *
 * @stability experimental
 */
export interface NoteExporterConformanceOptions {
  /** The document to render. Default: the shared fixture (every block kind the renderers support). */
  document?: NoteExportDocument;
  /** The smallest output, in bytes, that counts as a rendered document. Default 1. */
  minBytes?: number;
}

/**
 * Declares the note exporter conformance tests.
 *
 * @param exporter - the exporter under test.
 * @param harness - the runner's `describe`, `it` and `expect`.
 * @param options - the document and the size floor.
 * @stability experimental
 */
export function describeNoteExporterConformance(
  exporter: NoteExporter,
  harness: NoteExporterConformanceHarness,
  options: NoteExporterConformanceOptions = {},
): void {
  const { describe, it, expect } = harness;

  describe(`note exporter conformance: ${exporter.format}`, () => {
    it('declares a format, label, media type and extension', () => {
      expect(exporter.format).toMatch(/^[a-z][a-z0-9_-]*$/);
      expect(exporter.label.trim().length).toBeGreaterThan(0);
      expect(exporter.mimeType).toMatch(/^[a-z]+\/[a-z0-9.+-]+(;\s*[a-z-]+=[^;]+)*$/i);
      expect(exporter.extension).toMatch(/^[a-z0-9]{1,8}$/);
    });

    it('declares unique boolean option fields, each with a label and a description', () => {
      const keys = exporter.options.map((field) => field.key);

      expect(new Set(keys).size).toBe(keys.length);

      for (const field of exporter.options) {
        expect(field.type).toBe('boolean');
        expect(typeof field.default).toBe('boolean');
        expect(field.label.trim().length).toBeGreaterThan(0);
        expect(field.description.trim().length).toBeGreaterThan(0);
      }
    });

    it('derives its options schema from its fields: defaults for nothing, a refusal for an unknown key', () => {
      expect(exporter.optionsSchema.parse({})).toEqual(defaultOptions(exporter.options));
      expect(exporter.optionsSchema.safeParse({ notAnOption: true }).success).toBe(false);
    });

    it('renders bytes for the fixture document and ends the stream', async () => {
      const bytes = await collect(exporter, options.document ?? noteDocument());

      expect(bytes.length).toBeGreaterThanOrEqual(options.minBytes ?? 1);
    });

    it('renders the same document with every option off', async () => {
      const off = Object.fromEntries(exporter.options.map((field) => [field.key, false]));
      const bytes = await collect(exporter, options.document ?? noteDocument(), off);

      expect(bytes.length).toBeGreaterThanOrEqual(options.minBytes ?? 1);
    });
  });
}
