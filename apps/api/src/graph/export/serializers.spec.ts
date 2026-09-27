import * as jsonld from 'jsonld';
import { Parser, type Quad } from 'n3';
import { ONTOLOGY } from '@app/shared/ontology';

import { FIXTURE_NS as NS, userDef, validateShacl } from '../../../test/graph/rdf/rdf-fixtures';
import { generateShacl } from '../rdf/shacl-generator';
import { buildJsonLdContext } from './jsonld-context';
import { GraphRdfDatasetBuilder, type RdfSubjectBlock } from './rdf-dataset-builder';
import { blocksToNQuads, serializeGraph } from './serializers';
import type { GraphExportFormat } from './graph-export-formats';

// =============================================================================
// Serializers (#386, docs/specs/ontology.md §18.2 item 3)
//
// A small fixture graph built through the real builder, written in all three
// formats: byte-identical across runs, parseable, the JSON-LD context
// round-trips through `jsonld.expand`, and every format yields the SAME
// triples — which conform to the generated SHACL shapes (rdf-validate-shacl).
// =============================================================================

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TIER = userDef({
  id: '11111111-1111-4111-8111-111111111111',
  entityType: 'Organization',
  key: 'u_tier000001',
  label: 'Tier',
  kind: 'select',
  options: { choices: [{ value: 'gold', label: 'Gold' }] },
});

function fixtureBatches(): RdfSubjectBlock[][] {
  const b = new GraphRdfDatasetBuilder({
    ns: NS,
    registry: ONTOLOGY,
    attributeDefs: [TIER],
    exportId: id(99),
    generatedAt: new Date('2026-09-01T00:00:00Z'),
    ontologyVersion: ONTOLOGY.version,
  });
  const works = {
    id: id(20),
    type: 'WORKS_FOR',
    fromId: id(1),
    fromType: 'Person',
    toId: id(2),
    toType: 'Organization',
    props: {},
    validFrom: new Date('2019-01-01T00:00:00Z'),
    validTo: new Date('2024-01-01T00:00:00Z'),
    validPrecision: 'year',
    reviewStatus: 'accepted',
    confidence: 0.8,
    ontologyVersion: '1.0.0',
  };
  const entity = (n: number, type: string, label: string, extra: object = {}) => ({
    id: id(n),
    type,
    label,
    props: {},
    reviewStatus: 'accepted',
    occurredAt: null,
    ontologyVersion: '1.0.0',
    aliases: [label],
    evidenceIds: [id(50 + n)],
    refTypes: new Map<string, string>(),
    outgoing: [],
    ...extra,
  });
  const blocks = (xs: Array<RdfSubjectBlock | null>) => xs.filter((x): x is RdfSubjectBlock => x !== null);
  return [
    [b.ontologyHeader(), ...b.attributeDefinitions()],
    blocks([
      b.entity(entity(1, 'Person', 'Sarah "SC" Chen', { aliases: ['Sarah'], outgoing: [works] })),
      b.entity(entity(2, 'Organization', 'Acme', { props: { website: 'https://acme.example', u_tier000001: 'gold' } })),
      b.entity(entity(3, 'Meeting', 'Pilot sync', { occurredAt: new Date('2026-04-02T15:00:00Z') })),
    ]),
    blocks(
      [51, 52, 53, 54, 55].map((n) =>
        b.evidence({
          id: id(n),
          subjectKind: n === 54 ? 'relation' : n === 55 ? 'item' : 'entity',
          subjectSensitivity: null,
          quote: `quote ${n}\nwith a newline and ünïcode`,
          segmentId: id(60),
          startMs: 1500,
          endMs: 4000,
          noteId: null,
          noteVersion: null,
          charStart: 0,
          charEnd: 5,
        }),
      ),
    ),
    [b.exportHeader()],
    blocks([
      b.item({
        id: id(30),
        kind: 'commitment',
        title: 'Send the proposal',
        statement: 'Sarah will send the proposal.',
        status: 'open',
        props: {},
        occurredAt: null,
        dueAt: new Date('2026-04-10T17:00:00Z'),
        validFrom: null,
        validTo: null,
        validPrecision: null,
        reviewStatus: 'accepted',
        confidence: null,
        sensitivity: null,
        ontologyVersion: '1.0.0',
        subject: { id: id(2), type: 'Organization' },
        meeting: { id: id(3), type: 'Meeting' },
        ownerPerson: { id: id(1), type: 'Person' },
        counterparty: null,
        supersedes: [],
        evidenceIds: [id(55)],
        refTypes: new Map(),
      }),
    ]),
    blocks([b.relation({ ...works, evidenceIds: [id(54)] })]),
    [b.segmentLabel(id(60), 'Weekly sync')],
  ];
}

async function* asAsync<T>(xs: T[]): AsyncGenerator<T> {
  for (const x of xs) yield x;
}

async function render(format: GraphExportFormat): Promise<string> {
  let out = '';
  for await (const chunk of serializeGraph(format, NS, asAsync(fixtureBatches()))) out += chunk;
  return out;
}

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
    expect(report.results.map((r) => [r.focusNode?.value, r.path?.value, r.message[0]?.value])).toEqual([]);
    expect(report.conforms).toBe(true);
  });
});
