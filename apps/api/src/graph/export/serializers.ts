// =============================================================================
// RDF serializers for a graph export: Turtle, N-Quads, JSON-LD (issue #386,
// docs/specs/ontology.md §18.2 item 3, §18.4)
// =============================================================================
//
// Turns the builder's subject blocks into text, one batch (a page of rows) at
// a time, as an async generator of string chunks — so `kg.export` streams the
// file into object storage without ever holding it whole.
//
//   Turtle, N-Quads — `n3`'s `Writer`, fed one batch at a time. It writes into
//     a small in-memory sink that is drained after each batch, so its grouping
//     state (`;` between one subject's predicates) survives across batches
//     while the bytes leave as they are produced.
//   JSON-LD — each batch goes through `jsonld.fromRDF` then `jsonld.compact`
//     with the generated `@context` (`jsonld-context.ts`); the resulting node
//     objects are streamed into one `{"@context": …, "@graph": [ … ]}`
//     document. Compaction is node-local, so compacting per batch yields the
//     same nodes as compacting the whole graph at once.
//
// DETERMINISTIC: the builder orders every block and every triple; these
// writers add nothing that varies between runs (no timestamps, no random
// blank-node labels — `jsonld` keeps the builder's labels).
//
// ⚠ §18.4: the ONE file in `apps/api/src` that imports `n3` and `jsonld`, and
// only the `kg.export` job handler calls it — never a request handler.
// `test/graph/rdf/rdf-imports.spec.ts` pins both halves of that.
// =============================================================================

import * as jsonld from 'jsonld';
import { DataFactory, Writer, type Quad, type Quad_Object, type Quad_Subject } from 'n3';

import { artefactPrefixes } from '../rdf/ontology-rdf-model';
import type { GraphExportFormat } from './graph-export-formats';
import { buildJsonLdContext } from './jsonld-context';
import type { RdfSubjectBlock, RdfTerm, RdfTriple } from './rdf-dataset-builder';

const { namedNode, blankNode, literal, quad } = DataFactory;

function toN3Term(term: RdfTerm): Quad_Object {
  switch (term.termType) {
    case 'NamedNode':
      return namedNode(term.value);
    case 'BlankNode':
      return blankNode(term.value);
    case 'Literal':
      return literal(term.value, namedNode(term.datatype));
  }
}

function toN3Quad(t: RdfTriple): Quad {
  const subject: Quad_Subject = t.subject.termType === 'NamedNode' ? namedNode(t.subject.value) : blankNode(t.subject.value);
  return quad(subject, namedNode(t.predicate.value), toN3Term(t.object));
}

/** What `n3`'s Writer writes into between drains. */
class ChunkSink {
  private parts: string[] = [];
  write(chunk: string, _encoding?: unknown, callback?: () => void): boolean {
    this.parts.push(chunk);
    callback?.();
    return true;
  }
  take(): string {
    const out = this.parts.join('');
    this.parts = [];
    return out;
  }
}

async function* serializeWithN3(
  format: 'Turtle' | 'N-Quads',
  ns: string,
  batches: AsyncIterable<readonly RdfSubjectBlock[]>,
): AsyncGenerator<string> {
  const sink = new ChunkSink();
  const writer = new Writer(sink as unknown as NodeJS.WritableStream, {
    format,
    end: false,
    ...(format === 'Turtle' ? { prefixes: artefactPrefixes(ns) } : {}),
  });
  for await (const batch of batches) {
    for (const block of batch) for (const t of block.triples) writer.addQuad(toN3Quad(t));
    const chunk = sink.take();
    if (chunk.length > 0) yield chunk;
  }
  await new Promise<void>((resolve, reject) => writer.end((error) => (error ? reject(error) : resolve())));
  const tail = sink.take();
  if (tail.length > 0) yield tail;
}

/** One batch as an N-Quads string — the input `jsonld.fromRDF` reads. */
export function blocksToNQuads(blocks: readonly RdfSubjectBlock[]): string {
  const writer = new Writer({ format: 'N-Quads' });
  return writer.quadsToString(blocks.flatMap((b) => b.triples.map(toN3Quad)));
}

async function* serializeJsonLd(ns: string, batches: AsyncIterable<readonly RdfSubjectBlock[]>): AsyncGenerator<string> {
  const context = buildJsonLdContext(ns);
  yield `{"@context":${JSON.stringify(context)},"@graph":[`;
  let first = true;
  for await (const batch of batches) {
    if (batch.length === 0) continue;
    const expanded = await jsonld.fromRDF(blocksToNQuads(batch), { format: 'application/n-quads' });
    const compacted = (await jsonld.compact(expanded, context as jsonld.ContextDefinition)) as Record<string, unknown>;
    const nodes = Array.isArray(compacted['@graph'])
      ? (compacted['@graph'] as unknown[])
      : [Object.fromEntries(Object.entries(compacted).filter(([key]) => key !== '@context'))];
    let chunk = '';
    for (const node of nodes) {
      chunk += `${first ? '\n' : ',\n'}${JSON.stringify(node)}`;
      first = false;
    }
    if (chunk.length > 0) yield chunk;
  }
  yield '\n]}\n';
}

/**
 * Serializes batches of subject blocks as `format`, yielding string chunks in
 * order. `ns` is the application namespace (`kvNamespace(APP_SLUG)`).
 */
export function serializeGraph(
  format: GraphExportFormat,
  ns: string,
  batches: AsyncIterable<readonly RdfSubjectBlock[]>,
): AsyncGenerator<string> {
  switch (format) {
    case 'turtle':
      return serializeWithN3('Turtle', ns, batches);
    case 'nquads':
      return serializeWithN3('N-Quads', ns, batches);
    case 'jsonld':
      return serializeJsonLd(ns, batches);
  }
}
