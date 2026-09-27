import { Readable } from 'node:stream';

import { RdfParseError, bundledContextUrls, parseRdf, parseTurtleText, refusingDocumentLoader } from './rdf-parse';

// #387 — the one import file that uses `n3`/`jsonld`: every format, the caps,
// and the refusals, with messages that never quote the file.

const NS = 'https://fixture.app/ns#';
const OPTS = { maxTriples: 1000, maxBytes: 1_000_000, ns: NS };
const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

const TTL = `@prefix kv: <${NS}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://s.example/joe> a kv:Person ; rdfs:label "Joe"@en ; kv:x 42 .`;

async function failure(p: Promise<unknown>): Promise<RdfParseError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof RdfParseError) return error;
    throw error;
  }
  throw new Error('expected a parse failure');
}

describe('parseRdf', () => {
  it('parses Turtle into plain quads, keeping datatypes and languages', async () => {
    const quads = await parseRdf(stream(TTL), 'turtle', OPTS);
    expect(quads).toHaveLength(3);
    expect(quads[0]).toEqual({
      s: { termType: 'NamedNode', value: 'https://s.example/joe' },
      p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      o: { termType: 'NamedNode', value: `${NS}Person` },
    });
    expect(quads[1].o).toEqual({ termType: 'Literal', value: 'Joe', datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString', language: 'en' });
    expect(quads[2].o).toEqual({ termType: 'Literal', value: '42', datatype: 'http://www.w3.org/2001/XMLSchema#integer' });
  });

  it('parses N-Quads, merging named graphs into one', async () => {
    const nq = `<https://s.example/a> <${NS}p> "v" <https://g.example/1> .\n<https://s.example/b> <${NS}p> _:b1 .\n`;
    const quads = await parseRdf(stream(nq), 'nquads', OPTS);
    expect(quads.map((q) => q.s.value)).toEqual(['https://s.example/a', 'https://s.example/b']);
    expect(quads[1].o.termType).toBe('BlankNode');
  });

  it('parses JSON-LD with an inline context', async () => {
    const doc = { '@context': { kv: NS, label: 'http://www.w3.org/2000/01/rdf-schema#label' }, '@id': 'https://s.example/joe', '@type': 'kv:Person', label: 'Joe' };
    const quads = await parseRdf(stream(JSON.stringify(doc)), 'jsonld', OPTS);
    expect(quads).toHaveLength(2);
    expect(quads.some((q) => q.o.value === `${NS}Person`)).toBe(true);
  });

  it('refuses a remote JSON-LD context — never fetched', async () => {
    const doc = { '@context': 'https://evil.example/context.jsonld', '@id': 'https://s.example/joe', name: 'Joe' };
    const error = await failure(parseRdf(stream(JSON.stringify(doc)), 'jsonld', OPTS));
    expect(error.reason).toBe('parse_error');
    expect(error.message).toMatch(/remote JSON-LD context/);
  });

  it('serves only the bundled context', async () => {
    const loader = refusingDocumentLoader(NS);
    for (const url of bundledContextUrls(NS)) {
      await expect(loader(url)).resolves.toMatchObject({ documentUrl: url, document: { '@context': expect.objectContaining({ kv: NS }) } });
    }
    await expect(loader('https://other.example/ctx')).rejects.toBeInstanceOf(RdfParseError);
  });

  it('reports a Turtle syntax error by line only', async () => {
    const error = await failure(parseRdf(stream('@prefix kv: <x#> .\n\n<a> <b> "secret-value'), 'turtle', OPTS));
    expect(error.reason).toBe('parse_error');
    expect(error.message).toMatch(/^The file has a syntax error( on line \d+)?\.$/);
    expect(error.message).not.toContain('secret');
  });

  it('reports invalid JSON', async () => {
    expect((await failure(parseRdf(stream('{not json'), 'jsonld', OPTS))).message).toBe('The file is not valid JSON.');
  });

  it('stops at the triple cap with too_large', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `<https://s.example/${i}> <${NS}p> "v" .`).join('\n');
    const error = await failure(parseRdf(stream(many), 'nquads', { ...OPTS, maxTriples: 10 }));
    expect(error.reason).toBe('too_large');
  });

  it('stops at the byte cap with too_large', async () => {
    const error = await failure(parseRdf(stream(TTL), 'turtle', { ...OPTS, maxBytes: 10 }));
    expect(error.reason).toBe('too_large');
    expect((await failure(parseRdf(stream('{"a":1}'), 'jsonld', { ...OPTS, maxBytes: 3 }))).reason).toBe('too_large');
  });
});

describe('parseTurtleText', () => {
  it('parses generated Turtle synchronously', () => {
    expect(parseTurtleText(TTL)).toHaveLength(3);
  });
});
