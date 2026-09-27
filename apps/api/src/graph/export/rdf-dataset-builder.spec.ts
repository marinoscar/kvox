import { ONTOLOGY } from '@app/shared/ontology';

import { FIXTURE_NS as NS, userDef } from '../../../test/graph/rdf/rdf-fixtures';
import {
  GraphRdfDatasetBuilder,
  decimalLexical,
  entityRefIds,
  mediaFragment,
  type ExportEntityRow,
  type ExportEvidenceRow,
  type ExportItemRow,
  type ExportRelationNodeRow,
  type RdfSubjectBlock,
} from './rdf-dataset-builder';

// =============================================================================
// GraphRdfDatasetBuilder (#386, docs/specs/ontology.md §18.1)
//
// Per-row mapping, sensitive exclusion, reification and evidence selectors.
// That the output validates against the generated shapes is proven end to end
// by `serializers.spec.ts` (pure) and `test/graph/rdf/export-conforms.db.spec.ts`
// (real rows through the real handler).
// =============================================================================

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const PROV = 'http://www.w3.org/ns/prov#';
const OA = 'http://www.w3.org/ns/oa#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PERSON = id(1);
const ORG = id(2);
const MEETING = id(3);
const EXPORT_ID = id(99);

const TIER = userDef({
  id: '11111111-1111-4111-8111-111111111111',
  entityType: 'Organization',
  key: 'u_tier000001',
  label: 'Tier',
  kind: 'select',
  options: { choices: [{ value: 'gold', label: 'Gold' }] },
});
const MEDICAL = userDef({
  id: '33333333-3333-4333-8333-333333333333',
  entityType: 'Person',
  key: 'u_medical001',
  label: 'Medical note',
  sensitivity: 'sensitive',
});

function builder() {
  return new GraphRdfDatasetBuilder({
    ns: NS,
    registry: ONTOLOGY,
    attributeDefs: [TIER, MEDICAL],
    exportId: EXPORT_ID,
    generatedAt: new Date('2026-09-01T00:00:00Z'),
    ontologyVersion: ONTOLOGY.version,
  });
}

function entityRow(overrides: Partial<ExportEntityRow> = {}): ExportEntityRow {
  return {
    id: PERSON,
    type: 'Person',
    label: 'Sarah Chen',
    props: {},
    reviewStatus: 'accepted',
    occurredAt: null,
    ontologyVersion: '1.0.0',
    aliases: ['Sarah Chen', 'Sarah'],
    evidenceIds: [id(50)],
    refTypes: new Map(),
    outgoing: [],
    ...overrides,
  };
}

function relationRow(overrides: Partial<ExportRelationNodeRow> = {}): ExportRelationNodeRow {
  return {
    id: id(20),
    type: 'WORKS_FOR',
    fromId: PERSON,
    fromType: 'Person',
    toId: ORG,
    toType: 'Organization',
    props: {},
    validFrom: new Date('2019-01-01T00:00:00Z'),
    validTo: null,
    validPrecision: 'year',
    reviewStatus: 'accepted',
    confidence: 0.9,
    ontologyVersion: '1.0.0',
    evidenceIds: [id(51)],
    ...overrides,
  };
}

function itemRow(overrides: Partial<ExportItemRow> = {}): ExportItemRow {
  return {
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
    subject: null,
    meeting: { id: MEETING, type: 'Meeting' },
    ownerPerson: { id: PERSON, type: 'Person' },
    counterparty: { id: ORG, type: 'Organization' },
    supersedes: [],
    evidenceIds: [id(52)],
    refTypes: new Map(),
    ...overrides,
  };
}

const objects = (block: RdfSubjectBlock | null, predicate: string, subject?: string) =>
  (block?.triples ?? [])
    .filter((t) => t.predicate.value === predicate && (subject === undefined || t.subject.value === subject))
    .map((t) => t.object.value);

