import { APP_NAME } from '@app/shared';
import { ONTOLOGY, VALID_PRECISIONS } from '@app/shared/ontology';

import {
  FIXTURE_NS as NS,
  PROV,
  RDF,
  RDFS,
  SH,
  XSD,
  listMembers,
  objectsOf,
  parseTurtle,
  propertyShape,
  shapePaths,
  subjectsOfType,
  userDef,
} from '../../../test/graph/rdf/rdf-fixtures';
import { alignmentIri, attributeIri, classIri, relationIri, shapeIri, userAttributeIri } from './iris';
import { exportedRelations, targetsFrom, typeAttributes } from './ontology-rdf-model';
import { URL_PATTERN, generateShacl } from './shacl-generator';

// =============================================================================
// generateShacl (#385, docs/specs/ontology.md §18.2 item 2)
//
// Structure is asserted over the parsed graph, iterating the registry; the
// behaviour of the shapes against real data is `test/graph/rdf/
// shacl-validation.spec.ts`, which runs them through rdf-validate-shacl.
// =============================================================================

const TIER_ID = '11111111-1111-4111-8111-111111111111';
const SENSITIVE_ID = '33333333-3333-4333-8333-333333333333';
const LINK_ID = '55555555-5555-4555-8555-555555555555';

const defs = [
  userDef({
    id: TIER_ID,
    entityType: 'Organization',
    key: 'u_tier000001',
    label: 'Tier',
    kind: 'select',
    options: { choices: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }] },
  }),
  userDef({ id: SENSITIVE_ID, label: 'Medical note', sensitivity: 'sensitive' }),
  userDef({
    id: LINK_ID,
    entityType: 'Project',
    key: 'u_sponsor001',
    label: 'Sponsor',
    kind: 'entity_ref',
    options: { targetTypes: ['Person', 'Organization'] },
  }),
];

const shacl = generateShacl(ONTOLOGY, defs, NS);
const quads = parseTurtle(shacl);
const values = (subject: string, predicate: string) => objectsOf(quads, subject, predicate).map((o) => o.value);
const listOf = (subject: string, predicate: string) =>
  listMembers(quads, objectsOf(quads, subject, predicate)[0].value).map((o) => o.value);

