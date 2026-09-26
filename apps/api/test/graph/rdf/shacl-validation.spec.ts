import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Quad } from 'n3';
import { ONTOLOGY } from '@app/shared/ontology';

import { generateShacl } from '../../../src/graph/rdf/shacl-generator';
import { FIXTURE_NS as NS, PROV, SH, esmImport, parseTurtle, userDef } from './rdf-fixtures';

// =============================================================================
// The generated SHACL shapes, run through a real SHACL engine (#385)
// =============================================================================
//
// `rdf-validate-shacl` is the engine §18.4 names for #386's export check and
// #387's import validation. Here it validates two hand-written graphs against
// the shapes `generateShacl` produces: `fixtures/valid-graph.ttl` must conform,
// and `fixtures/invalid-graph.ttl` must yield EXACTLY the four violations it
// was written to contain — an orphan, a select value, a closed-shape property
// and an endpoint class — no more (a shape too strict for real data) and no
// fewer (a rule the shapes fail to express).
//
// Both libraries are ESM-only and test-only in this issue (§18.4: RDF
// libraries never enter the request path), so they are loaded through
// `esmImport`.
// =============================================================================

interface ValidationResult {
  focusNode: { value: string } | null;
  path: { value: string } | null;
  sourceConstraintComponent: { value: string } | null;
}
interface ValidationReport {
  conforms: boolean;
  results: ValidationResult[];
}
type Validator = new (shapes: unknown) => { validate(data: unknown): Promise<ValidationReport> };
interface RdfExt {
  dataset(quads?: Iterable<Quad>): unknown;
}

const TIER_ID = '11111111-1111-4111-8111-111111111111';
const SENSITIVE_ID = '33333333-3333-4333-8333-333333333333';

const defs = [
  userDef({
    id: TIER_ID,
    entityType: 'Organization',
    key: 'u_tier000001',
    label: 'Tier',
    kind: 'select',
    options: { choices: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }] },
  }),
  userDef({ id: SENSITIVE_ID, entityType: 'Person', label: 'Medical note', sensitivity: 'sensitive' }),
];

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