describe('GraphRdfDatasetBuilder — entities', () => {
  it('types, labels, aliases, annotations and citations an entity', () => {
    const b = builder();
    const block = b.entity(entityRow({ occurredAt: new Date('2026-04-02T15:00:00Z') }))!;
    const subject = `${NS}entity/${PERSON}`;
    expect(block.subject).toBe(subject);
    expect(objects(block, `${RDF}type`)).toEqual([`${NS}Person`, 'https://schema.org/Person']);
    expect(objects(block, `${RDFS}label`)).toEqual(['Sarah Chen']);
    // The alias equal to the label is not repeated.
    expect(objects(block, `${SKOS}altLabel`)).toEqual(['Sarah']);
    expect(objects(block, `${NS}occurredAt`)).toEqual(['2026-04-02T15:00:00.000Z']);
    expect(objects(block, `${NS}reviewStatus`)).toEqual(['accepted']);
    expect(objects(block, `${NS}ontologyVersion`)).toEqual(['1.0.0']);
    expect(objects(block, `${PROV}wasDerivedFrom`)).toEqual([`${NS}evidence/${id(50)}`]);
    expect(block.triples[0].predicate.value).toBe(`${RDF}type`);
    expect(b.stats.entities).toBe(1);
  });

  it('writes built-in attributes under their (aligned) IRIs and user attributes as kv:attr/<id>', () => {
    const b = builder();
    const org = b.entity(
      entityRow({
        id: ORG,
        type: 'Organization',
        label: 'Acme',
        props: { website: 'https://acme.example', u_tier000001: 'gold', notAnAttribute: 'x' },
      }),
    )!;
    expect(objects(org, 'https://schema.org/url')).toEqual(['https://acme.example']);
    expect(org.triples.find((t) => t.predicate.value === 'https://schema.org/url')!.object).toMatchObject({
      datatype: `${XSD}anyURI`,
    });
    expect(objects(org, `${NS}attr/${TIER.id}`)).toEqual(['gold']);
    expect(org.triples.some((t) => t.predicate.value.includes('notAnAttribute'))).toBe(false);
  });

  it('drops values the shapes would reject rather than writing them', () => {
    const b = builder();
    const org = b.entity(
      entityRow({ id: ORG, type: 'Organization', label: 'Acme', props: { website: 'ftp://acme', u_tier000001: 'bronze' } }),
    )!;
    expect(objects(org, 'https://schema.org/url')).toEqual([]);
    expect(objects(org, `${NS}attr/${TIER.id}`)).toEqual([]);
  });

  it('⚠ excludes a sensitive attribute value and counts it', () => {
    const b = builder();
    const block = b.entity(entityRow({ props: { u_medical001: 'Diagnosed with X' } }))!;
    expect(JSON.stringify(block)).not.toContain('Diagnosed with X');
    expect(JSON.stringify(block)).not.toContain(MEDICAL.id);
    expect(b.stats.excludedSensitive).toBe(1);
  });

  it('writes the direct triple (and its alignment) for an allowed outgoing edge only', () => {
    const b = builder();
    const block = b.entity(
      entityRow({
        outgoing: [
          relationRow(),
          // REPORTS_TO a Person → Organization pair is not allowed: dropped.
          relationRow({ id: id(21), type: 'REPORTS_TO' }),
          // HAS_ROLE without its required title: dropped.
          relationRow({ id: id(22), type: 'HAS_ROLE' }),
        ],
      }),
    )!;
    expect(objects(block, `${NS}WORKS_FOR`)).toEqual([`${NS}entity/${ORG}`]);
    expect(objects(block, 'https://schema.org/worksFor')).toEqual([`${NS}entity/${ORG}`]);
    expect(objects(block, `${NS}REPORTS_TO`)).toEqual([]);
    expect(objects(block, `${NS}HAS_ROLE`)).toEqual([]);
  });

  it('skips an entity of an unknown type or with no citation', () => {
    const b = builder();
    expect(b.entity(entityRow({ type: 'Spaceship' }))).toBeNull();
    expect(b.entity(entityRow({ evidenceIds: [] }))).toBeNull();
    expect(b.stats.entities).toBe(0);
  });

  it('resolves an entity_ref only to an exported target of an allowed type', () => {
    const def = userDef({
      id: '55555555-5555-4555-8555-555555555555',
      entityType: 'Project',
      key: 'u_sponsor001',
      label: 'Sponsor',
      kind: 'entity_ref',
      options: { targetTypes: ['Person'] },
    });
    const b = new GraphRdfDatasetBuilder({
      ns: NS,
      registry: ONTOLOGY,
      attributeDefs: [def],
      exportId: EXPORT_ID,
      generatedAt: new Date(0),
      ontologyVersion: '1',
    });
    const row = entityRow({ id: id(4), type: 'Project', label: 'Pilot', props: { u_sponsor001: PERSON } });
    expect(entityRefIds(ONTOLOGY, 'Project', row.props, [def])).toEqual([PERSON]);
    expect(objects(b.entity({ ...row, refTypes: new Map([[PERSON, 'Person']]) }), `${NS}attr/${def.id}`)).toEqual([
      `${NS}entity/${PERSON}`,
    ]);
    expect(objects(b.entity({ ...row, refTypes: new Map([[PERSON, 'Organization']]) }), `${NS}attr/${def.id}`)).toEqual([]);
    expect(objects(b.entity({ ...row, refTypes: new Map() }), `${NS}attr/${def.id}`)).toEqual([]);
  });
});

