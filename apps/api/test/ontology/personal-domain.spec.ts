import { readFileSync } from 'fs';
import { join } from 'path';

import {
  CHANGELOG,
  DEFAULT_ENABLED_DOMAINS,
  ONTOLOGY,
  ONTOLOGY_VERSION,
  OntologyDefinitionError,
  SHIPPED_KEYS,
  computeEffectiveSchema,
  defineRelationType,
  toEffectiveSchemaPayload,
} from '@app/shared/ontology';
import type { RelationTypeSpec } from '@app/shared/ontology';

import { buildExtractionContext } from '../../src/graph/extraction/extraction-context';
import { buildExtractionOutputSchema } from '../../src/graph/extraction/output-schema';
import { applyPrecheck, reviewOnlyTypes, type PrecheckItem } from '../../src/graph/extraction/precheck';
import { assembleExtractionPrompt } from '../../src/graph/extraction/prompt';
import { GRAPH_PREFERENCE_DEFAULTS } from '../../src/graph/preferences/graph-preferences.defaults';
import { makeInput, schemaFor } from '../graph/extraction-fixtures';

// =============================================================================
// The `personal` ontology domain (issue #383, epic #349; docs/specs/ontology.md
// §5.6, §15, §16 P6, §17.2).
//
// The two P6 acceptance halves, asserted:
//   - a user who never enables `personal` sees NO change anywhere — the
//     effective-schema payload is byte-identical to 1.0.0's except `version`
//     and the disabled `personal` domain entry (pinned against a committed
//     copy of the 1.0.0 payload, not against itself);
//   - a user who enables it gets its 3 types and 6 relations, all `personal`
//     sensitivity, in the payload and in the next extraction prompt, and their
//     rows are never pre-checked.
// =============================================================================

const PERSONAL_TYPES = ['Interest', 'Trip', 'Milestone'];
const PERSONAL_RELATIONS = ['SPOUSE_OF', 'PARENT_OF', 'FRIEND_OF', 'INTERESTED_IN', 'TRAVELED_ON', 'HAS_MILESTONE'];

const PAYLOAD_1_0_0 = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'effective-schema-1.0.0-default.json'), 'utf8'),
) as ReturnType<typeof toEffectiveSchemaPayload>;

const payloadFor = (enabledDomains: Parameters<typeof computeEffectiveSchema>[0]['enabledDomains']) =>
  toEffectiveSchemaPayload(computeEffectiveSchema({ enabledDomains, userAttributes: [] }));

