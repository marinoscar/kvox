import { ONTOLOGY } from '@app/shared/ontology';

import { buildImportVocabulary } from '../../../src/graph/import/import-vocabulary';
import { assertionShapeIri, shapeIri } from '../../../src/graph/rdf/iris';
import { generateShacl } from '../../../src/graph/rdf/shacl-generator';
import { FIXTURE_NS, SH, listMembers, objectsOf, parseTurtle, shapePaths, userDef } from './rdf-fixtures';

// =============================================================================
// The import's closed vocabulary equals the generated shapes (#387)
// =============================================================================
//
// `import-vocabulary.ts` decides which predicates are UNKNOWN (offered and
// removed before validation). If it ever admitted less than a shape does, an
// import would strip data the shape accepts; if more, it would keep a
// property the closed shape then rejects — failing the whole file instead of
// offering it. So: for every node shape, `sh:property` paths ∪
// `sh:ignoredProperties` must equal the vocabulary's set, exactly.
// =============================================================================

const DEFS = [
  userDef({ id: '11111111-1111-4111-8111-111111111111', entityType: 'Organization', key: 'u_tier000001', label: 'Tier' }),
  userDef({ id: '22222222-2222-4222-8222-222222222222', entityType: 'Person', key: 'u_secret0001', label: 'Secret', sensitivity: 'sensitive' }),
];

describe('import vocabulary ≡ generated SHACL', () => {
  const shapes = parseTurtle(generateShacl(ONTOLOGY, DEFS, FIXTURE_NS));
  const vocabulary = buildImportVocabulary(ONTOLOGY, DEFS, FIXTURE_NS);

  const admitted = (shape: string): string[] => {
    const ignoredHead = objectsOf(shapes, shape, `${SH}ignoredProperties`)[0];
    const ignored = ignoredHead ? listMembers(shapes, ignoredHead.value).map((t) => t.value) : [];
    return [...new Set([...shapePaths(shapes, shape), ...ignored])].sort();
  };

  it.each(ONTOLOGY.entityTypes().map((t) => t.key))('%s', (typeKey) => {
    expect([...(vocabulary.allowed.get(typeKey) ?? [])].sort()).toEqual(admitted(shapeIri(FIXTURE_NS, typeKey)));
  });

  it('kv:Assertion', () => {
    expect([...vocabulary.assertionAllowed].sort()).toEqual(admitted(assertionShapeIri(FIXTURE_NS)));
  });

  it('never admits a sensitive user attribute (it is never exported, so a closed shape rejects it)', () => {
    expect(vocabulary.allowed.get('Person')?.has(`${FIXTURE_NS}attr/22222222-2222-4222-8222-222222222222`)).toBe(false);
    expect(vocabulary.allowed.get('Organization')?.has(`${FIXTURE_NS}attr/11111111-1111-4111-8111-111111111111`)).toBe(true);
  });
});