describe('GraphRdfDatasetBuilder — items', () => {
  it('maps a commitment’s columns, statement, status and dates', () => {
    const b = builder();
    const block = b.item(itemRow())!;
    expect(block.subject).toBe(`${NS}item/${id(30)}`);
    expect(objects(block, `${RDF}type`)).toEqual([`${NS}Commitment`]);
    expect(objects(block, `${RDFS}label`)).toEqual(['Send the proposal']);
    expect(objects(block, `${NS}Commitment.statement`)).toEqual(['Sarah will send the proposal.']);
    expect(objects(block, `${NS}status`)).toEqual(['open']);
    expect(objects(block, `${NS}dueAt`)).toEqual(['2026-04-10T17:00:00.000Z']);
    expect(objects(block, `${NS}ASSIGNED_TO`)).toEqual([`${NS}entity/${PERSON}`]);
    expect(objects(block, `${NS}OWED_TO`)).toEqual([`${NS}entity/${ORG}`]);
    expect(objects(block, `${NS}CREATED_IN`)).toEqual([`${NS}entity/${MEETING}`]);
    expect(objects(block, `${NS}DECIDED_IN`)).toEqual([]);
    expect(b.stats.items).toBe(1);
  });

  it('writes an item’s own validity range the way an assertion carries one', () => {
    const block = builder().item(
      itemRow({
        kind: 'claim',
        status: 'active',
        subject: { id: ORG, type: 'Organization' },
        validFrom: new Date('2026-03-01T00:00:00Z'),
        validTo: new Date('2026-06-01T00:00:00Z'),
        validPrecision: 'month',
      }),
    )!;
    expect(objects(block, `${PROV}startedAtTime`)).toEqual(['2026-03-01T00:00:00.000Z']);
    expect(objects(block, `${PROV}endedAtTime`)).toEqual(['2026-06-01T00:00:00.000Z']);
    expect(objects(block, `${NS}validPrecision`)).toEqual(['month']);
    expect(objects(block, `${NS}ABOUT`)).toEqual([`${NS}entity/${ORG}`]);
  });

  it('⚠ never exports a sensitive PersonFact, and counts it', () => {
    const b = builder();
    const block = b.item(
      itemRow({
        kind: 'person_fact',
        status: 'active',
        statement: 'Sarah has a heart condition.',
        sensitivity: 'sensitive',
        subject: { id: PERSON, type: 'Person' },
      }),
    );
    expect(block).toBeNull();
    expect(b.stats).toMatchObject({ items: 0, excludedSensitive: 1 });
    // A personal (not sensitive) fact is exported.
    expect(b.item(itemRow({ kind: 'person_fact', status: 'active', sensitivity: 'personal', subject: { id: PERSON, type: 'Person' } }))).not.toBeNull();
  });

  it('skips an item whose required subject is not exported or of the wrong type', () => {
    const b = builder();
    expect(b.item(itemRow({ kind: 'claim', status: 'active', subject: null }))).toBeNull();
    expect(b.item(itemRow({ kind: 'person_fact', status: 'active', sensitivity: 'personal', subject: { id: ORG, type: 'Organization' } }))).toBeNull();
  });

  it('links a superseded item from the newer one with kv:SUPERSEDES and prov:wasRevisionOf', () => {
    const b = builder();
    const newer = b.item(itemRow({ kind: 'decision', status: 'active', supersedes: [{ id: id(31), kind: 'decision' }, { id: id(32), kind: 'claim' }] }))!;
    expect(objects(newer, `${NS}SUPERSEDES`)).toEqual([`${NS}item/${id(31)}`]);
    expect(objects(newer, `${PROV}wasRevisionOf`)).toEqual([`${NS}item/${id(31)}`]);
    const older = b.item(itemRow({ id: id(31), kind: 'decision', status: 'superseded', reviewStatus: 'superseded' }))!;
    expect(objects(older, `${NS}reviewStatus`)).toEqual(['superseded']);
    expect(objects(older, `${NS}status`)).toEqual(['superseded']);
  });
});

