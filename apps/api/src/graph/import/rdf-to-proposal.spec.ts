import { ONTOLOGY, type UserAttributeDef } from '@app/shared/ontology';

import { entityPayloadSchema, itemPayloadSchema, relationPayloadSchema } from '../proposals/proposal-payload.schema';
import { relationPropIri } from '../rdf/iris';
import { statementHash } from '../write/normalize';
import type { ImportQuad } from './import-dataset';
import { buildImportVocabulary } from './import-vocabulary';
import { inclusiveEnd, mapImportToProposal, payloadTemporal, refFor } from './rdf-to-proposal';

// #387 — validated triples onto EXACTLY #363's payload contract: entities,
// relations (reification wins), items, import evidence, and what is skipped.

const NS = 'https://fixture.app/ns#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const PROV = 'http://www.w3.org/ns/prov#';
const OA = 'http://www.w3.org/ns/oa#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';

const iri = (value: string) => ({ termType: 'NamedNode' as const, value });
const blank = (value: string) => ({ termType: 'BlankNode' as const, value });
const lit = (value: string, datatype = `${XSD}string`) => ({ termType: 'Literal' as const, value, datatype });
const q = (s: string, p: string, o: ImportQuad['o']): ImportQuad => ({ s: s.startsWith('_:') ? blank(s.slice(2)) : iri(s), p, o });
const dt = (v: string) => lit(v, `${XSD}dateTime`);

function map(quads: ImportQuad[], extra: { defs?: UserAttributeDef[]; sensitivity?: Map<string, string> } = {}) {
  return mapImportToProposal({
    quads,
    ns: NS,
    registry: ONTOLOGY,
    vocabulary: buildImportVocabulary(ONTOLOGY, extra.defs ?? [], NS),
    userAttributes: extra.defs ?? [],
    filename: 'contacts.ttl',
    sensitivity: extra.sensitivity ?? new Map(),
  });
}

const JOE = 'https://s.example/joe';
const ACME = 'https://s.example/acme';
const people = (): ImportQuad[] => [
  q(JOE, `${RDF}type`, iri(`${NS}Person`)),
  q(JOE, `${RDFS}label`, lit('Joe Smith')),
  q(JOE, `${SKOS}altLabel`, lit('Joseph')),
  q(JOE, `${SKOS}altLabel`, lit('Joe Smith')),
  q(JOE, 'https://schema.org/jobTitle', lit('CTO')),
  q(ACME, `${RDF}type`, iri(`${NS}Organization`)),
  q(ACME, `${RDFS}label`, lit('Acme')),
  q(ACME, 'https://schema.org/url', lit('https://acme.example', `${XSD}anyURI`)),
];

