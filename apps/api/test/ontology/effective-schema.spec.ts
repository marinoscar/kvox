import { computeEffectiveSchema, toEffectiveSchemaPayload, ONTOLOGY } from '@app/shared/ontology';
import type { UserAttributeDef } from '@app/shared/ontology';

describe('computeEffectiveSchema', () => {
  describe('core-only (no domains enabled)', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });

    it('forces core in even though it was not requested', () => {
      expect(schema.enabledDomains).toContain('core');
      const core = schema.domains.find((d) => d.key === 'core');
      expect(core?.enabled).toBe(true);
      expect(core?.alwaysOn).toBe(true);
    });

    it('contains only core types', () => {
      const keys = schema.entityTypes.map((t) => t.key).sort();
      expect(keys).toEqual(['Claim', 'Meeting', 'Organization', 'Person', 'PersonFact'].sort());
    });

    it('has no relation referencing Project, Commitment or Decision', () => {
      for (const r of schema.relationTypes) {
        expect(r.from).not.toContain('Project');
        expect(r.from).not.toContain('Commitment');
        expect(r.from).not.toContain('Decision');
        expect(r.to).not.toContain('Project');
        expect(r.to).not.toContain('Commitment');
        expect(r.to).not.toContain('Decision');
      }
    });

    it('omits WORKS_FOR entirely (a work-domain relation)', () => {
      expect(schema.relationType('WORKS_FOR')).toBeUndefined();
      expect(schema.relationTypes.map((r) => r.key)).not.toContain('WORKS_FOR');
    });

    it('narrows ABOUT.from to the core item types (Claim, PersonFact)', () => {
      const about = schema.relationType('ABOUT');
      expect(about).toBeDefined();
      expect(about?.from.slice().sort()).toEqual(['Claim', 'PersonFact'].sort());
    });

    it('prunes SUPERSEDES allowedPairs down to Claim -> Claim only', () => {
      const supersedes = schema.relationType('SUPERSEDES');
      expect(supersedes).toBeDefined();
      expect(supersedes?.from).toEqual(['Claim']);
      expect(supersedes?.to).toEqual(['Claim']);
      expect(supersedes?.allowedPairs).toEqual([['Claim', 'Claim']]);
    });

    it('omits PART_OF entirely once its allowedPairs prune to nothing (Project absent)', () => {
      expect(schema.relationType('PART_OF')).toBeUndefined();
    });

    it('Person has no mixin attributes', () => {
      const person = schema.entityType('Person');
      expect(person?.attributes.some((a) => a.source === 'mixin')).toBe(false);
    });
  });

  describe('core + work', () => {
    const schema = computeEffectiveSchema({ enabledDomains: ['work'], userAttributes: [] });

    it('includes both core and work types', () => {
      const keys = schema.entityTypes.map((t) => t.key).sort();
      expect(keys).toEqual(
        ['Claim', 'Commitment', 'Decision', 'Meeting', 'Organization', 'Person', 'PersonFact', 'Project'].sort(),
      );
    });

    it('marks the work domain enabled', () => {
      const work = schema.domains.find((d) => d.key === 'work');
      expect(work?.enabled).toBe(true);
    });

    it('gives Person the work mixin attribute "title", sourced from the mixin domain', () => {
      const person = schema.entityType('Person');
      const title = person?.attributes.find((a) => a.key === 'title');
      expect(title).toBeDefined();
      expect(title?.source).toBe('mixin');
      expect(title?.domain).toBe('work');
    });

    it('includes WORKS_FOR, PART_OF and the rest of the work relations', () => {
      expect(schema.relationType('WORKS_FOR')).toBeDefined();
      const partOf = schema.relationType('PART_OF');
      expect(partOf).toBeDefined();
      expect(partOf?.allowedPairs).toEqual([
        ['Project', 'Organization'],
        ['Meeting', 'Project'],
      ]);
    });

    it('restores SUPERSEDES to its full three pairs', () => {
      const supersedes = schema.relationType('SUPERSEDES');
      expect(supersedes?.allowedPairs?.length).toBe(3);
    });
  });

  describe('user attributes', () => {
    const userAttr: UserAttributeDef = {
      id: 'attr-1',
      entityType: 'Person',
      key: 'u_abc1234567',
      label: 'Favorite color',
      kind: 'text',
      options: null,
      extractable: true,
      extractionHint: 'The person\'s stated favorite color, if mentioned.',
      sensitivity: null,
      sortOrder: 1000,
      deprecatedAt: null,
    };

    it('merges a user attribute def into the target type, marked source: "user" with its attributeDefId', () => {
      const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [userAttr] });
      const person = schema.entityType('Person');
      const found = person?.attributes.find((a) => a.key === 'u_abc1234567');
      expect(found).toBeDefined();
      expect(found?.source).toBe('user');
      expect(found?.attributeDefId).toBe('attr-1');
      expect(found?.label).toBe('Favorite color');
    });

    it('orders user attributes after built-ins (by sortOrder)', () => {
      const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [userAttr] });
      const person = schema.entityType('Person');
      const keys = person?.attributes.map((a) => a.key) ?? [];
      // Person has no core attributes and no mixin (core-only), so the user
      // attribute is the only entry — still, its source must be 'user'.
      expect(person?.attributes[keys.length - 1]?.source).toBe('user');
    });

    it('orders multiple user attributes after built-ins, sorted by sortOrder', () => {
      const second: UserAttributeDef = { ...userAttr, id: 'attr-2', key: 'u_zzz1234567', sortOrder: 1 };
      const schema = computeEffectiveSchema({ enabledDomains: ['work'], userAttributes: [userAttr, second] });
      const person = schema.entityType('Person');
      const userKeys = person?.attributes.filter((a) => a.source === 'user').map((a) => a.key);
      expect(userKeys).toEqual(['u_zzz1234567', 'u_abc1234567']);
    });

    it('uses extractionHint as description when present, else falls back to label', () => {
      const withHint = computeEffectiveSchema({ enabledDomains: [], userAttributes: [userAttr] });
      const found = withHint.entityType('Person')?.attributes.find((a) => a.key === 'u_abc1234567');
      expect(found?.description).toBe(userAttr.extractionHint);

      const noHint: UserAttributeDef = { ...userAttr, extractionHint: null };
      const withoutHint = computeEffectiveSchema({ enabledDomains: [], userAttributes: [noHint] });
      const found2 = withoutHint.entityType('Person')?.attributes.find((a) => a.key === 'u_abc1234567');
      expect(found2?.description).toBe(userAttr.label);
    });

    it('marks a deprecated user attribute def as deprecated: true', () => {
      const deprecated: UserAttributeDef = { ...userAttr, deprecatedAt: '2026-01-01T00:00:00.000Z' };
      const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [deprecated] });
      const found = schema.entityType('Person')?.attributes.find((a) => a.key === 'u_abc1234567');
      expect(found?.deprecated).toBe(true);
    });

    it('silently drops a user attribute def whose entity type is not present (its domain is disabled)', () => {
      const forWorkType: UserAttributeDef = { ...userAttr, entityType: 'Project' };
      expect(() => computeEffectiveSchema({ enabledDomains: [], userAttributes: [forWorkType] })).not.toThrow();
      const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [forWorkType] });
      expect(schema.entityType('Project')).toBeUndefined();
    });

    it('throws on a malformed user attribute def (bad key format)', () => {
      const bad: UserAttributeDef = { ...userAttr, key: 'not-a-user-key' };
      expect(() => computeEffectiveSchema({ enabledDomains: [], userAttributes: [bad] })).toThrow();
    });

    it('throws on a duplicate user attribute key on the same type', () => {
      const dup: UserAttributeDef = { ...userAttr, id: 'attr-dup' };
      expect(() => computeEffectiveSchema({ enabledDomains: [], userAttributes: [userAttr, dup] })).toThrow();
    });
  });

  describe('payload JSON round trip', () => {
    it('toEffectiveSchemaPayload survives JSON.parse(JSON.stringify(p)) deep-equal to itself', () => {
      const schema = computeEffectiveSchema({ enabledDomains: ['work'], userAttributes: [] });
      const payload = toEffectiveSchemaPayload(schema);
      const roundTripped = JSON.parse(JSON.stringify(payload));
      expect(roundTripped).toEqual(payload);
    });

    it('uses the default registry (ONTOLOGY) when none is given', () => {
      const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
      expect(schema.version).toBe(ONTOLOGY.version);
    });
  });
});
