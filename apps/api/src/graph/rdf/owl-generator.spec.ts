import { APP_NAME } from '@app/shared';
import { ONTOLOGY, ONTOLOGY_VERSION } from '@app/shared/ontology';

import {
  FIXTURE_NS as NS,
  OWL,
  PROV,
  RDF,
  RDFS,
  SCHEMA,
  XSD,
  listMembers,
  objectsOf,
  parseTurtle,
  subjectsOfType,
  userDef,
} from '../../../test/graph/rdf/rdf-fixtures';
import { alignmentIri, attributeIri, classIri, relationIri, relationPropIri, userAttributeIri } from './iris';
import { exportedRelations, typeAttributes } from './ontology-rdf-model';
import { generateOwl } from './owl-generator';

// =============================================================================
// generateOwl (#385, docs/specs/ontology.md §18.1, §18.2 item 1)
//
// Coverage is asserted by ITERATING THE REGISTRY, never against a hand-kept
// list, so a type, attribute or relation added to the definition file is
// covered by this test the day it lands.
// =============================================================================

const DEF_ID = '11111111-1111-4111-8111-111111111111';
const DEPRECATED_ID = '22222222-2222-4222-8222-222222222222';
const SENSITIVE_ID = '33333333-3333-4333-8333-333333333333';

const defs = [
  userDef({
    id: DEF_ID,
    entityType: 'Organization',
    key: 'u_tier000001',
    label: 'Tier',
    kind: 'select',
    options: { choices: [{ value: 'gold', label: 'Gold' }] },
  }),
  userDef({ id: DEPRECATED_ID, label: 'Old nickname', deprecatedAt: '2026-09-01T00:00:00.000Z' }),
  userDef({ id: SENSITIVE_ID, label: 'Medical note', sensitivity: 'sensitive' }),
];

const owl = generateOwl(ONTOLOGY, defs, NS);
const quads = parseTurtle(owl);