describe('GraphRdfDatasetBuilder — relations', () => {
  it('reifies an edge with its range, precision, confidence and citations (finite bounds only)', () => {
    const b = builder();
    const block = b.relation(relationRow())!;
    expect(block.subject).toBe(`${NS}relation/${id(20)}`);
    expect(objects(block, `${RDF}type`)).toEqual([`${NS}Assertion`]);
    expect(objects(block, `${RDF}subject`)).toEqual([`${NS}entity/${PERSON}`]);
    expect(objects(block, `${RDF}predicate`)).toEqual([`${NS}WORKS_FOR`]);
    expect(objects(block, `${RDF}object`)).toEqual([`${NS}entity/${ORG}`]);
    expect(objects(block, `${PROV}startedAtTime`)).toEqual(['2019-01-01T00:00:00.000Z']);
    expect(objects(block, `${PROV}endedAtTime`)).toEqual([]);
    expect(objects(block, `${NS}validPrecision`)).toEqual(['year']);
    expect(objects(block, `${NS}confidence`)).toEqual(['0.9']);
    expect(objects(block, `${PROV}wasDerivedFrom`)).toEqual([`${NS}evidence/${id(51)}`]);
    expect(b.stats.relations).toBe(1);
  });

  it('carries relation props on the assertion, and reifies non-temporal edges too', () => {
    const b = builder();
    const role = b.relation(relationRow({ type: 'HAS_ROLE', props: { title: 'Staff Engineer' } }))!;
    expect(objects(role, `${NS}HAS_ROLE.title`)).toEqual(['Staff Engineer']);
    const attended = b.relation(
      relationRow({ type: 'ATTENDED', toId: MEETING, toType: 'Meeting', validFrom: null, validPrecision: null, confidence: null }),
    )!;
    expect(objects(attended, `${RDF}predicate`)).toEqual([`${NS}ATTENDED`]);
  });

  it('refuses a relation it could not also write as a direct triple', () => {
    const b = builder();
    expect(b.relation(relationRow({ type: 'HAS_ROLE' }))).toBeNull();
    expect(b.relation(relationRow({ type: 'IDENTIFIED_AS' }))).toBeNull();
    expect(b.relation(relationRow({ toType: 'Person' }))).toBeNull();
    expect(b.relation(relationRow({ evidenceIds: [] }))).toBeNull();
  });
});

describe('GraphRdfDatasetBuilder — the personal domain (#383)', () => {
  it('exports personal entities and edges: personal is not sensitive', () => {
    const b = builder();
    const trip = b.entity(
      entityRow({ id: id(5), type: 'Trip', label: 'Lisbon', aliases: [], props: { destination: 'Lisbon', startDate: '2026-05-01' } }),
    )!;
    expect(objects(trip, `${RDF}type`)).toContain(`${NS}Trip`);
    expect(objects(trip, `${NS}Trip.destination`)).toEqual(['Lisbon']);
    const person = b.entity(
      entityRow({
        outgoing: [
          relationRow({ id: id(23), type: 'TRAVELED_ON', toId: id(5), toType: 'Trip', validFrom: null, validPrecision: null }),
          relationRow({ id: id(24), type: 'SPOUSE_OF', toId: id(6), toType: 'Person' }),
        ],
      }),
    )!;
    expect(objects(person, `${NS}TRAVELED_ON`)).toEqual([`${NS}entity/${id(5)}`]);
    expect(objects(person, `${NS}SPOUSE_OF`)).toEqual([`${NS}entity/${id(6)}`]);
    expect(b.relation(relationRow({ id: id(24), type: 'SPOUSE_OF', toId: id(6), toType: 'Person' }))).not.toBeNull();
    expect(b.stats.excludedSensitive).toBe(0);
  });

  it('writes a symmetric edge exactly as stored, once — never a mirrored inverse', () => {
    const b = builder();
    const spouse = relationRow({ id: id(24), type: 'SPOUSE_OF', toId: id(6), toType: 'Person' });
    const from = b.entity(entityRow({ outgoing: [spouse] }))!;
    // The other endpoint's block carries no SPOUSE_OF back: its outgoing list is its own rows only.
    const to = b.entity(entityRow({ id: id(6), label: 'Alex', aliases: [], outgoing: [spouse] }))!;
    const all = [...from.triples, ...to.triples].filter((t) => t.predicate.value === `${NS}SPOUSE_OF`);
    expect(all).toHaveLength(1);
    expect(all[0].subject.value).toBe(`${NS}entity/${PERSON}`);
    const reified = b.relation(spouse)!;
    expect(objects(reified, `${RDF}subject`)).toEqual([`${NS}entity/${PERSON}`]);
    expect(objects(reified, `${RDF}object`)).toEqual([`${NS}entity/${id(6)}`]);
  });
});

