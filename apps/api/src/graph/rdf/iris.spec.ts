import { APP_SLUG } from '@app/shared';
import { kvNamespace } from '@app/shared/ontology';

import {
  ANNOTATION_PROPERTIES,
  alignmentIri,
  annotationIri,
  assertionClassIri,
  assertionShapeIri,
  attributeIri,
  classIri,
  entityIri,
  evidenceIri,
  itemIri,
  itemStatusIri,
  noteSpanIri,
  relationInstanceIri,
  relationIri,
  relationPropIri,
  segmentIri,
  shapeIri,
  userAttributeIri,
  type AnnotationProperty,
} from './iris';

// =============================================================================
// iris.ts (#385, docs/specs/ontology.md §18.1): one rule per function, and a
// refusal for anything that would make an IRI name something else.
// =============================================================================

const NS = 'https://fixture.app/ns#';
const UUID = '0b6e3c1a-4d2f-4a8b-9c7d-112233445566';

describe('kvNamespace', () => {
  it('derives the namespace from the application slug', () => {
    expect(kvNamespace('fixture')).toBe(NS);
    expect(kvNamespace(APP_SLUG)).toBe(`https://${APP_SLUG}.app/ns#`);
  });

  it.each(['', 'Upper', 'has space', '-lead', 'trail-', 'a/b'])('refuses %j', (slug) => {
    expect(() => kvNamespace(slug)).toThrow(/slug/);
  });
});

describe('vocabulary IRIs', () => {
  it('names a class kv:<TypeKey> and its shape kv:<TypeKey>Shape', () => {
    expect(classIri(NS, 'Person')).toBe(`${NS}Person`);
    expect(shapeIri(NS, 'PersonFact')).toBe(`${NS}PersonFactShape`);
  });

  it('names a built-in attribute kv:<TypeKey>.<attrKey>, or uses its alignment', () => {
    expect(attributeIri(NS, 'Project', 'startDate')).toBe(`${NS}Project.startDate`);
    expect(attributeIri(NS, 'Person', 'title', 'schema:jobTitle')).toBe('https://schema.org/jobTitle');
  });

  it('names a relation prop kv:<REL>.<propKey>, or uses its alignment', () => {
    expect(relationPropIri(NS, 'HAS_ROLE', 'title')).toBe(`${NS}HAS_ROLE.title`);
    expect(relationPropIri(NS, 'HAS_ROLE', 'title', 'schema:roleName')).toBe('https://schema.org/roleName');
  });

  it('names a user attribute by its definition id, lowercased, never by its label', () => {
    expect(userAttributeIri(NS, UUID)).toBe(`${NS}attr/${UUID}`);
    expect(userAttributeIri(NS, UUID.toUpperCase())).toBe(`${NS}attr/${UUID}`);
  });

  it('names a relation kv:<RELATION_KEY>', () => {
    expect(relationIri(NS, 'WORKS_FOR')).toBe(`${NS}WORKS_FOR`);
  });

  it('names the four annotation properties, the item status and the reified assertion', () => {
    expect(ANNOTATION_PROPERTIES.map((name) => annotationIri(NS, name))).toEqual([
      `${NS}reviewStatus`,
      `${NS}confidence`,
      `${NS}ontologyVersion`,
      `${NS}validPrecision`,
    ]);
    expect(itemStatusIri(NS)).toBe(`${NS}status`);
    expect(assertionClassIri(NS)).toBe(`${NS}Assertion`);
    expect(assertionShapeIri(NS)).toBe(`${NS}AssertionShape`);
  });

  it('expands an alignment CURIE and refuses an unknown prefix', () => {
    expect(alignmentIri('prov:wasRevisionOf')).toBe('http://www.w3.org/ns/prov#wasRevisionOf');
    expect(() => alignmentIri('ex:thing')).toThrow(/no known prefix/);
    expect(() => alignmentIri('schema:')).toThrow(/no known prefix/);
  });

  it.each([
    ['a type key that is not PascalCase', () => classIri(NS, 'person')],
    ['a type key with punctuation', () => shapeIri(NS, 'Per>son')],
    ['an attribute key that is not camelCase', () => attributeIri(NS, 'Person', 'Job Title')],
    ['a user attribute key instead of a definition id', () => userAttributeIri(NS, 'u_abcdefghij')],
    ['a relation key that is not SCREAMING_SNAKE', () => relationIri(NS, 'worksFor')],
    ['a relation prop key with a slash', () => relationPropIri(NS, 'HAS_ROLE', 'a/b')],
    ['an unknown annotation property', () => annotationIri(NS, 'status' as AnnotationProperty)],
    ['a namespace without a trailing # or /', () => classIri('https://fixture.app/ns', 'Person')],
    ['a namespace that is not http(s)', () => classIri('urn:x#', 'Person')],
  ])('refuses %s', (_label, build) => {
    expect(build).toThrow();
  });
});

describe('resource IRIs (#386)', () => {
  it('names entities, items, relations, evidence and segments by UUID', () => {
    expect(entityIri(NS, UUID)).toBe(`${NS}entity/${UUID}`);
    expect(itemIri(NS, UUID)).toBe(`${NS}item/${UUID}`);
    expect(relationInstanceIri(NS, UUID)).toBe(`${NS}relation/${UUID}`);
    expect(evidenceIri(NS, UUID)).toBe(`${NS}evidence/${UUID}`);
    expect(segmentIri(NS, UUID)).toBe(`${NS}segment/${UUID}`);
  });

  it('names a note span by note id and version', () => {
    expect(noteSpanIri(NS, UUID, 3)).toBe(`${NS}note/${UUID}/v3`);
  });

  it.each([
    ['a non-UUID id', () => entityIri(NS, 'not-a-uuid')],
    ['an id carrying a path', () => itemIri(NS, `${UUID}/../x`)],
    ['version 0', () => noteSpanIri(NS, UUID, 0)],
    ['a fractional version', () => noteSpanIri(NS, UUID, 1.5)],
  ])('refuses %s', (_label, build) => {
    expect(build).toThrow();
  });
});
