import { ONTOLOGY, type UserAttributeDef } from '@app/shared/ontology';

import type { ImportQuad } from './import-dataset';
import { buildImportVocabulary } from './import-vocabulary';
import { ASSERTION_SUBJECT_TYPE, offerIdFor, splitUnknownProperties, suggestKind } from './unknown-properties';

// #387 — closed by default without failing a CRM export: every undeclared
// property on a typed node is offered and removed before validation.

const NS = 'https://fixture.app/ns#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const PROV = 'http://www.w3.org/ns/prov#';
const CRM = 'https://crm.example/ns#';

const iri = (value: string) => ({ termType: 'NamedNode' as const, value });
const lit = (value: string, datatype = `${XSD}string`) => ({ termType: 'Literal' as const, value, datatype });
const q = (s: string, p: string, o: ImportQuad['o']): ImportQuad => ({ s: iri(s), p, o });

const TIER: UserAttributeDef = {
  id: '11111111-1111-4111-8111-111111111111',
  entityType: 'Organization',
  key: 'u_tier000001',
  label: 'Tier',
  kind: 'text',
  options: null,
  extractable: false,
  extractionHint: null,
  sensitivity: null,
  sortOrder: 0,
  deprecatedAt: null,
} as unknown as UserAttributeDef;

function split(quads: ImportQuad[], defs: UserAttributeDef[] = []) {
  return splitUnknownProperties(quads, buildImportVocabulary(ONTOLOGY, defs, NS), NS);
}

describe('splitUnknownProperties', () => {
  it('offers and removes an undeclared property; declared ones stay', () => {
    const quads = [
      q('s:joe', `${RDF}type`, iri(`${NS}Person`)),
      q('s:joe', `${RDFS}label`, lit('Joe')),
      q('s:joe', `${PROV}wasDerivedFrom`, iri('s:src')),
      q('s:joe', `${CRM}nickname`, lit('Joey')),
      q('s:joe', `${CRM}nickname`, lit('J')),
      q('s:joe', 'https://schema.org/jobTitle', lit('CTO')),
    ];
    const result = split(quads);
    expect(result.quads.map((x) => x.p)).not.toContain(`${CRM}nickname`);
    expect(result.quads.map((x) => x.p)).toContain('https://schema.org/jobTitle');
    expect(result.offers).toEqual([
      {
        offerId: offerIdFor(`${CRM}nickname`),
        iri: `${CRM}nickname`,
        label: null,
        count: 2,
        subjectTypes: ['Person'],
        sampleValues: ['Joey', 'J'],
        suggestedKind: 'text',
        status: 'offered',
      },
    ]);
    expect([...(result.pending.get(offerIdFor(`${CRM}nickname`))?.get('N:s:joe') ?? [])]).toEqual([
      { v: 'Joey', d: `${XSD}string` },
      { v: 'J', d: `${XSD}string` },
    ]);
  });

  it('uses the file’s own rdfs:label for the property', () => {
    const result = split([q('s:o', `${RDF}type`, iri(`${NS}Organization`)), q('s:o', `${CRM}tier`, lit('gold')), q(`${CRM}tier`, `${RDFS}label`, lit('Tier'))]);
    expect(result.offers[0].label).toBe('Tier');
  });

  it('keeps the caller’s own attribute (kv:attr/<id>) and offers another owner’s', () => {
    const mine = `${NS}attr/${TIER.id}`;
    const theirs = `${NS}attr/22222222-2222-4222-8222-222222222222`;
    const result = split([q('s:o', `${RDF}type`, iri(`${NS}Organization`)), q('s:o', mine, lit('gold')), q('s:o', theirs, lit('silver'))], [TIER]);
    expect(result.quads.some((x) => x.p === mine)).toBe(true);
    expect(result.offers.map((o) => o.iri)).toEqual([theirs]);
  });

  it('records a property on a reified relation as already rejected', () => {
    const result = split([q('s:r', `${RDF}type`, iri(`${NS}Assertion`)), q('s:r', `${CRM}weight`, lit('3', `${XSD}integer`))]);
    expect(result.offers[0]).toMatchObject({ status: 'rejected', subjectTypes: [ASSERTION_SUBJECT_TYPE], suggestedKind: 'number' });
    expect(result.pending.size).toBe(0);
  });

  it('lifts kv:sensitivity off an item without offering it', () => {
    const result = split([q('s:f', `${RDF}type`, iri(`${NS}PersonFact`)), q('s:f', `${NS}sensitivity`, lit('sensitive'))]);
    expect(result.offers).toEqual([]);
    expect(result.quads).toHaveLength(1);
    expect(result.sensitivity.get('N:s:f')).toBe('sensitive');
  });

  it('leaves untyped nodes alone — no shape targets them', () => {
    const quads = [q('s:ann', `${RDF}type`, iri('http://www.w3.org/ns/oa#Annotation')), q('s:ann', `${CRM}whatever`, lit('x'))];
    expect(split(quads)).toMatchObject({ quads, offers: [] });
  });

  it('truncates samples to 80 characters and keeps at most three', () => {
    const long = 'x'.repeat(100);
    const quads = [q('s:joe', `${RDF}type`, iri(`${NS}Person`)), ...['a', 'b', 'c', long].map((v) => q('s:joe', `${CRM}n`, lit(v)))];
    const offer = split(quads).offers[0];
    expect(offer.sampleValues).toHaveLength(3);
    expect(split([quads[0], quads[4]]).offers[0].sampleValues[0]).toHaveLength(80);
  });

  it('suggests a kind from the values', () => {
    const typed = (o: ImportQuad['o']) =>
      split([q('s:a', `${RDF}type`, iri(`${NS}Person`)), q('s:b', `${RDF}type`, iri(`${NS}Organization`)), q('s:a', `${CRM}p`, o)]).offers[0].suggestedKind;
    expect(typed(lit('true', `${XSD}boolean`))).toBe('boolean');
    expect(typed(lit('1.5', `${XSD}double`))).toBe('number');
    expect(typed(lit('2024-01-01', `${XSD}date`))).toBe('date');
    expect(typed(lit('2024-01-01T00:00:00Z', `${XSD}dateTime`))).toBe('date');
    expect(typed(iri('https://example.com'))).toBe('url');
    expect(typed(iri('s:b'))).toBe('entity_ref');
    expect(typed(lit('hello'))).toBe('text');
    expect(suggestKind(['number', 'text'])).toBe('text');
  });
});