describe('generateOwl', () => {
  it('parses with n3 and matches the snapshot', () => {
    expect(quads.length).toBeGreaterThan(0);
    // The product name is swapped for a placeholder so a renamed fork's
    // snapshot (and the template-identity guard) stay green.
    expect(owl.split(APP_NAME).join('<APP_NAME>')).toMatchSnapshot();
  });

  it('is byte-identical across runs and independent of the order definitions arrive in', () => {
    expect(generateOwl(ONTOLOGY, defs, NS)).toBe(owl);
    expect(generateOwl(ONTOLOGY, [...defs].reverse(), NS)).toBe(owl);
  });

  it('declares the ontology with owl:versionInfo = ONTOLOGY_VERSION and the app-named label', () => {
    expect(subjectsOfType(quads, `${OWL}Ontology`)).toEqual([NS]);
    expect(objectsOf(quads, NS, `${OWL}versionInfo`).map((o) => o.value)).toEqual([ONTOLOGY_VERSION]);
    expect(objectsOf(quads, NS, `${RDFS}label`).map((o) => o.value)).toEqual([`${APP_NAME} ontology`]);
  });

  it('declares every entity and item type as an owl:Class with label, comment and alignment', () => {
    for (const type of ONTOLOGY.entityTypes()) {
      const cls = classIri(NS, type.key);
      expect(objectsOf(quads, cls, `${RDF}type`).map((o) => o.value)).toContain(`${OWL}Class`);
      expect(objectsOf(quads, cls, `${RDFS}label`).map((o) => o.value)).toEqual([type.label]);
      expect(objectsOf(quads, cls, `${RDFS}comment`).map((o) => o.value)).toEqual([type.description]);
      const expectedSuper = type.alignment ? [alignmentIri(type.alignment)] : [];
      expect(objectsOf(quads, cls, `${RDFS}subClassOf`).map((o) => o.value)).toEqual(expectedSuper);
    }
  });

  it('declares every attribute (own and mixin, every domain) with its property class and range', () => {
    const XSD_RANGE: Record<string, string> = {
      text: `${XSD}string`,
      select: `${XSD}string`,
      multi_select: `${XSD}string`,
      number: `${XSD}decimal`,
      date: `${XSD}date`,
      boolean: `${XSD}boolean`,
      url: `${XSD}anyURI`,
    };
    let count = 0;
    for (const type of ONTOLOGY.entityTypes()) {
      for (const { key, spec } of typeAttributes(ONTOLOGY, type)) {
        count++;
        const prop = attributeIri(NS, type.key, key, spec.alignment);
        const expectedClass = spec.kind === 'entity_ref' ? `${OWL}ObjectProperty` : `${OWL}DatatypeProperty`;
        expect(objectsOf(quads, prop, `${RDF}type`).map((o) => o.value)).toEqual([expectedClass]);
        expect(objectsOf(quads, prop, `${RDFS}label`).map((o) => o.value)).toContain(spec.label);
        if (spec.alignment) {
          // A standard property is never given our rdfs:domain (see the generator's header).
          expect(objectsOf(quads, prop, `${RDFS}domain`)).toEqual([]);
          expect(objectsOf(quads, prop, `${SCHEMA}domainIncludes`).map((o) => o.value)).toContain(classIri(NS, type.key));
          expect(objectsOf(quads, prop, `${SCHEMA}rangeIncludes`).map((o) => o.value)).toContain(XSD_RANGE[spec.kind]);
        } else {
          expect(objectsOf(quads, prop, `${RDFS}domain`).map((o) => o.value)).toEqual([classIri(NS, type.key)]);
          if (spec.kind !== 'entity_ref') {
            expect(objectsOf(quads, prop, `${RDFS}range`).map((o) => o.value)).toEqual([XSD_RANGE[spec.kind]]);
          }
        }
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it('uses the alignment as the attribute IRI (Person.title → schema:jobTitle, Organization.website → schema:url)', () => {
    expect(objectsOf(quads, `${SCHEMA}jobTitle`, `${RDF}type`).map((o) => o.value)).toEqual([`${OWL}DatatypeProperty`]);
    expect(objectsOf(quads, `${SCHEMA}url`, `${SCHEMA}rangeIncludes`).map((o) => o.value)).toEqual([`${XSD}anyURI`]);
    expect(quads.some((q) => q.subject.value === `${NS}Person.title`)).toBe(false);
  });

  it('declares every exported relation as an owl:ObjectProperty with domain, range and alignment', () => {
    for (const relation of exportedRelations(ONTOLOGY)) {
      const prop = relationIri(NS, relation.key);
      expect(objectsOf(quads, prop, `${RDF}type`).map((o) => o.value)).toEqual([`${OWL}ObjectProperty`]);
      expect(objectsOf(quads, prop, `${RDFS}label`).map((o) => o.value)).toEqual([relation.label]);
      expect(objectsOf(quads, prop, `${RDFS}domain`)).toHaveLength(1);
      expect(objectsOf(quads, prop, `${RDFS}range`)).toHaveLength(1);
      if (relation.alignment) {
        expect(objectsOf(quads, prop, `${RDFS}subPropertyOf`).map((o) => o.value)).toContain(alignmentIri(relation.alignment));
      }
      for (const key of Object.keys(relation.props)) {
        const propIri = relationPropIri(NS, relation.key, key, relation.props[key].alignment);
        expect(objectsOf(quads, propIri, `${RDFS}domain`).map((o) => o.value)).toEqual([`${NS}Assertion`]);
      }
    }
  });

  it('writes a relation with several endpoint types as an owl:unionOf class', () => {
    const range = objectsOf(quads, relationIri(NS, 'OWED_TO'), `${RDFS}range`)[0];
    const union = objectsOf(quads, range.value, `${OWL}unionOf`)[0];
    expect(listMembers(quads, union.value).map((o) => o.value)).toEqual([classIri(NS, 'Organization'), classIri(NS, 'Person')]);
  });

  it('makes SUPERSEDES a sub-property of prov:wasRevisionOf', () => {
    expect(objectsOf(quads, relationIri(NS, 'SUPERSEDES'), `${RDFS}subPropertyOf`).map((o) => o.value)).toEqual([
      `${PROV}wasRevisionOf`,
    ]);
  });

  it('never emits IDENTIFIED_AS, MENTIONS or SUPPORTED_BY as properties', () => {
    for (const key of ['IDENTIFIED_AS', 'MENTIONS', 'SUPPORTED_BY']) {
      expect(ONTOLOGY.relationType(key)).toBeDefined();
      expect(quads.some((q) => q.subject.value === relationIri(NS, key) || q.object.value === relationIri(NS, key))).toBe(false);
    }
  });

  it('declares kv:Assertion, kv:status and the four annotation properties', () => {
    expect(objectsOf(quads, `${NS}Assertion`, `${RDFS}subClassOf`).map((o) => o.value)).toEqual([`${RDF}Statement`]);
    expect(objectsOf(quads, `${NS}status`, `${RDF}type`).map((o) => o.value)).toEqual([`${OWL}DatatypeProperty`]);
    expect(subjectsOfType(quads, `${OWL}AnnotationProperty`).sort()).toEqual(
      ['confidence', 'ontologyVersion', 'reviewStatus', 'validPrecision'].map((n) => `${NS}${n}`),
    );
  });

  it('declares the caller’s attribute definitions as kv:attr/<id>, flags deprecated ones and omits sensitive ones', () => {
    const tier = userAttributeIri(NS, DEF_ID);
    expect(objectsOf(quads, tier, `${RDFS}label`).map((o) => o.value)).toEqual(['Tier']);
    expect(objectsOf(quads, tier, `${RDFS}domain`).map((o) => o.value)).toEqual([classIri(NS, 'Organization')]);
    expect(objectsOf(quads, tier, `${RDFS}range`).map((o) => o.value)).toEqual([`${XSD}string`]);
    expect(objectsOf(quads, tier, `${OWL}deprecated`)).toEqual([]);

    const old = userAttributeIri(NS, DEPRECATED_ID);
    expect(objectsOf(quads, old, `${OWL}deprecated`).map((o) => o.value)).toEqual(['true']);

    expect(owl).not.toContain(SENSITIVE_ID);
    expect(owl).not.toContain('Medical note');
  });

  it('never contains another owner’s definitions: the output is a function of the definitions passed in', () => {
    const otherOwner = generateOwl(ONTOLOGY, [userDef({ id: '44444444-4444-4444-8444-444444444444', label: 'Theirs' })], NS);
    expect(otherOwner).not.toContain(DEF_ID);
    expect(owl).not.toContain('Theirs');
  });

  it('ignores a definition on a type the registry does not know', () => {
    const out = generateOwl(ONTOLOGY, [userDef({ id: DEF_ID, entityType: 'Spaceship' })], NS);
    expect(out).not.toContain(DEF_ID);
  });
});
