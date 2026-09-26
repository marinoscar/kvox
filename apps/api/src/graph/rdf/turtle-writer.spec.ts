import { Parser, type Quad } from 'n3';

import {
  RDF_TYPE,
  bnode,
  escapeLiteral,
  iri,
  list,
  literal,
  po,
  writeTurtle,
  type TurtleDocument,
} from './turtle-writer';

// =============================================================================
// turtle-writer (#385): escaping, lists, blank nodes, ordering — and every
// output parsed back with `n3`, the reader #386/#387 use, so "valid Turtle" is
// checked by a real parser rather than by eye.
// =============================================================================

const EX = 'http://example.org/ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

const parse = (turtle: string): Quad[] => new Parser().parse(turtle);

/** The object values of `subject predicate ?o`, in document order. */
function objects(quads: Quad[], subject: string, predicate: string) {
  return quads.filter((q) => q.subject.value === subject && q.predicate.value === predicate).map((q) => q.object);
}

/** Walks an RDF list from its head node to rdf:nil. */
function listValues(quads: Quad[], head: string): string[] {
  const out: string[] = [];
  let node = head;
  while (node !== `${RDF}nil`) {
    out.push(objects(quads, node, `${RDF}first`)[0].value);
    node = objects(quads, node, `${RDF}rest`)[0].value;
  }
  return out;
}

const doc = (subjects: TurtleDocument['subjects'], prefixes: Record<string, string> = { ex: EX }): TurtleDocument => ({
  prefixes,
  subjects,
});

describe('escapeLiteral', () => {
  it.each([
    ['a "quote"', 'a \\"quote\\"'],
    ['back\\slash', 'back\\\\slash'],
    ['line\nbreak', 'line\\nbreak'],
    ['carriage\rreturn', 'carriage\\rreturn'],
    ['tab\there', 'tab\\there'],
    ['bell\u0007', 'bell\\u0007'],
    ['delete\u007f', 'delete\\u007F'],
    ['emoji \u{1F600}', 'emoji \\U0001F600'],
    ['lone \ud800 surrogate', 'lone \\uFFFD surrogate'],
    ['lone \udc00 low', 'lone \\uFFFD low'],
    ['plain café', 'plain café'],
  ])('escapes %j', (input, expected) => {
    expect(escapeLiteral(input)).toBe(expected);
  });

  it('round-trips every escaped character through n3', () => {
    const value = 'q"b\\n\nr\rt\t\u0001 \u{1F600} é';
    const turtle = writeTurtle(doc([{ subject: `${EX}s`, props: [po(`${EX}p`, literal(value))] }]));
    expect(objects(parse(turtle), `${EX}s`, `${EX}p`)[0].value).toBe(value);
  });
});