describe('temporal helpers', () => {
  it('turns an exclusive upper bound into an inclusive validTo', () => {
    expect(inclusiveEnd('2024-07-01T00:00:00.000Z', 'month')).toBe('2024-06-01');
    expect(inclusiveEnd('2024-01-01T00:00:00.000Z', 'month')).toBe('2023-12-01');
    expect(inclusiveEnd('2021-01-01T00:00:00.000Z', 'year')).toBe('2020-01-01');
    expect(inclusiveEnd('2024-03-01T00:00:00.000Z', 'day')).toBe('2024-02-29');
  });

  it('defaults a stated range to day precision and an empty one to unknown', () => {
    expect(payloadTemporal('2024-01-15T00:00:00Z', undefined, undefined)).toEqual({ validFrom: '2024-01-15', validTo: null, precision: 'day' });
    expect(payloadTemporal(undefined, undefined, 'month')).toEqual({ validFrom: null, validTo: null, precision: 'unknown' });
    expect(payloadTemporal('2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'year', false)).toEqual({ validFrom: null, validTo: null, precision: 'unknown' });
  });
});

describe('mapImportToProposal', () => {
  it('maps entities onto the entity payload schema, with deterministic refs', () => {
    const { rows, counts } = map(people());
    const joe = rows.find((r) => r.kind === 'entity' && r.payload.label === 'Joe Smith')!;
    expect(entityPayloadSchema.parse(joe.payload)).toEqual({
      ref: refFor('e', `N:${JOE}`),
      type: 'Person',
      label: 'Joe Smith',
      aliases: ['Joseph'],
      props: { title: 'CTO' },
      occurredAt: null,
    });
    const acme = rows.find((r) => r.kind === 'entity' && r.payload.label === 'Acme')!;
    expect(acme.payload).toMatchObject({ props: { website: 'https://acme.example' } });
    expect(counts).toEqual({ entities: 2, relations: 0, items: 0, skippedSensitive: 0 });
  });

  it('cites every row to the file: its annotation text, else "Imported from <filename>"', () => {
    const quads = [
      ...people(),
      q(JOE, `${PROV}wasDerivedFrom`, iri('https://s.example/ann')),
      q('https://s.example/ann', `${RDF}type`, iri(`${OA}Annotation`)),
      q('https://s.example/ann', `${OA}hasBody`, blank('b1')),
      q('_:b1', `${RDF}value`, lit('Joe runs engineering.')),
    ];
    const { rows } = map(quads);
    expect(rows.find((r) => r.node === `N:${JOE}`)?.evidence).toEqual({ sourceIri: JOE, quote: 'Joe runs engineering.' });
    expect(rows.find((r) => r.node === `N:${ACME}`)?.evidence).toEqual({ sourceIri: ACME, quote: 'Imported from contacts.ttl' });
  });

  it('lets a reified assertion win over the direct triple it restates', () => {
    const quads = [
      ...people(),
      q(JOE, `${NS}WORKS_FOR`, iri(ACME)),
      q('https://s.example/r1', `${RDF}type`, iri(`${NS}Assertion`)),
      q('https://s.example/r1', `${RDF}subject`, iri(JOE)),
      q('https://s.example/r1', `${RDF}predicate`, iri(`${NS}WORKS_FOR`)),
      q('https://s.example/r1', `${RDF}object`, iri(ACME)),
      q('https://s.example/r1', `${PROV}startedAtTime`, dt('2019-03-01T00:00:00.000Z')),
      q('https://s.example/r1', `${PROV}endedAtTime`, dt('2024-07-01T00:00:00.000Z')),
      q('https://s.example/r1', `${NS}validPrecision`, lit('month')),
      q('https://s.example/r1', `${NS}confidence`, lit('0.8', `${XSD}decimal`)),
    ];
    const { rows, counts } = map(quads);
    const relations = rows.filter((r) => r.kind === 'relation');
    expect(relations).toHaveLength(1);
    expect(counts.relations).toBe(1);
    const payload = relationPayloadSchema.parse(relations[0].payload);
    expect(payload).toMatchObject({
      type: 'WORKS_FOR',
      from: { ref: refFor('e', `N:${JOE}`) },
      to: { ref: refFor('e', `N:${ACME}`) },
      validFrom: '2019-03-01',
      validTo: '2024-06-01',
      precision: 'month',
    });
    expect(relations[0].resolution).toMatchObject({ ref: null, score: 0.8 });
    expect(relations[0].evidence.sourceIri).toBe('https://s.example/r1');
  });

  it('maps a bare direct triple to a relation with no range, and drops a disallowed pair', () => {
    const quads = [...people(), q(JOE, `${NS}WORKS_FOR`, iri(ACME)), q(ACME, `${NS}WORKS_FOR`, iri(JOE))];
    const relations = map(quads).rows.filter((r) => r.kind === 'relation');
    expect(relations).toHaveLength(1);
    expect(relations[0].payload).toMatchObject({ validFrom: null, validTo: null, precision: 'unknown', props: {} });
  });

  it('keeps HAS_ROLE only with its required title', () => {
    const base = [...people(), q(JOE, `${NS}HAS_ROLE`, iri(ACME))];
    expect(map(base).rows.filter((r) => r.kind === 'relation')).toHaveLength(0);
    const titled = [
      ...base,
      q('_:r', `${RDF}type`, iri(`${NS}Assertion`)),
      q('_:r', `${RDF}subject`, iri(JOE)),
      q('_:r', `${RDF}predicate`, iri(`${NS}HAS_ROLE`)),
      q('_:r', `${RDF}object`, iri(ACME)),
      q('_:r', relationPropIri(NS, 'HAS_ROLE', 'title', ONTOLOGY.relationType('HAS_ROLE')?.props.title?.alignment), lit('CTO')),
    ];
    const hasTitle = map(titled).rows.filter((r) => r.kind === 'relation');
    expect(hasTitle).toHaveLength(1);
    expect(hasTitle[0].payload).toMatchObject({ type: 'HAS_ROLE', props: { title: 'CTO' } });
    expect(hasTitle[0].evidence.sourceIri).toBeNull(); // a blank-node assertion has no IRI to cite
  });

  it('maps items onto the item payload schema, endpoints as refs, statementHash recomputed', () => {
    const deck = 'https://s.example/deck';
    const quads = [
      ...people(),
      q(deck, `${RDF}type`, iri(`${NS}Commitment`)),
      q(deck, `${RDFS}label`, lit('Send the deck')),
      q(deck, `${NS}Commitment.statement`, lit('Joe will send the deck.')),
      q(deck, `${NS}ASSIGNED_TO`, iri(JOE)),
      q(deck, `${NS}OWED_TO`, iri(ACME)),
      q(deck, `${NS}status`, lit('open')),
      q(deck, `${NS}dueAt`, dt('2026-04-10T00:00:00.000Z')),
    ];
    const item = map(quads).rows.find((r) => r.kind === 'item')!;
    const payload = itemPayloadSchema.parse(item.payload);
    expect(payload).toMatchObject({
      kind: 'commitment',
      title: 'Send the deck',
      statement: 'Joe will send the deck.',
      owner: { ref: refFor('e', `N:${JOE}`) },
      counterparty: { ref: refFor('e', `N:${ACME}`) },
      subject: null,
      status: 'open',
      dueAt: '2026-04-10',
      sensitivity: null,
      statementHash: statementHash('commitment', 'Joe will send the deck.'),
    });
  });

  it('skips a sensitive person fact (counted), a superseded item, and a claim without a subject', () => {
    const fact = 'https://s.example/fact';
    const old = 'https://s.example/old';
    const orphan = 'https://s.example/orphan';
    const quads = [
      ...people(),
      q(fact, `${RDF}type`, iri(`${NS}PersonFact`)),
      q(fact, `${NS}PersonFact.statement`, lit('A private matter.')),
      q(fact, `${NS}ABOUT`, iri(JOE)),
      q(old, `${RDF}type`, iri(`${NS}Decision`)),
      q(old, `${NS}Decision.statement`, lit('Old plan.')),
      q(old, `${NS}reviewStatus`, lit('superseded')),
      q(orphan, `${RDF}type`, iri(`${NS}Claim`)),
      q(orphan, `${NS}Claim.statement`, lit('Something about nothing.')),
    ];
    const { rows, counts } = map(quads, { sensitivity: new Map([[`N:${fact}`, 'sensitive']]) });
    expect(rows.filter((r) => r.kind === 'item')).toEqual([]);
    expect(counts.skippedSensitive).toBe(1);

    const personal = map(quads.slice(0, 11)).rows.find((r) => r.kind === 'item');
    expect(personal?.payload).toMatchObject({ kind: 'person_fact', sensitivity: 'personal', subject: { ref: refFor('e', `N:${JOE}`) } });
  });

  it('keeps the caller’s own attribute values by key, and skips a sensitive definition', () => {
    const tier = { id: '11111111-1111-4111-8111-111111111111', entityType: 'Organization', key: 'u_tier000001', label: 'Tier', kind: 'text', options: null, sensitivity: null } as unknown as UserAttributeDef;
    const secret = { id: '33333333-3333-4333-8333-333333333333', entityType: 'Person', key: 'u_secret0001', label: 'Secret', kind: 'text', options: null, sensitivity: 'sensitive' } as unknown as UserAttributeDef;
    const quads = [...people(), q(ACME, `${NS}attr/${tier.id}`, lit('gold')), q(JOE, `${NS}attr/${secret.id}`, lit('hidden'))];
    const { rows, counts } = map(quads, { defs: [tier, secret] });
    expect(rows.find((r) => r.node === `N:${ACME}`)?.payload).toMatchObject({ props: { website: 'https://acme.example', u_tier000001: 'gold' } });
    expect(rows.find((r) => r.node === `N:${JOE}`)?.payload).toMatchObject({ props: { title: 'CTO' } });
    expect(counts.skippedSensitive).toBe(1);
  });

  it('drops a Meeting’s deployment-local ids and keeps its date', () => {
    const m = 'https://s.example/m';
    const quads = [
      q(m, `${RDF}type`, iri(`${NS}Meeting`)),
      q(m, `${RDFS}label`, lit('Kickoff')),
      q(m, `${NS}Meeting.transcriptId`, lit('elsewhere')),
      q(m, `${NS}Meeting.dateSource`, lit('stated')),
      q(m, `${NS}occurredAt`, dt('2026-04-02T15:00:00.000Z')),
    ];
    expect(map(quads).rows[0].payload).toMatchObject({ props: { dateSource: 'stated' }, occurredAt: '2026-04-02' });
  });
});
