import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type { Writable } from 'node:stream';

import { Logger } from '@nestjs/common';
import { z } from 'zod';

// =============================================================================
// The document-export kit (issue #493, epic #491)
// =============================================================================
//
// The few primitives an exporter and its registry are built from: an exporter's
// option fields and the schema derived from them, the request hash that decides
// whether an export can be reused, the stream helpers that honour backpressure,
// and the `Exporter` / `ExporterRegistry` pair.
//
// They were the web edition's platform export package's `documents` half (the
// platform packaged them from this application's own transcript export, issues #28
// and #54). The slice carries its own copy so it imports no platform package; the
// behaviour is the one the transcript exporters and their specs were written
// against. A fork adds a format by implementing `Exporter<ExportDocument>`.
//
// `render` STREAMS; IT IS NOT ALLOWED TO RETURN A BUFFER. It writes the whole
// document to `out` and ENDS it; the promise settles once `out` finished; a
// failure rejects AND destroys `out`. A ten-hour recording's PDF runs to hundreds of
// pages, and a signature that returned bytes would make "never build the whole
// document in memory" unenforceable.
//
// `format` IS PERMANENT, like a job type: the slice stores it on its export rows
// and in its request hash.
// =============================================================================

/**
 * One option an exporter offers. Boolean toggles only: the dialog draws a
 * checkbox per field.
 *
 * @stability experimental
 */
export interface ExportOptionField {
  /** The option's key in the stored options object. */
  readonly key: string;
  /** The checkbox label. */
  readonly label: string;
  /** One sentence about what it does. */
  readonly description: string;
  /** The field kind; only `boolean` exists. */
  readonly type: 'boolean';
  /** The value when the caller says nothing. */
  readonly default: boolean;
}

/**
 * The options an export was requested with.
 *
 * @stability experimental
 */
export type ExportOptions = Record<string, boolean>;

/**
 * A schema that parses an exporter's options.
 *
 * @stability experimental
 */
export type ExportOptionsSchema = z.ZodType<ExportOptions, unknown>;

/**
 * Derives an exporter's options schema from its fields: every field is a
 * boolean with its default, and an unknown key is refused (`strictObject`).
 *
 * @param fields - the exporter's fields.
 * @returns the schema.
 * @stability experimental
 */
export function optionsSchemaFor(fields: readonly ExportOptionField[]): ExportOptionsSchema {
  const shape: Record<string, z.ZodType<boolean>> = {};

  for (const field of fields) {
    shape[field.key] = z.boolean().default(field.default).describe(field.description);
  }

  return z.strictObject(shape) as unknown as ExportOptionsSchema;
}

/**
 * The options an exporter has when the caller sets none.
 *
 * @param fields - the exporter's fields.
 * @returns each field's default.
 * @stability experimental
 */
export function defaultOptions(fields: readonly ExportOptionField[]): ExportOptions {
  return Object.fromEntries(fields.map((field) => [field.key, field.default]));
}

/**
 * JSON with sorted keys and no `undefined`, so two equal values give one string.
 *
 * @param value - any JSON-able value.
 * @returns the canonical text.
 * @stability experimental
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);

  return `{${entries.join(',')}}`;
}

/**
 * The hash that identifies one export request: the same format, version and
 * options (and, when given, the same content fingerprint) give the same hash, so
 * an existing export can be reused.
 *
 * @param input - the request.
 * @returns a sha256 hex digest.
 * @stability experimental
 */
export function hashExportRequest(input: {
  format: string;
  version: number;
  options: ExportOptions;
  contentFingerprint?: string | null;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        format: input.format,
        version: input.version,
        options: input.options,
        ...(input.contentFingerprint ? { contentFingerprint: input.contentFingerprint } : {}),
      }),
    )
    .digest('hex');
}

/**
 * Writes one chunk, waiting for `drain` when the stream asks for it. Rejects
 * when `out` errors or closes before draining.
 *
 * `Writable.write()` returning `false` means the stream's buffer is full. A loop
 * that ignores it does not fail: it buffers the ENTIRE file in memory inside the
 * stream and then flushes it, which is exactly the "builds the whole document in
 * memory" behaviour every writer here must avoid.
 *
 * @param out - the destination.
 * @param chunk - the text or bytes to write.
 * @stability experimental
 */