describe('GraphRdfDatasetBuilder — evidence', () => {
  function evidenceRow(overrides: Partial<ExportEvidenceRow> = {}): ExportEvidenceRow {
    return {
      id: id(50),
      subjectKind: 'entity',
      subjectSensitivity: null,
      quote: 'Sarah joined Acme in 2019',
      segmentId: id(60),
      startMs: 102_000,
      endMs: 118_500,
      noteId: null,
      noteVersion: null,
      charStart: 0,
      charEnd: 12,
      ...overrides,
    };
  }

  it('writes a segment citation with a media fragment and a text position selector', () => {
    const block = builder().evidence(evidenceRow())!;
    const s = `${NS}evidence/${id(50)}`;
    expect(objects(block, `${RDF}type`, s)).toEqual([`${OA}Annotation`]);
    const [body] = objects(block, `${OA}hasBody`, s);
    expect(objects(block, `${RDF}value`, body)).toEqual(['Sarah joined Acme in 2019']);
    const [target] = objects(block, `${OA}hasTarget`, s);
    expect(objects(block, `${OA}hasSource`, target)).toEqual([`${NS}segment/${id(60)}`]);
    const selectors = objects(block, `${OA}hasSelector`, target);
    expect(selectors).toHaveLength(2);
    const types = selectors.map((sel) => objects(block, `${RDF}type`, sel)[0]).sort();
    expect(types).toEqual([`${OA}FragmentSelector`, `${OA}TextPositionSelector`]);
    const fragment = selectors.find((sel) => objects(block, `${RDF}type`, sel)[0] === `${OA}FragmentSelector`)!;
    expect(objects(block, `${RDF}value`, fragment)).toEqual(['t=102,118.5']);
    const position = selectors.find((sel) => objects(block, `${RDF}type`, sel)[0] === `${OA}TextPositionSelector`)!;
    expect(objects(block, `${OA}start`, position)).toEqual(['0']);
    expect(objects(block, `${OA}end`, position)).toEqual(['12']);
  });

  it('cites a note span as kv:note/<id>/v<version>', () => {
    const block = builder().evidence(
      evidenceRow({ segmentId: null, startMs: null, endMs: null, noteId: id(70), noteVersion: 3, charStart: 5, charEnd: 9 }),
    )!;
    const [target] = objects(block, `${OA}hasTarget`);
    expect(objects(block, `${OA}hasSource`, target)).toEqual([`${NS}note/${id(70)}/v3`]);
  });

  it('keeps a citation whose source is gone as a quote with no target', () => {
    const block = builder().evidence(evidenceRow({ segmentId: null, noteId: null, startMs: null, endMs: null }))!;
    expect(objects(block, `${OA}hasTarget`)).toEqual([]);
    expect(objects(block, `${RDF}value`)).toEqual(['Sarah joined Acme in 2019']);
  });

  it('⚠ never exports the evidence of a sensitive fact — its quote is the fact', () => {
    const b = builder();
    expect(b.evidence(evidenceRow({ subjectKind: 'item', subjectSensitivity: 'sensitive' }))).toBeNull();
    expect(b.evidence(evidenceRow({ subjectKind: 'proposal_item' }))).toBeNull();
    expect(b.stats.evidence).toBe(0);
  });

  it('labels blank nodes from the evidence id, so two runs agree', () => {
    expect(builder().evidence(evidenceRow())).toEqual(builder().evidence(evidenceRow()));
  });
});

describe('GraphRdfDatasetBuilder — header and definitions', () => {
  it('writes the ontology version and the export document, with no personal data', () => {
    const b = builder();
    expect(objects(b.ontologyHeader(), 'http://www.w3.org/2002/07/owl#versionInfo')).toEqual([ONTOLOGY.version]);
    const header = b.exportHeader();
    expect(header.subject).toBe(`${NS}export/${EXPORT_ID}`);
    expect(objects(header, `${PROV}generatedAtTime`)).toEqual(['2026-09-01T00:00:00.000Z']);
    expect(JSON.stringify(header)).not.toContain('creator');
  });

  it('declares only the non-sensitive attribute definitions', () => {
    const blocks = builder().attributeDefinitions();
    expect(blocks.map((b) => b.subject)).toEqual([`${NS}attr/${TIER.id}`]);
    expect(objects(blocks[0], `${RDFS}label`)).toEqual(['Tier']);
  });
});

describe('value helpers', () => {
  it('formats decimals without exponent notation', () => {
    expect(decimalLexical(3)).toBe('3');
    expect(decimalLexical(0.25)).toBe('0.25');
    expect(decimalLexical(1e21)).toBe('1000000000000000000000');
    expect(decimalLexical(Number.NaN)).toBeNull();
  });

  it('writes a media fragment in seconds', () => {
    expect(mediaFragment(1500, 4000)).toBe('t=1.5,4');
  });
});
