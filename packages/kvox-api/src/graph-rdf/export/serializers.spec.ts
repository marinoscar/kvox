import * as jsonld from 'jsonld';
import { Parser, type Quad } from 'n3';
import { ONTOLOGY } from '@marinoscar/kvox-contract/ontology';

import { asAsync, FIXTURE_TIER_DEF, fixtureBatches, fixtureId, renderFixtureExport } from '../testing/export-fixture.js';
import { FIXTURE_NS as NS, validateShacl } from '../testing/rdf-fixtures.js';
import { generateShacl } from '../rdf/shacl-generator.js';
import { buildJsonLdContext } from './jsonld-context.js';
import type { RdfSubjectBlock } from './rdf-dataset-builder.js';
import { blocksToNQuads, serializeGraph } from './serializers.js';

// =============================================================================
// Serializers (#386, docs/specs/ontology.md §18.2 item 3)
//
// A small fixture graph built through the real builder, written in all three
// formats: byte-identical across runs, parseable, the JSON-LD context
// round-trips through `jsonld.expand`, and every format yields the SAME
// triples — which conform to the generated SHACL shapes (rdf-validate-shacl).
// =============================================================================

const id = fixtureId;
const TIER = FIXTURE_TIER_DEF;
const render = renderFixtureExport;

const canonical = (quads: readonly Quad[]) =>
  quads
    .map((q) => `${q.subject.termType}:${q.subject.value} ${q.predicate.value} ${q.object.termType}:${q.object.value}${q.object.termType === 'Literal' ? `^^${(q.object as { datatype: { value: string } }).datatype.value}` : ''}`)
    .map((line) => line.replace(/BlankNode:\S+/g, 'BlankNode'))
    .sort();

async function jsonLdQuads(doc: string): Promise<Quad[]> {
  const nquads = (await jsonld.toRDF(JSON.parse(doc), { format: 'application/n-quads' })) as unknown as string;
  return new Parser({ format: 'N-Quads' }).parse(nquads);
}

describe('serializeGraph', () => {
  it.each(['turtle', 'nquads', 'jsonld'] as const)('%s output is byte-identical across runs', async (format) => {
    expect(await render(format)).toBe(await render(format));
  });

  it('Turtle declares the artefact prefixes and parses with n3', async () => {
    const ttl = await render('turtle');
    expect(ttl.startsWith('@prefix ')).toBe(true);
    expect(ttl).toContain(`@prefix kv: <${NS}>.`);
    expect(new Parser().parse(ttl).length).toBeGreaterThan(20);
  });

  it('N-Quads parses and carries no prefixes', async () => {
    const nq = await render('nquads');
    expect(nq).not.toContain('@prefix');
    expect(new Parser({ format: 'N-Quads' }).parse(nq).length).toBeGreaterThan(20);
  });

  it('every format carries exactly the same triples', async () => {
    const ttl = canonical(new Parser().parse(await render('turtle')));
    const nq = canonical(new Parser({ format: 'N-Quads' }).parse(await render('nquads')));
    const jl = canonical(await jsonLdQuads(await render('jsonld')));
    expect(nq).toEqual(ttl);
    expect(jl).toEqual(ttl);
  });

  it('JSON-LD is one document compacted with the generated context, which expands back', async () => {
    const doc = JSON.parse(await render('jsonld')) as { '@context': Record<string, string>; '@graph': Array<Record<string, unknown>> };
    expect(doc['@context']).toEqual(buildJsonLdContext(NS));
    expect(doc['@context'].kv).toBe(NS);
    const person = doc['@graph'].find((n) => n['@id'] === `kv:entity/${id(1)}`)!;
    expect(person['@type']).toEqual(['kv:Person', 'schema:Person']);
    const expanded = (await jsonld.expand(doc as unknown as jsonld.JsonLdDocument, {})) as Array<Record<string, unknown>>;
    const expandedPerson = expanded.find((n) => n['@id'] === `${NS}entity/${id(1)}`)!;
    expect(expandedPerson['@type']).toEqual([`${NS}Person`, 'https://schema.org/Person']);
    expect(expandedPerson[`${NS}WORKS_FOR`]).toEqual([{ '@id': `${NS}entity/${id(2)}` }]);
  });

  it('an empty batch list still yields a well-formed document in every format', async () => {
    for (const format of ['turtle', 'nquads', 'jsonld'] as const) {
      let out = '';
      for await (const chunk of serializeGraph(format, NS, asAsync<RdfSubjectBlock[]>([]))) out += chunk;
      if (format === 'jsonld') expect(JSON.parse(out)['@graph']).toEqual([]);
      else expect(() => new Parser(format === 'nquads' ? { format: 'N-Quads' } : {}).parse(out)).not.toThrow();
    }
  });

  it('blocksToNQuads writes one line per triple', () => {
    const [header] = fixtureBatches();
    expect(blocksToNQuads(header).trim().split('\n')).toHaveLength(header.reduce((n, b) => n + b.triples.length, 0));
  });
});

describe('the fixture export conforms to the generated SHACL shapes', () => {
  const shapes = () => new Parser().parse(generateShacl(ONTOLOGY, [TIER], NS));

  it.each(['turtle', 'jsonld'] as const)('%s', async (format) => {
    const text = await render(format);
    const quads = format === 'turtle' ? new Parser().parse(text) : await jsonLdQuads(text);
    const report = await validateShacl(shapes(), quads);
    expect(report.results.map((r) => [r.focusNode, r.path, r.message])).toEqual([]);
    expect(report.conforms).toBe(true);
  });
});