export async function writeChunk(out: Writable, chunk: string | Uint8Array): Promise<void> {
  if (out.destroyed) throw out.errored ?? new Error('The export stream was closed');

  if (!out.write(chunk)) {
    // Both waits are cancelled once one settles, so no listener piles up.
    const settled = new AbortController();

    try {
      await Promise.race([
        once(out, 'drain', { signal: settled.signal }),
        once(out, 'close', { signal: settled.signal }).then(() => {
          throw out.errored ?? new Error('The export stream was closed');
        }),
      ]);
    } finally {
      settled.abort();
    }
  }
}

/**
 * Ends the stream and resolves once it has finished; rejects on its error.
 *
 * @param out - the destination.
 * @stability experimental
 */
export async function endStream(out: Writable): Promise<void> {
  if (out.writableFinished) return;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);

    out.once('error', onError);
    out.end(() => {
      out.off('error', onError);
      resolve();
    });
  });
}

/** Marks a stream whose `error` events a failed writer already reported. */
const SWALLOWED = Symbol('export-stream-error-swallowed');

/**
 * Destroys `out` with `error` (when it is not already destroyed) and returns the
 * error, for a writer's `catch`: the contract says a failure rejects AND destroys
 * the destination.
 *
 * @param out - the destination.
 * @param error - what went wrong.
 * @returns `error` as an `Error`.
 * @stability experimental
 */
export function failStream(out: Writable, error: unknown): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const marked = out as unknown as Record<symbol, unknown>;

  // The writer reports the failure by rejecting; the `error` event the destroy
  // emits (on the next tick) must not become an uncaught exception.
  if (!marked[SWALLOWED]) {
    marked[SWALLOWED] = true;
    out.on('error', () => undefined);
  }

  if (!out.destroyed) out.destroy(err);

  return err;
}

/**
 * Renders one document into one format.
 *
 * @typeParam TDoc - the document the exporter renders.
 * @stability experimental
 */
export interface Exporter<TDoc> {
  /** The format id (`markdown`); permanent. */
  readonly format: string;
  /** What the dialog calls it. */
  readonly label: string;
  /** The file's media type. */
  readonly mimeType: string;
  /** The file's extension, without the dot. */
  readonly extension: string;
  /** The options it offers. */
  readonly options: readonly ExportOptionField[];
  /** Parses its options (derived from `options` with {@link optionsSchemaFor}). */
  readonly optionsSchema: ExportOptionsSchema;
  /**
   * Writes the whole document to `out` and ENDS it. The promise settles once `out`
   * has finished; a failure rejects AND destroys `out`.
   *
   * @param doc - the document.
   * @param options - the parsed options.
   * @param out - the destination.
   */
  render(doc: TDoc, options: ExportOptions, out: Writable): Promise<void>;
}

/**
 * The exporters registered for one kind of document, by format.
 *
 * A duplicate registration WARNS and the later one wins, rather than throwing: a
 * fork overriding a built-in format is a legitimate move, and a boot that refuses
 * it is a worse failure than the log line.
 *
 * @typeParam TDoc - the document the exporters render.
 * @stability experimental
 */
export class ExporterRegistry<TDoc> {
  /** The logger, named for the concrete registry. */
  protected readonly logger = new Logger(ExporterRegistry.name);

  private readonly exporters = new Map<string, Exporter<TDoc>>();

  /**
   * Registers an exporter.
   *
   * @param exporter - the exporter.
   */
  register(exporter: Exporter<TDoc>): void {
    if (this.exporters.has(exporter.format)) {
      this.logger.warn(`Export format "${exporter.format}" is already registered; the later registration wins`);
    }

    this.exporters.set(exporter.format, exporter);
    this.logger.log(`Registered ${this.kind} exporter "${exporter.format}" (${exporter.label})`);
  }

  /**
   * The exporter for a format, or `undefined`.
   *
   * @param format - the format id.
   */
  get(format: string): Exporter<TDoc> | undefined {
    return this.exporters.get(format);
  }

  /** Every exporter, sorted by format. */
  all(): Exporter<TDoc>[] {
    return [...this.exporters.values()].sort((a, b) => (a.format < b.format ? -1 : a.format > b.format ? 1 : 0));
  }

  /** Every registered format id, sorted. */
  formats(): string[] {
    return this.all().map((exporter) => exporter.format);
  }

  /** What the boot log calls this kind of exporter. */
  protected get kind(): string {
    return 'document';
  }
}