const PREFIXES = `
@prefix kv: <${NS}> .
@prefix ent: <${NS}entity/> .
@prefix rel: <${NS}relation/> .
@prefix seg: <${NS}segment/> .
@prefix prov: <${PROV}> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

describe('generated SHACL shapes validate hand-written graph data (rdf-validate-shacl)', () => {
  let validate: (turtle: string) => Promise<ValidationReport>;

  beforeAll(async () => {
    const { default: SHACLValidator } = await esmImport<{ default: Validator }>('rdf-validate-shacl');
    const { default: rdf } = await esmImport<{ default: RdfExt }>('rdf-ext');
    const shapes = rdf.dataset(parseTurtle(generateShacl(ONTOLOGY, defs, NS)));
    validate = async (turtle: string) => new SHACLValidator(shapes).validate(rdf.dataset(parseTurtle(turtle)));
  });

  const summarize = (report: ValidationReport) =>
    report.results
      .map((r) => ({
        focus: r.focusNode?.value,
        path: r.path?.value,
        component: r.sourceConstraintComponent?.value.replace(SH, 'sh:'),
      }))
      .sort((a, b) => String(a.focus).localeCompare(String(b.focus)));

  it('valid-graph.ttl conforms', async () => {
    const report = await validate(fixture('valid-graph.ttl'));
    expect(summarize(report)).toEqual([]);
    expect(report.conforms).toBe(true);
  });

  it('invalid-graph.ttl yields exactly the four expected violations', async () => {
    const report = await validate(fixture('invalid-graph.ttl'));
    expect(report.conforms).toBe(false);
    expect(summarize(report)).toEqual([
      {
        focus: `${NS}entity/f0000000-0000-4000-8000-000000000001`,
        path: `${PROV}wasDerivedFrom`,
        component: 'sh:MinCountConstraintComponent',
      },
      {
        focus: `${NS}entity/f0000000-0000-4000-8000-000000000002`,
        path: `${NS}Project.status`,
        component: 'sh:InConstraintComponent',
      },
      {
        focus: `${NS}entity/f0000000-0000-4000-8000-000000000003`,
        path: `${NS}Organization.revenue`,
        component: 'sh:ClosedConstraintComponent',
      },
      {
        focus: `${NS}entity/f0000000-0000-4000-8000-000000000004`,
        path: `${NS}WORKS_FOR`,
        component: 'sh:ClassConstraintComponent',
      },
    ]);
  });

  it('requires HAS_ROLE’s title on a HAS_ROLE assertion, and only there', async () => {
    const report = await validate(`${PREFIXES}
      ent:a0000000-0000-4000-8000-000000000001 a kv:Person ; prov:wasDerivedFrom seg:b0000000-0000-4000-8000-000000000001 .
      ent:a0000000-0000-4000-8000-000000000002 a kv:Organization ; prov:wasDerivedFrom seg:b0000000-0000-4000-8000-000000000001 .
      rel:d0000000-0000-4000-8000-000000000001 a kv:Assertion ;
        rdf:subject ent:a0000000-0000-4000-8000-000000000001 ;
        rdf:predicate kv:HAS_ROLE ;
        rdf:object ent:a0000000-0000-4000-8000-000000000002 ;
        prov:wasDerivedFrom seg:b0000000-0000-4000-8000-000000000001 .
      rel:d0000000-0000-4000-8000-000000000002 a kv:Assertion ;
        rdf:subject ent:a0000000-0000-4000-8000-000000000001 ;
        rdf:predicate kv:WORKS_FOR ;
        rdf:object ent:a0000000-0000-4000-8000-000000000002 ;
        prov:wasDerivedFrom seg:b0000000-0000-4000-8000-000000000001 .
    `);
    expect(summarize(report)).toEqual([
      { focus: `${NS}relation/d0000000-0000-4000-8000-000000000001`, path: undefined, component: 'sh:OrConstraintComponent' },
    ]);
  });

  it('rejects an assertion with a bad precision, a non-dateTime start or a non-temporal predicate', async () => {
    const report = await validate(`${PREFIXES}
      rel:d0000000-0000-4000-8000-000000000003 a kv:Assertion ;
        rdf:subject ent:a0000000-0000-4000-8000-000000000001 ;
        rdf:predicate kv:ATTENDED ;
        rdf:object ent:a0000000-0000-4000-8000-000000000002 ;
        prov:startedAtTime "2019" ;
        kv:validPrecision "week" ;
        prov:wasDerivedFrom seg:b0000000-0000-4000-8000-000000000001 .
    `);
    expect(summarize(report).map((r) => [r.path, r.component])).toEqual(
      expect.arrayContaining([
        ['http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate', 'sh:InConstraintComponent'],
        [`${PROV}startedAtTime`, 'sh:DatatypeConstraintComponent'],
        [`${NS}validPrecision`, 'sh:InConstraintComponent'],
      ]),
    );
  });

  it('never admits a sensitive attribute: its property is undeclared on the closed shape', async () => {
    const report = await validate(`${PREFIXES}
      ent:a0000000-0000-4000-8000-000000000001 a kv:Person ;
        <${NS}attr/${SENSITIVE_ID}> "anything" ;
        prov:wasDerivedFrom seg:b0000000-0000-4000-8000-000000000001 .
    `);
    expect(summarize(report)).toEqual([
      {
        focus: `${NS}entity/a0000000-0000-4000-8000-000000000001`,
        path: `${NS}attr/${SENSITIVE_ID}`,
        component: 'sh:ClosedConstraintComponent',
      },
    ]);
  });

  it('rejects a URL that is not http(s), and a caller-defined select value outside its choices', async () => {
    const report = await validate(`${PREFIXES}
      ent:a0000000-0000-4000-8000-000000000002 a kv:Organization ;
        <https://schema.org/url> "ftp://acme.example"^^xsd:anyURI ;
        <${NS}attr/${TIER_ID}> "bronze" ;
        prov:wasDerivedFrom seg:b0000000-0000-4000-8000-000000000001 .
    `);
    expect(summarize(report).map((r) => [r.path, r.component]).sort()).toEqual([
      ['https://schema.org/url', 'sh:PatternConstraintComponent'],
      [`${NS}attr/${TIER_ID}`, 'sh:InConstraintComponent'],
    ].sort());
  });
});