describe('the personal domain (#383)', () => {
  describe('registry', () => {
    const personal = ONTOLOGY.domains().find((d) => d.key === 'personal');

    it('registers the personal module, off by default and never always-on', () => {
      expect(ONTOLOGY.domains().map((d) => d.key)).toEqual(['core', 'work', 'personal']);
      expect(personal).toEqual(
        expect.objectContaining({ key: 'personal', label: 'Personal life', alwaysOn: false, defaultEnabled: false, mixins: [] }),
      );
      expect(DEFAULT_ENABLED_DOMAINS).not.toContain('personal');
    });

    it('declares exactly Interest, Trip, Milestone and the six relations', () => {
      expect(personal!.entityTypes.map((t) => t.key)).toEqual(PERSONAL_TYPES);
      expect(personal!.relationTypes.map((r) => r.key)).toEqual(PERSONAL_RELATIONS);
    });

    it('gives every type and relation personal sensitivity (§17.2 → §15)', () => {
      for (const t of personal!.entityTypes) expect({ key: t.key, s: t.sensitivityDefault }).toEqual({ key: t.key, s: 'personal' });
      for (const r of personal!.relationTypes) expect({ key: r.key, s: r.sensitivityDefault }).toEqual({ key: r.key, s: 'personal' });
    });

    it('keeps Person in core: every personal relation starts at a core Person', () => {
      expect(ONTOLOGY.entityType('Person')?.domain).toBe('core');
      for (const r of personal!.relationTypes) expect(r.from).toEqual(['Person']);
    });

    it('declares the §17.2 attribute set and alignments', () => {
      expect(Object.keys(ONTOLOGY.entityType('Interest')!.attributes)).toEqual(['category']);
      expect(Object.keys(ONTOLOGY.entityType('Trip')!.attributes)).toEqual(['destination', 'startDate', 'endDate']);
      expect(Object.keys(ONTOLOGY.entityType('Milestone')!.attributes)).toEqual(['date', 'kind']);
      expect(ONTOLOGY.entityType('Interest')!.attributes.category.options?.choices?.map((c) => c.value)).toEqual([
        'hobby', 'sport', 'music', 'food', 'travel', 'cause', 'other',
      ]);
      expect(ONTOLOGY.entityType('Milestone')!.attributes.kind.options?.choices?.map((c) => c.value)).toEqual([
        'birthday', 'anniversary', 'wedding', 'birth', 'graduation', 'move', 'retirement', 'other',
      ]);
      for (const t of PERSONAL_TYPES) {
        for (const [key, a] of Object.entries(ONTOLOGY.entityType(t)!.attributes)) {
          expect({ attr: `${t}.${key}`, extractable: a.extractable }).toEqual({ attr: `${t}.${key}`, extractable: true });
        }
      }
      expect(Object.fromEntries(PERSONAL_TYPES.map((t) => [t, ONTOLOGY.entityType(t)!.alignment]))).toEqual({
        Interest: 'schema:Thing',
        Trip: 'schema:Trip',
        Milestone: 'schema:Event',
      });
      expect(Object.fromEntries(PERSONAL_RELATIONS.map((r) => [r, ONTOLOGY.relationType(r)!.alignment ?? null]))).toEqual({
        SPOUSE_OF: 'schema:spouse',
        PARENT_OF: 'schema:children',
        FRIEND_OF: 'foaf:knows',
        INTERESTED_IN: 'foaf:topic_interest',
        TRAVELED_ON: null,
        HAS_MILESTONE: null,
      });
    });

    it('declares the temporal/exclusive/symmetric table exactly', () => {
      const table = Object.fromEntries(
        PERSONAL_RELATIONS.map((key) => {
          const r = ONTOLOGY.relationType(key)!;
          return [key, [r.from[0], r.to[0], r.temporal, r.exclusive, r.exclusiveScope ?? 'from', r.representation.kind, r.symmetric === true]];
        }),
      );
      expect(table).toEqual({
        SPOUSE_OF: ['Person', 'Person', true, 'soft', 'from', 'edge', true],
        PARENT_OF: ['Person', 'Person', false, 'none', 'from', 'edge', false],
        FRIEND_OF: ['Person', 'Person', true, 'none', 'from', 'edge', true],
        INTERESTED_IN: ['Person', 'Interest', false, 'none', 'from', 'edge', false],
        TRAVELED_ON: ['Person', 'Trip', false, 'none', 'from', 'edge', false],
        HAS_MILESTONE: ['Person', 'Milestone', false, 'none', 'from', 'edge', false],
      });
    });

    it('is a minor bump with a CHANGELOG entry and every new key shipped', () => {
      // 1.1.0 introduced it; later bumps (1.2.0, #440) must not have removed its entry.
      const entry = CHANGELOG.find((e) => e.version === '1.1.0');
      expect(entry?.changes.join(' ')).toMatch(/personal domain/);
      expect(ONTOLOGY_VERSION.localeCompare('1.1.0', undefined, { numeric: true })).toBeGreaterThanOrEqual(0);
      for (const key of [...PERSONAL_TYPES, ...PERSONAL_RELATIONS, 'Interest.category', 'Trip.destination', 'Milestone.kind']) {
        expect(SHIPPED_KEYS).toContain(key);
      }
    });
  });

  describe('effective schema — disabled (the default)', () => {
    it('is byte-identical to the 1.0.0 payload except version and the disabled personal domain entry', () => {
      const now = payloadFor(['core', 'work']);
      expect(now.version).toBe(ONTOLOGY_VERSION);
      expect(now.domains).toEqual([...PAYLOAD_1_0_0.domains, { key: 'personal', label: 'Personal life', enabled: false, alwaysOn: false }]);

      // 1.2.0 (#440) changed Person's work mixin — company/businessUnit added,
      // title relabelled "Role" — and nothing else. Undo exactly that change on
      // the current payload, then require byte identity with the committed
      // 1.0.0 copy, so any OTHER drift still fails here.
      const person100 = PAYLOAD_1_0_0.entityTypes.find((t) => t.key === 'Person')!;
      const personNow = now.entityTypes.find((t) => t.key === 'Person')!;
      expect(personNow.attributes.map((a) => a.key)).toEqual(['company', 'businessUnit', 'title']);
      const titleNow = personNow.attributes.find((a) => a.key === 'title')!;
      const title100 = person100.attributes.find((a) => a.key === 'title')!;
      expect({ ...titleNow, label: title100.label, description: title100.description, sortOrder: title100.sortOrder }).toEqual(title100);
      const entityTypes = now.entityTypes.map((t) => (t.key === 'Person' ? { ...t, attributes: person100.attributes } : t));

      const comparable = {
        ...now,
        version: PAYLOAD_1_0_0.version,
        domains: now.domains.filter((d) => d.key !== 'personal'),
        entityTypes,
      };
      expect(JSON.stringify(comparable)).toBe(JSON.stringify(PAYLOAD_1_0_0));
    });

    it('never names a personal type anywhere — not even as a pruned endpoint or subject type', () => {
      const text = JSON.stringify(payloadFor(['core', 'work']).entityTypes) + JSON.stringify(payloadFor(['core', 'work']).relationTypes);
      for (const key of [...PERSONAL_TYPES, ...PERSONAL_RELATIONS]) expect(text).not.toContain(`"${key}"`);
    });

    it('offers no personal type to extraction, and the prompt names none', () => {
      const ctx = buildExtractionContext(makeInput({ effectiveSchema: schemaFor(['core', 'work']) }));
      const { systemPrompt } = assembleExtractionPrompt(ctx);
      for (const key of [...PERSONAL_TYPES, ...PERSONAL_RELATIONS]) expect(systemPrompt).not.toContain(key);
      expect(JSON.stringify(buildExtractionOutputSchema(ctx))).not.toContain('SPOUSE_OF');
    });
  });

  describe('effective schema — enabled', () => {
    const payload = payloadFor(['core', 'work', 'personal']);

    it('publishes the 3 types and 6 relations with personal sensitivity', () => {
      expect(payload.domains.find((d) => d.key === 'personal')).toEqual({
        key: 'personal',
        label: 'Personal life',
        enabled: true,
        alwaysOn: false,
      });
      const types = payload.entityTypes.filter((t) => t.domain === 'personal');
      expect(types.map((t) => [t.key, t.storage, t.sensitivityDefault])).toEqual([
        ['Interest', 'entity', 'personal'],
        ['Trip', 'entity', 'personal'],
        ['Milestone', 'entity', 'personal'],
      ]);
      for (const t of types) for (const a of t.attributes) expect(a.sensitivity).toBe('personal');
      const relations = payload.relationTypes.filter((r) => r.domain === 'personal');
      expect(relations.map((r) => [r.key, r.sensitivityDefault, r.symmetric ?? false])).toEqual([
        ['SPOUSE_OF', 'personal', true],
        ['PARENT_OF', 'personal', false],
        ['FRIEND_OF', 'personal', true],
        ['INTERESTED_IN', 'personal', false],
        ['TRAVELED_ON', 'personal', false],
        ['HAS_MILESTONE', 'personal', false],
      ]);
    });

    it('omits symmetric on directed relations and sensitivityDefault on core/work relations', () => {
      expect('symmetric' in payload.relationTypes.find((r) => r.key === 'PARENT_OF')!).toBe(false);
      for (const r of payload.relationTypes.filter((x) => x.domain !== 'personal')) {
        expect({ key: r.key, sym: 'symmetric' in r, sens: 'sensitivityDefault' in r }).toEqual({ key: r.key, sym: false, sens: false });
      }
    });

    it('lets core relations and Claim reach the personal entity types (no orphan personal node)', () => {
      expect(payload.relationTypes.find((r) => r.key === 'MENTIONS')!.to).toEqual(expect.arrayContaining(PERSONAL_TYPES));
      expect(payload.entityTypes.find((t) => t.key === 'Claim')!.subjectTypes).toEqual(expect.arrayContaining(PERSONAL_TYPES));
    });

    it('offers them to kg.extract: the prompt and the output schema include every one', () => {
      const ctx = buildExtractionContext(makeInput({ effectiveSchema: schemaFor(['core', 'work', 'personal']) }));
      expect(ctx.offered.entityTypes.map((t) => t.key)).toEqual(expect.arrayContaining(PERSONAL_TYPES));
      expect(ctx.offered.relationTypes.map((r) => r.type.key)).toEqual(expect.arrayContaining(PERSONAL_RELATIONS));
      const { systemPrompt } = assembleExtractionPrompt(ctx);
      for (const key of [...PERSONAL_TYPES, ...PERSONAL_RELATIONS]) expect(systemPrompt).toContain(key);
      expect(systemPrompt).toContain('A lasting personal interest, never a one-off activity mentioned once');
      const output = JSON.stringify(buildExtractionOutputSchema(ctx));
      for (const key of [...PERSONAL_TYPES, ...PERSONAL_RELATIONS]) expect(output).toContain(key);
    });

    it('tells the model direction does not matter only for a symmetric relation', () => {
      const ctx = buildExtractionContext(makeInput({ effectiveSchema: schemaFor(['core', 'work', 'personal']) }));
      const lines = assembleExtractionPrompt(ctx).systemPrompt.split('\n');
      const line = (key: string) => lines.find((l) => l.startsWith(`- ${key}:`)) ?? '';
      expect(line('SPOUSE_OF')).toContain('direction does not matter');
      expect(line('FRIEND_OF')).toContain('direction does not matter');
      expect(line('PARENT_OF')).not.toContain('direction does not matter');
      expect(line('WORKS_FOR')).not.toContain('direction does not matter');
    });

    it('works with work disabled: personal types stand on core alone', () => {
      const p = payloadFor(['core', 'personal']);
      expect(p.entityTypes.map((t) => t.key)).toEqual(expect.arrayContaining(PERSONAL_TYPES));
      expect(p.entityTypes.map((t) => t.key)).not.toContain('Project');
      expect(p.relationTypes.map((r) => r.key)).toEqual(expect.arrayContaining(PERSONAL_RELATIONS));
    });
  });

  describe('pre-check (§15: personal rows are never pre-checked)', () => {
    const EXISTING = '0f000000-0000-4000-8000-000000000001';
    const newEntity = (ref: string, type: string): PrecheckItem => ({
      kind: 'entity',
      payload: { ref, type, label: ref },
      resolution: { ref: null, score: null, source: null, candidates: [], adjudication: null },
      flags: [],
      decision: 'pending',
    });
    const relation = (type: string, flags: string[] = []): PrecheckItem => ({
      kind: 'relation',
      payload: { ref: 'r', type, from: { entityId: EXISTING }, to: { entityId: EXISTING } },
      resolution: null,
      flags,
      decision: 'pending',
    });

    it('derives the review-only set from the effective schema', () => {
      expect([...reviewOnlyTypes(schemaFor(['core', 'work', 'personal']))].sort()).toEqual(
        [...PERSONAL_TYPES, ...PERSONAL_RELATIONS].sort(),
      );
      expect([...reviewOnlyTypes(schemaFor(['core', 'work']))]).toEqual([]);
    });

    it('leaves a new personal entity and a personal relation pending, while their work equivalents are ticked', () => {
      const items = [
        newEntity('p', 'Person'),
        newEntity('i', 'Interest'),
        newEntity('t', 'Trip'),
        newEntity('m', 'Milestone'),
        relation('WORKS_FOR'),
        relation('SPOUSE_OF'),
        relation('PARENT_OF'),
      ];
      applyPrecheck(items, GRAPH_PREFERENCE_DEFAULTS, { reviewOnlyTypes: reviewOnlyTypes(schemaFor(['core', 'work', 'personal'])) });
      expect(items.map((i) => i.decision)).toEqual(['accept', 'pending', 'pending', 'pending', 'accept', 'pending', 'pending']);
    });

    it('still accepts a known personal relation (a citation on an edge already accepted), like a known personal PersonFact', () => {
      const items = [relation('SPOUSE_OF', ['known'])];
      applyPrecheck(items, GRAPH_PREFERENCE_DEFAULTS, { reviewOnlyTypes: reviewOnlyTypes(schemaFor(['core', 'work', 'personal'])) });
      expect(items[0].decision).toBe('accept');
    });
  });

  describe('symmetric validation', () => {
    const base: RelationTypeSpec = {
      key: 'TEST_REL',
      domain: 'personal',
      label: 'Test',
      description: 'A relation declared only by this test.',
      from: ['Person'],
      to: ['Person'],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'edge' },
      extractable: true,
    };

    it('accepts a symmetric relation with the same single type on both sides', () => {
      expect(defineRelationType({ ...base, symmetric: true }).symmetric).toBe(true);
    });

    it.each<[string, Partial<RelationTypeSpec>]>([
      ['different endpoint types', { symmetric: true, to: ['Organization'] }],
      ['more than one endpoint type', { symmetric: true, from: ['Person', 'Organization'], to: ['Person', 'Organization'] }],
      ['an allowedPairs list', { symmetric: true, allowedPairs: [['Person', 'Person']] }],
      ['a non-edge representation', { symmetric: true, extractable: false, representation: { kind: 'mention' } }],
      ['a non-boolean value', { symmetric: 'yes' as unknown as boolean }],
      ['an unknown sensitivityDefault', { sensitivityDefault: 'secret' as unknown as 'personal' }],
    ])('refuses %s', (_label, override) => {
      expect(() => defineRelationType({ ...base, ...override })).toThrow(OntologyDefinitionError);
    });
  });
});
