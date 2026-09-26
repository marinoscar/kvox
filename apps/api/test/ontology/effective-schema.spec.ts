/**
 * Effective schema (issue #350, docs/specs/ontology.md §17.2–§17.4):
 * `core ∪ {enabled domains}`, mixins merged, user attributes merged after the
 * built-ins, and relation endpoints pruned to the types actually present.
 */
import {
  DEFAULT_ENABLED_DOMAINS,
  ONTOLOGY_VERSION,
  OntologyDefinitionError,
  type UserAttributeDef,
  buildPropsJsonSchema,
  computeEffectiveSchema,
  toEffectiveSchemaPayload,
  validateProps,
} from '@app/shared/ontology';

function userDef(over: Partial<UserAttributeDef> = {}): UserAttributeDef {
  return {
    id: '5d0f4b0e-7a47-4c3e-9f0a-0a1b2c3d4e5f',
    entityType: 'Person',
    key: 'u_nickname01',
    label: 'Nickname',
    kind: 'text',
    options: null,
    extractable: true,
    extractionHint: 'How this person is addressed informally, e.g. by teammates',
    sensitivity: null,
    sortOrder: 10,
    deprecatedAt: null,
    ...over,
  };
}

describe('computeEffectiveSchema', () => {
  describe('core only', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });

    it('contains only core types', () => {
      expect(schema.entityTypes.map((t) => t.key)).toEqual(['Person', 'Organization', 'Meeting', 'Claim', 'PersonFact']);
      expect(schema.enabledDomains).toEqual(['core']);
    });

    it('forces core in even when absent from enabledDomains', () => {
      expect(schema.domains.find((d) => d.key === 'core')).toEqual({
        key: 'core',
        label: 'Core',
        enabled: true,
        alwaysOn: true,
      });
      expect(schema.domains.find((d) => d.key === 'work')?.enabled).toBe(false);
    });

    it('omits relations whose endpoints vanished and narrows the rest', () => {
      const keys = schema.relationTypes.map((r) => r.key);
      expect(keys).not.toContain('WORKS_FOR');
      expect(keys).not.toContain('PART_OF');
      for (const r of schema.relationTypes) {
        for (const endpoint of [...r.from, ...r.to, ...(r.allowedPairs ?? []).flat()]) {
          expect(['Project', 'Commitment', 'Decision']).not.toContain(endpoint);
        }
      }
      const about = schema.relationTypeByKey.get('ABOUT');
      expect(about?.from).toEqual(['Claim', 'PersonFact']);
      expect(about?.to).toEqual(['Person', 'Organization', 'Meeting']);
      expect(schema.relationTypeByKey.get('SUPERSEDES')?.allowedPairs).toEqual([['Claim', 'Claim']]);
    });

    it('narrows item subject types to present types', () => {
      expect(schema.entityTypeByKey.get('Claim')?.subjectTypes).toEqual(['Person', 'Organization', 'Meeting']);
    });

    it('does not merge the work mixin onto Person', () => {
      expect(schema.entityTypeByKey.get('Person')?.attributes).toEqual([]);
    });

    it('is deeply frozen', () => {
      expect(Object.isFrozen(schema)).toBe(true);
      expect(Object.isFrozen(schema.entityTypes[0])).toBe(true);
      expect(Object.isFrozen(schema.entityTypes[0].disambiguation)).toBe(true);
    });
  });

  describe('core + work', () => {
    const schema = computeEffectiveSchema({ enabledDomains: DEFAULT_ENABLED_DOMAINS, userAttributes: [] });

    it('contains every type and all 15 relations', () => {
      expect(schema.entityTypes).toHaveLength(8);
      expect(schema.relationTypes).toHaveLength(15);
      expect(schema.version).toBe(ONTOLOGY_VERSION);
    });

    it('merges the work mixin title onto Person as source mixin, domain work', () => {
      const title = schema.entityTypeByKey.get('Person')?.attributes.find((a) => a.key === 'title');
      expect(title).toMatchObject({ source: 'mixin', domain: 'work', kind: 'text', extractable: true, sensitivity: 'business' });
    });

    it('keeps ABOUT.from complete and reports storage/itemKind per type', () => {
      expect(schema.relationTypeByKey.get('ABOUT')?.from).toEqual(['Claim', 'Decision', 'Commitment', 'PersonFact']);
      expect(schema.entityTypeByKey.get('Commitment')).toMatchObject({ storage: 'item', itemKind: 'commitment' });
      expect(schema.entityTypeByKey.get('Project')).toMatchObject({ storage: 'entity', itemKind: null });
      expect(schema.relationTypeByKey.get('HAS_ROLE')?.exclusiveScope).toBe('from_to');
      expect(schema.relationTypeByKey.get('WORKS_FOR')?.exclusiveScope).toBe('from');
    });
  });

  describe('user attributes', () => {
    const live = userDef();
    const early = userDef({ id: 'a1', key: 'u_aaaaaaaaaa', label: 'Early', sortOrder: 1, extractionHint: null });
    const deprecated = userDef({ id: 'd1', key: 'u_dddddddddd', label: 'Old', sortOrder: 5, deprecatedAt: '2026-01-01T00:00:00Z' });
    const disabledDomainType = userDef({ id: 'p1', entityType: 'Project', key: 'u_pppppppppp' });
    const schema = computeEffectiveSchema({
      enabledDomains: [],
      userAttributes: [live, deprecated, early, disabledDomainType],
    });
    const person = schema.entityTypeByKey.get('Person')!;

    it('appends them after built-ins, ordered by sortOrder, marked source user', () => {
      expect(person.attributes.map((a) => a.key)).toEqual(['u_aaaaaaaaaa', 'u_dddddddddd', 'u_nickname01']);
      const nick = person.attributes.find((a) => a.key === 'u_nickname01')!;
      expect(nick).toMatchObject({
        source: 'user',
        domain: null,
        attributeDefId: live.id,
        sortOrder: 10,
        description: live.extractionHint,
        sensitivity: 'business',
        deprecated: false,
      });
    });

    it('falls back to the label when there is no extraction hint', () => {
      expect(person.attributes.find((a) => a.key === 'u_aaaaaaaaaa')?.description).toBe('Early');
    });

    it('marks a deprecated def deprecated, drops it from the JSON Schema, still accepts it on write', () => {
      expect(person.attributes.find((a) => a.key === 'u_dddddddddd')?.deprecated).toBe(true);
      const json = buildPropsJsonSchema(schema, 'Person') as { properties: Record<string, unknown> };
      expect(Object.keys(json.properties)).toEqual(['u_aaaaaaaaaa', 'u_nickname01']);
      expect(validateProps(schema, 'Person', { u_dddddddddd: 'kept' })).toEqual({ ok: true, value: { u_dddddddddd: 'kept' } });
    });

    it('skips a def whose type is not in the effective schema', () => {
      expect(schema.entityTypeByKey.has('Project')).toBe(false);
    });

    it('places user attributes after the mixin when work is enabled', () => {
      const withWork = computeEffectiveSchema({ enabledDomains: ['work'], userAttributes: [live] });
      expect(withWork.entityTypeByKey.get('Person')?.attributes.map((a) => [a.key, a.source])).toEqual([
        ['title', 'mixin'],
        ['u_nickname01', 'user'],
      ]);
    });

    it('rejects a malformed key and a key used twice', () => {
      expect(() => computeEffectiveSchema({ enabledDomains: [], userAttributes: [userDef({ key: 'nickname' })] })).toThrow(
        OntologyDefinitionError,
      );
      expect(() => computeEffectiveSchema({ enabledDomains: [], userAttributes: [live, userDef({ id: 'x2' })] })).toThrow(
        /used twice on Person/,
      );
    });
  });

  describe('toEffectiveSchemaPayload', () => {
    it('round-trips through JSON unchanged', () => {
      const schema = computeEffectiveSchema({
        enabledDomains: DEFAULT_ENABLED_DOMAINS,
        userAttributes: [
          userDef(),
          userDef({
            id: 'sel',
            key: 'u_select0001',
            kind: 'select',
            options: { choices: [{ value: 'a', label: 'A' }] },
            deprecatedAt: '2026-02-02T00:00:00Z',
          }),
        ],
      });
      const payload = toEffectiveSchemaPayload(schema);
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
      expect(Object.keys(payload).sort()).toEqual(['domains', 'entityTypes', 'relationTypes', 'version']);
      expect(payload.entityTypes.find((t) => t.key === 'Person')?.attributes).toHaveLength(3);
    });
  });
});
