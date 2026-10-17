import { buildExtractionContext, buildExtractionOutputSchema, assembleExtractionPrompt } from '../graph/package-internals';
import { applyPrecheck, reviewOnlyTypes, type PrecheckItem } from '@marinoscar/kvox-api/graph-extraction';
import { GRAPH_PREFERENCE_DEFAULTS } from '@marinoscar/kvox-api/graph';
import { makeInput, schemaFor } from '../graph/extraction-fixtures';

// =============================================================================
// The `personal` ontology domain, as `kg.extract` sees it (issue #383, epic #349).
//
// The registry and effective-schema halves of this suite moved with the
// ontology to `packages/kvox-contract/test/ontology/personal-domain.test.ts`
// (issue #488). What stays here needs the API's extraction prompt, output
// schema and pre-check.
// =============================================================================

const PERSONAL_TYPES = ['Interest', 'Trip', 'Milestone'];
const PERSONAL_RELATIONS = ['SPOUSE_OF', 'PARENT_OF', 'FRIEND_OF', 'INTERESTED_IN', 'TRAVELED_ON', 'HAS_MILESTONE'];

describe('the personal domain in the extraction pipeline (#383)', () => {
  describe('effective schema — disabled (the default)', () => {
    it('offers no personal type to extraction, and the prompt names none', () => {
      const ctx = buildExtractionContext(makeInput({ effectiveSchema: schemaFor(['core', 'work']) }));
      const { systemPrompt } = assembleExtractionPrompt(ctx);
      for (const key of [...PERSONAL_TYPES, ...PERSONAL_RELATIONS]) expect(systemPrompt).not.toContain(key);
      expect(JSON.stringify(buildExtractionOutputSchema(ctx))).not.toContain('SPOUSE_OF');
    });
  });

  describe('effective schema — enabled', () => {
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
});
