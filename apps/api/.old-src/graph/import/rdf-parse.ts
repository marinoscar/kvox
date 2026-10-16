// =============================================================================
// Parsing an uploaded RDF file (#387, docs/specs/ontology.md §18.3, §18.4)
// =============================================================================
//
// The ONE import file that imports an RDF library (`n3`, `jsonld`), and only
// the `kg.import` job handler imports it — never a request handler (§18.4;
// `test/graph/rdf/rdf-imports.spec.ts` pins both halves).
//
//   Turtle / N-Quads — `n3`'s `StreamParser`, fed straight from storage, so a
//     file is never held twice; the triple cap is enforced as quads arrive.
//   JSON-LD — `jsonld.toRDF` over the parsed document (a JSON document has to
//     be whole before it can be expanded; the byte cap bounds it). Remote
//     contexts are REFUSED: the `documentLoader` answers exactly one URL — a
//     bundled copy of this application's own `@context` — and throws for every
//     other, so an untrusted file can never make this server fetch anything
//     (no SSRF, no dependence on a third party being up).
//
// Every failure becomes an `RdfParseError` carrying a failure reason and a
// short message naming at most a line number — never a byte of the file.
// Output is `ImportQuad` plain data (`import-dataset.ts`).
// =============================================================================

import type { Readable } from 'node:stream';

import * as jsonld from 'jsonld';
import { Parser, StreamParser, type Quad, type Term } from 'n3';

import { buildJsonLdContext } from '../export/jsonld-context';
import type { GraphImportFormat } from './dto/graph-import.dto';
import type { ImportQuad, ImportTerm } from './import-dataset';

export type RdfParseFailure = 'parse_error' | 'too_large';

export class RdfParseError extends Error {
  constructor(
    readonly reason: RdfParseFailure,
    message: string,
  ) {
    super(message);
    this.name = 'RdfParseError';
  }
}

export interface ParseRdfOptions {
  /** More quads than this → `too_large`. */
  maxTriples: number;
  /** More bytes than this → `too_large` (the upload already enforced it; a stored file is re-checked). */
  maxBytes: number;
  /** The application namespace — its `context` URL is the one context the JSON-LD loader serves. */
  ns: string;
}

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

function toTerm(term: Term): ImportTerm {
  switch (term.termType) {
    case 'NamedNode':
      return { termType: 'NamedNode', value: term.value };
    case 'BlankNode':
      return { termType: 'BlankNode', value: term.value };
    case 'Literal': {
      const language = (term as { language?: string }).language;
      const datatype = (term as { datatype?: { value: string } }).datatype?.value ?? XSD_STRING;
      return language ? { termType: 'Literal', value: term.value, datatype, language } : { termType: 'Literal', value: term.value, datatype };
    }
    default:
      // A variable or the default graph can never be a subject/object of a data quad.
      return { termType: 'NamedNode', value: term.value };
  }
}

function toImportQuad(q: Quad): ImportQuad {
  return { s: toTerm(q.subject), p: q.predicate.value, o: toTerm(q.object) };
}

/** `n3`'s messages end in "on line N." — keep the line, drop anything quoted from the file. */
function syntaxMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = /line (\d+)/i.exec(text);
  return line ? `The file has a syntax error on line ${line[1]}.` : 'The file has a syntax error.';
}

function tooMany(maxTriples: number): RdfParseError {
  return new RdfParseError('too_large', `The file has more than ${maxTriples.toLocaleString('en-US')} triples, the most one import can hold.`);
}

function tooBig(maxBytes: number): RdfParseError {
  return new RdfParseError('too_large', `The file is larger than ${maxBytes} bytes, the most one import can hold.`);
}

/** Turtle or N-Quads, streamed. */
function parseStream(input: Readable, format: 'turtle' | 'nquads', options: ParseRdfOptions): Promise<ImportQuad[]> {
  return new Promise((resolve, reject) => {
    const parser = new StreamParser({ format: format === 'turtle' ? 'text/turtle' : 'application/n-quads' });
    const out: ImportQuad[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (error: RdfParseError) => {
      if (settled) return;
      settled = true;
      input.unpipe(parser);
      input.destroy();
      parser.destroy();
      reject(error);
    };
    input.on('data', (chunk: Buffer | string) => {
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > options.maxBytes) fail(tooBig(options.maxBytes));
    });
    input.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    parser.on('data', (quad: Quad) => {
      if (settled) return;
      out.push(toImportQuad(quad));
      if (out.length > options.maxTriples) fail(tooMany(options.maxTriples));
    });
    parser.on('error', (error: unknown) => fail(new RdfParseError('parse_error', syntaxMessage(error))));
    parser.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(out);
    });
    input.pipe(parser);
  });
}

async function readAll(input: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    bytes += buf.length;
    if (bytes > maxBytes) {
      input.destroy();
      throw tooBig(maxBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** The context URLs the loader serves: this application's own, and nothing else. */
export function bundledContextUrls(ns: string): string[] {
  return [`${ns}context`, `${ns}context.jsonld`];
}

/** A `documentLoader` that serves the bundled `@context` and refuses every other URL. */
export function refusingDocumentLoader(ns: string) {
  const allowed = new Set(bundledContextUrls(ns));
  const document = { '@context': buildJsonLdContext(ns) };
  return async (url: string) => {
    if (allowed.has(url)) return { contextUrl: undefined, documentUrl: url, document };
    throw new RdfParseError('parse_error', 'The file refers to a remote JSON-LD context, which imports never load.');
  };
}

async function parseJsonLd(input: Readable, options: ParseRdfOptions): Promise<ImportQuad[]> {
  const buffer = await readAll(input, options.maxBytes);
  let document: unknown;
  try {
    document = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new RdfParseError('parse_error', 'The file is not valid JSON.');
  }
  let nquads: string;
  try {
    nquads = (await jsonld.toRDF(document as jsonld.JsonLdDocument, {
      format: 'application/n-quads',
      documentLoader: refusingDocumentLoader(options.ns) as never,
    })) as unknown as string;
  } catch (error) {
    if (error instanceof RdfParseError) throw error;
    const cause = (error as { details?: { cause?: unknown } } | null)?.details?.cause;
    if (cause instanceof RdfParseError) throw cause;
    throw new RdfParseError('parse_error', 'The file is not valid JSON-LD.');
  }
  const out: ImportQuad[] = [];
  try {
    for (const quad of new Parser({ format: 'application/n-quads' }).parse(nquads)) {
      out.push(toImportQuad(quad));
      if (out.length > options.maxTriples) throw tooMany(options.maxTriples);
    }
  } catch (error) {
    if (error instanceof RdfParseError) throw error;
    throw new RdfParseError('parse_error', 'The file is not valid JSON-LD.');
  }
  return out;
}

/** Parse an uploaded file of `format` into plain quads. Throws `RdfParseError`. */
export function parseRdf(input: Readable, format: GraphImportFormat, options: ParseRdfOptions): Promise<ImportQuad[]> {
  return format === 'jsonld' ? parseJsonLd(input, options) : parseStream(input, format, options);
}

/** Parse trusted Turtle text this application generated (the SHACL shapes). */
export function parseTurtleText(text: string): ImportQuad[] {
  return new Parser({ format: 'text/turtle' }).parse(text).map(toImportQuad);
}