describe('writeTurtle', () => {
  it('writes a sorted prefix block, then subjects sorted by IRI', () => {
    const turtle = writeTurtle(
      doc(
        [
          { subject: `${EX}b`, props: [po(`${EX}p`, literal('2'))] },
          { subject: `${EX}a`, props: [po(`${EX}p`, literal('1'))] },
        ],
        { z: 'http://z.example/', ex: EX },
      ),
    );
    expect(turtle).toBe(
      [
        '@prefix ex: <http://example.org/ns#> .',
        '@prefix z: <http://z.example/> .',
        '',
        'ex:a',
        '    ex:p "1" .',
        '',
        'ex:b',
        '    ex:p "2" .',
        '',
      ].join('\n'),
    );
  });

  it('writes rdf:type first as `a`, then predicates sorted, and sorts and de-duplicates objects', () => {
    const turtle = writeTurtle(
      doc([
        {
          subject: `${EX}s`,
          props: [po(`${EX}z`, literal('b'), literal('a'), literal('b')), po(`${EX}m`, iri(`${EX}o`)), po(RDF_TYPE, iri(`${EX}C`))],
        },
      ]),
    );
    expect(turtle.split('\n').slice(2)).toEqual([
      'ex:s',
      '    a ex:C ;',
      '    ex:m ex:o ;',
      '    ex:z "a",',
      '        "b" .',
      '',
    ]);
  });

  it('merges a subject described twice', () => {
    const turtle = writeTurtle(
      doc([
        { subject: `${EX}s`, props: [po(`${EX}p`, literal('one'))] },
        { subject: `${EX}s`, props: [po(`${EX}p`, literal('two')), po(`${EX}q`, literal('x'))] },
      ]),
    );
    const quads = parse(turtle);
    expect(objects(quads, `${EX}s`, `${EX}p`).map((o) => o.value).sort()).toEqual(['one', 'two']);
    expect(turtle.match(/^ex:s$/gm)).toHaveLength(1);
  });

  it('is byte-identical regardless of the order subjects, predicates and objects are given in', () => {
    const a = writeTurtle(
      doc([
        { subject: `${EX}a`, props: [po(`${EX}p`, literal('1'), literal('2')), po(`${EX}q`, iri(`${EX}x`))] },
        { subject: `${EX}b`, props: [po(`${EX}p`, literal('3'))] },
      ]),
    );
    const b = writeTurtle(
      doc([
        { subject: `${EX}b`, props: [po(`${EX}p`, literal('3'))] },
        { subject: `${EX}a`, props: [po(`${EX}q`, iri(`${EX}x`)), po(`${EX}p`, literal('2'), literal('1'))] },
      ]),
    );
    expect(a).toBe(b);
  });

  it('writes typed and language-tagged literals, with Turtle shorthand for booleans and integers', () => {
    const turtle = writeTurtle(
      doc(
        [
          {
            subject: `${EX}s`,
            props: [
              po(`${EX}bool`, literal('true', { datatype: `${XSD}boolean` })),
              po(`${EX}int`, literal('42', { datatype: `${XSD}integer` })),
              po(`${EX}dec`, literal('1.5', { datatype: `${XSD}decimal` })),
              po(`${EX}str`, literal('plain', { datatype: `${XSD}string` })),
              po(`${EX}lang`, literal('hola', { lang: 'es-CR' })),
            ],
          },
        ],
        { ex: EX, xsd: XSD },
      ),
    );
    expect(turtle).toContain('ex:bool true');
    expect(turtle).toContain('ex:int 42');
    expect(turtle).toContain('ex:dec "1.5"^^xsd:decimal');
    expect(turtle).toContain('ex:str "plain"');
    expect(turtle).toContain('ex:lang "hola"@es-cr');

    const quads = parse(turtle);
    const obj = (p: string) => objects(quads, `${EX}s`, `${EX}${p}`)[0] as { value: string; datatype: { value: string }; language: string };
    expect(obj('bool').datatype.value).toBe(`${XSD}boolean`);
    expect(obj('int').datatype.value).toBe(`${XSD}integer`);
    expect(obj('dec').datatype.value).toBe(`${XSD}decimal`);
    expect(obj('lang').language).toBe('es-cr');
  });

  it('refuses a literal that is both typed and language-tagged, and a malformed language tag', () => {
    expect(() => literal('x', { datatype: `${XSD}string`, lang: 'en' })).toThrow(/not both/);
    expect(() =>
      writeTurtle(doc([{ subject: `${EX}s`, props: [po(`${EX}p`, literal('x', { lang: 'not a tag' }))] }])),
    ).toThrow(/language tag/);
  });

  it('writes RDF lists in their given order, including lists of blank nodes', () => {
    const turtle = writeTurtle(
      doc([
        {
          subject: `${EX}s`,
          props: [
            po(`${EX}in`, list([literal('c'), literal('a'), literal('b')])),
            po(`${EX}or`, list([bnode([po(`${EX}class`, iri(`${EX}B`))]), bnode([po(`${EX}class`, iri(`${EX}A`))])])),
            po(`${EX}empty`, list([])),
          ],
        },
      ]),
    );
    expect(turtle).toContain('ex:in ( "c" "a" "b" )');
    expect(turtle).toContain('ex:or ( [ ex:class ex:B ] [ ex:class ex:A ] )');
    expect(turtle).toContain('ex:empty ()');

    const quads = parse(turtle);
    expect(listValues(quads, objects(quads, `${EX}s`, `${EX}in`)[0].value)).toEqual(['c', 'a', 'b']);
    const orNodes = listValues(quads, objects(quads, `${EX}s`, `${EX}or`)[0].value);
    expect(orNodes.map((node) => objects(quads, node, `${EX}class`)[0].value)).toEqual([`${EX}B`, `${EX}A`]);
    expect(objects(quads, `${EX}s`, `${EX}empty`)[0].value).toBe(`${RDF}nil`);
  });

  it('writes nested blank-node property lists that parse back to the same structure', () => {
    const turtle = writeTurtle(
      doc([
        {
          subject: `${EX}shape`,
          props: [
            po(
              `${EX}property`,
              bnode([po(`${EX}path`, iri(`${EX}a`)), po(`${EX}not`, bnode([po(`${EX}hasValue`, literal('v'))]))]),
              bnode([po(`${EX}path`, iri(`${EX}b`))]),
            ),
          ],
        },
      ]),
    );
    const quads = parse(turtle);
    const props = objects(quads, `${EX}shape`, `${EX}property`);
    expect(props).toHaveLength(2);
    const paths = props.map((node) => objects(quads, node.value, `${EX}path`)[0].value).sort();
    expect(paths).toEqual([`${EX}a`, `${EX}b`]);
    const withNot = props.find((node) => objects(quads, node.value, `${EX}not`).length === 1)!;
    const not = objects(quads, withNot.value, `${EX}not`)[0];
    expect(objects(quads, not.value, `${EX}hasValue`)[0].value).toBe('v');
  });

  it('abbreviates with the most specific prefix, and writes a full <IRI> when the local part is unsafe', () => {
    const turtle = writeTurtle(
      doc(
        [
          {
            subject: `${EX}s`,
            props: [
              po(`${EX}p`, iri(`${EX}attr/1234`), iri(`${EX}Type.attr`), iri(`${EX}trailing.`), iri(`${EX}sub/leaf`)),
            ],
          },
        ],
        { ex: EX, exs: `${EX}sub/` },
      ),
    );
    expect(turtle).toContain('<http://example.org/ns#attr/1234>');
    expect(turtle).toContain('ex:Type.attr');
    expect(turtle).toContain('<http://example.org/ns#trailing.>');
    expect(turtle).toContain('exs:leaf');
    const values = objects(parse(turtle), `${EX}s`, `${EX}p`).map((o) => o.value).sort();
    expect(values).toEqual([`${EX}Type.attr`, `${EX}attr/1234`, `${EX}sub/leaf`, `${EX}trailing.`].sort());
  });

  it.each(['http://example.com/a b', 'http://example.com/<x>', 'http://example.com/"q"', 'http://example.com/a\\b'])(
    'refuses an IRI no Turtle reader could accept: %j',
    (bad) => {
      expect(() => writeTurtle(doc([{ subject: `${EX}s`, props: [po(`${EX}p`, iri(bad))] }]))).toThrow(/no IRI may contain/);
    },
  );

  it('writes the namespace IRI itself as the bare prefix', () => {
    const turtle = writeTurtle(doc([{ subject: EX, props: [po(RDF_TYPE, iri(`${EX}Ontology`))] }]));
    expect(turtle).toContain('\nex:\n    a ex:Ontology .');
    expect(parse(turtle)[0].subject.value).toBe(EX);
  });

  it('drops a subject with no predicates and ends with exactly one newline', () => {
    const turtle = writeTurtle(doc([{ subject: `${EX}empty`, props: [] }]));
    expect(turtle).toBe('@prefix ex: <http://example.org/ns#> .\n');
  });

  it('refuses an invalid prefix name', () => {
    expect(() => writeTurtle(doc([], { 'bad prefix': EX }))).toThrow(/prefix name/);
  });
});