describe('generateShacl', () => {
  it('parses with n3 and matches the snapshot', () => {
    expect(quads.length).toBeGreaterThan(0);
    expect(shacl.split(APP_NAME).join('<APP_NAME>')).toMatchSnapshot();
  });

  it('is byte-identical across runs and independent of the order definitions arrive in', () => {
    expect(generateShacl(ONTOLOGY, defs, NS)).toBe(shacl);
    expect(generateShacl(ONTOLOGY, [...defs].reverse(), NS)).toBe(shacl);
  });

  it('has exactly one closed node shape per entity/item type, plus kv:AssertionShape', () => {
    const expected = [...ONTOLOGY.entityTypes().map((t) => shapeIri(NS, t.key)), `${NS}AssertionShape`].sort();
    expect(subjectsOfType(quads, `${SH}NodeShape`).sort()).toEqual(expected);
    for (const type of ONTOLOGY.entityTypes()) {
      const shape = shapeIri(NS, type.key);
      expect(values(shape, `${SH}targetClass`)).toEqual([classIri(NS, type.key)]);
      expect(values(shape, `${SH}closed`)).toEqual(['true']);
    }
  });

  it('ignores rdf:type, rdfs:label, the kv: annotations, prov:wasDerivedFrom and aligned relation IRIs', () => {
    for (const type of ONTOLOGY.entityTypes()) {
      const ignored = listOf(shapeIri(NS, type.key), `${SH}ignoredProperties`);
      expect(ignored.slice(0, 6)).toEqual([
        `${RDF}type`,
        `${RDFS}label`,
        `${NS}reviewStatus`,
        `${NS}confidence`,
        `${NS}ontologyVersion`,
        `${PROV}wasDerivedFrom`,
      ]);
    }
    expect(listOf(shapeIri(NS, 'Person'), `${SH}ignoredProperties`)).toEqual(
      expect.arrayContaining(['https://schema.org/worksFor', 'https://schema.org/hasOccupation', 'https://schema.org/attendee']),
    );
  });

  it('requires at least one prov:wasDerivedFrom on every node shape — the no-orphans rule', () => {
    for (const shape of subjectsOfType(quads, `${SH}NodeShape`)) {
      const node = propertyShape(quads, shape, `${PROV}wasDerivedFrom`);
      expect(node).toBeDefined();
      expect(values(node!, `${SH}minCount`)).toEqual(['1']);
    }
  });

  it('constrains every attribute of every type (own and mixin, every domain)', () => {
    for (const type of ONTOLOGY.entityTypes()) {
      const shape = shapeIri(NS, type.key);
      for (const { key, spec } of typeAttributes(ONTOLOGY, type)) {
        const node = propertyShape(quads, shape, attributeIri(NS, type.key, key, spec.alignment));
        expect(node).toBeDefined();
        const multi = spec.kind === 'multi_select' || spec.list === true;
        expect(values(node!, `${SH}maxCount`)).toEqual(multi ? [] : ['1']);
        expect(values(node!, `${SH}minCount`)).toEqual(spec.required ? ['1'] : []);
        if (spec.kind === 'select' || spec.kind === 'multi_select') {
          expect(listOf(node!, `${SH}in`)).toEqual(spec.options?.choices?.map((c) => c.value));
        }
        if (spec.kind === 'url') {
          expect(values(node!, `${SH}pattern`)).toEqual([URL_PATTERN]);
          expect(values(node!, `${SH}datatype`)).toEqual([`${XSD}anyURI`]);
        }
      }
    }
  });

  it('turns a select into sh:in, a list into no sh:maxCount, and an aligned attribute into its standard path', () => {
    const status = propertyShape(quads, shapeIri(NS, 'Project'), `${NS}Project.status`)!;
    expect(listOf(status, `${SH}in`)).toEqual(['planned', 'active', 'done', 'cancelled']);
    const topics = propertyShape(quads, shapeIri(NS, 'Meeting'), `${NS}Meeting.topics`)!;
    expect(values(topics, `${SH}maxCount`)).toEqual([]);
    expect(propertyShape(quads, shapeIri(NS, 'Person'), 'https://schema.org/jobTitle')).toBeDefined();
  });

  it('constrains every exported relation from each source type by the class of its targets', () => {
    for (const relation of exportedRelations(ONTOLOGY)) {
      for (const type of ONTOLOGY.entityTypes()) {
        const targets = targetsFrom(relation, type);
        const node = propertyShape(quads, shapeIri(NS, type.key), relationIri(NS, relation.key));
        if (targets.length === 0) {
          expect(node).toBeUndefined();
          continue;
        }
        expect(node).toBeDefined();
        if (targets.length === 1) {
          expect(values(node!, `${SH}class`)).toEqual([classIri(NS, targets[0])]);
        } else {
          const members = listOf(node!, `${SH}or`);
          expect(members.map((m) => values(m, `${SH}class`)[0])).toEqual(targets.map((t) => classIri(NS, t)));
        }
      }
    }
  });

  it('narrows endpoints by allowedPairs and by an item’s subjectTypes', () => {
    // PART_OF: Project → Organization, Meeting → Project.
    expect(values(propertyShape(quads, shapeIri(NS, 'Project'), relationIri(NS, 'PART_OF'))!, `${SH}class`)).toEqual([
      classIri(NS, 'Organization'),
    ]);
    expect(values(propertyShape(quads, shapeIri(NS, 'Meeting'), relationIri(NS, 'PART_OF'))!, `${SH}class`)).toEqual([
      classIri(NS, 'Project'),
    ]);
    // A PersonFact is ABOUT a Person only, and must be about something.
    const about = propertyShape(quads, shapeIri(NS, 'PersonFact'), relationIri(NS, 'ABOUT'))!;
    expect(values(about, `${SH}class`)).toEqual([classIri(NS, 'Person')]);
    expect(values(about, `${SH}minCount`)).toEqual(['1']);
    expect(values(about, `${SH}maxCount`)).toEqual(['1']);
    // A Commitment's subject is optional.
    const commitmentAbout = propertyShape(quads, shapeIri(NS, 'Commitment'), relationIri(NS, 'ABOUT'))!;
    expect(values(commitmentAbout, `${SH}minCount`)).toEqual([]);
  });

  it('never constrains IDENTIFIED_AS, MENTIONS or SUPPORTED_BY', () => {
    for (const key of ['IDENTIFIED_AS', 'MENTIONS', 'SUPPORTED_BY']) {
      expect(quads.some((q) => q.object.value === relationIri(NS, key))).toBe(false);
    }
  });

  it('constrains each item type’s kv:status to its declared statuses', () => {
    for (const type of ONTOLOGY.entityTypes()) {
      const node = propertyShape(quads, shapeIri(NS, type.key), `${NS}status`);
      if (type.itemKind === undefined) {
        expect(node).toBeUndefined();
      } else {
        expect(listOf(node!, `${SH}in`)).toEqual([...(type.statuses ?? [])]);
      }
    }
  });

  it('adds the caller’s definitions to their type’s shape, and omits sensitive ones', () => {
    const tier = propertyShape(quads, shapeIri(NS, 'Organization'), userAttributeIri(NS, TIER_ID))!;
    expect(listOf(tier, `${SH}in`)).toEqual(['gold', 'silver']);
    expect(values(tier, `${SH}name`)).toEqual(['Tier']);
    expect(shapePaths(quads, shapeIri(NS, 'Person'))).not.toContain(userAttributeIri(NS, TIER_ID));

    const sponsor = propertyShape(quads, shapeIri(NS, 'Project'), userAttributeIri(NS, LINK_ID))!;
    expect(values(sponsor, `${SH}nodeKind`)).toEqual([`${SH}IRI`]);
    expect(listOf(sponsor, `${SH}or`).map((m) => values(m, `${SH}class`)[0])).toEqual([
      classIri(NS, 'Organization'),
      classIri(NS, 'Person'),
    ]);

    expect(shacl).not.toContain(SENSITIVE_ID);
    expect(shacl).not.toContain('Medical note');
  });

  it('describes a reified temporal edge with kv:AssertionShape', () => {
    const shape = `${NS}AssertionShape`;
    expect(values(shape, `${SH}targetClass`)).toEqual([`${NS}Assertion`]);
    for (const path of [`${RDF}subject`, `${RDF}object`]) {
      expect(values(propertyShape(quads, shape, path)!, `${SH}minCount`)).toEqual(['1']);
    }
    const predicate = propertyShape(quads, shape, `${RDF}predicate`)!;
    const temporal = ONTOLOGY.relationTypes().filter((r) => r.temporal).map((r) => relationIri(NS, r.key)).sort();
    expect(listOf(predicate, `${SH}in`).sort()).toEqual(temporal);

    const started = propertyShape(quads, shape, `${PROV}startedAtTime`)!;
    expect(values(started, `${SH}datatype`)).toEqual([`${XSD}dateTime`]);
    expect(values(started, `${SH}maxCount`)).toEqual(['1']);
    expect(listOf(propertyShape(quads, shape, `${NS}validPrecision`)!, `${SH}in`)).toEqual([...VALID_PRECISIONS]);
    expect(values(propertyShape(quads, shape, `${PROV}wasDerivedFrom`)!, `${SH}minCount`)).toEqual(['1']);

    // HAS_ROLE's required title: required only when the predicate is HAS_ROLE.
    expect(propertyShape(quads, shape, `${NS}HAS_ROLE.title`)).toBeDefined();
    expect(objectsOf(quads, shape, `${SH}or`)).toHaveLength(1);
  });

  it('uses the aligned IRI for a relation’s alignment in the ignore list, never as the relation path', () => {
    const worksFor = ONTOLOGY.relationType('WORKS_FOR')!;
    expect(shapePaths(quads, shapeIri(NS, 'Person'))).toContain(relationIri(NS, 'WORKS_FOR'));
    expect(shapePaths(quads, shapeIri(NS, 'Person'))).not.toContain(alignmentIri(worksFor.alignment!));
  });
});
