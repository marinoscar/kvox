import { BadRequestException } from '@nestjs/common';

import { planRelationFolds, propsToFill, relationFoldIdentity, sameRelationFact, type FoldGroup } from './merge-fold';
import { chooseSurvivor, MergeService, type MergeReversal } from './merge.service';

// The SQL half of a merge — re-pointing, duplicate and self-loop collapse,
// distinct-pair rewriting and the exact reverse — is exercised against real
// Postgres in `test/graph/kg-resolution.db.spec.ts`. This file pins the pure
// rules, the guards that run before any SQL, and (#445) the relation fold's
// decisions end to end through a scripted transaction.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('chooseSurvivor (the curated-survivor rule)', () => {
  const req = { survivorId: B, mergedId: A };

  it('keeps the curated side in an automatic merge when exactly one side is curated', () => {
    expect(chooseSurvivor(req, { [A]: 'accepted', [B]: 'unreviewed' }, 'resolution_proposal')).toEqual({ survivorId: A, mergedId: B });
    expect(chooseSurvivor(req, { [A]: 'edited', [B]: 'unreviewed' }, 'resolution_proposal')).toEqual({ survivorId: A, mergedId: B });
  });

  it('keeps the requested survivor when both or neither side is curated', () => {
    expect(chooseSurvivor(req, { [A]: 'accepted', [B]: 'edited' }, 'resolution_proposal')).toEqual(req);
    expect(chooseSurvivor(req, { [A]: 'unreviewed', [B]: 'unreviewed' }, 'resolution_proposal')).toEqual(req);
    expect(chooseSurvivor(req, { [A]: 'unreviewed', [B]: 'accepted' }, 'resolution_proposal')).toEqual(req);
  });

  it('never overrides a manual merge — a person named the survivor', () => {
    expect(chooseSurvivor(req, { [A]: 'accepted', [B]: 'unreviewed' }, 'manual')).toEqual(req);
  });
});

describe('MergeService guards', () => {
  it('refuses to merge an entity into itself before touching the database', async () => {
    const prisma = { $transaction: jest.fn() };
    const service = new MergeService(prisma as never, {} as never, {} as never, {} as never, {} as never);
    await expect(
      service.merge({ ownerId: 'o', mergedId: A, survivorId: A.toUpperCase(), actorId: 'o', source: 'manual' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// =============================================================================
// #445 — a relation fold is the SAME FACT, identity props included
// =============================================================================

const S = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // survivor entity
const M = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // merged entity
const KEPT = '11111111-1111-4111-8111-111111111111'; // the survivor's own HAS_ROLE
const DUP = '22222222-2222-4222-8222-222222222222'; // the merged entity's HAS_ROLE, re-pointed

describe('relation fold rules (merge-fold.ts)', () => {
  const hasRole = relationFoldIdentity('HAS_ROLE');

  it('derives HAS_ROLE identity from the ontology and lets both declared props be filled', () => {
    expect(hasRole).toEqual({
      rule: { identityProps: ['title'], optionalIdentityProps: ['businessUnit'] },
      fillableKeys: ['businessUnit', 'title'],
    });
  });

  it('decides "same fact" by the shared identity rule', () => {
    expect(sameRelationFact({ title: 'VP' }, { title: 'SVP' }, hasRole)).toBe(false);
    expect(sameRelationFact({ title: 'VP' }, { title: 'vp' }, hasRole)).toBe(true);
    expect(sameRelationFact({ title: 'VP', businessUnit: 'Consulting' }, { title: 'VP' }, hasRole)).toBe(true);
  });

  it('folds an unknown relation type only on identical props', () => {
    const unknown = relationFoldIdentity('NOT_A_TYPE');
    expect(unknown).toEqual({ rule: null, fillableKeys: [] });
    expect(sameRelationFact({ a: 'x' }, { a: 'X ' }, unknown)).toBe(true);
    expect(sameRelationFact({ a: 'x' }, {}, unknown)).toBe(false);
  });

  it('fills only what the kept row lacks, never overwriting', () => {
    expect(propsToFill({ title: 'VP', businessUnit: 'Consulting' }, { title: 'vp' }, hasRole.fillableKeys)).toEqual({ businessUnit: 'Consulting' });
    expect(propsToFill({ title: 'VP', businessUnit: 'Consulting' }, { title: 'VP', businessUnit: 'Sales' }, hasRole.fillableKeys)).toEqual({});
    expect(propsToFill({ title: 'VP', stray: 1 }, { title: 'VP' }, hasRole.fillableKeys)).toEqual({});
  });

  it('never picks a row already folded away, and compares against props filled earlier', () => {
    const X = '33333333-3333-4333-8333-333333333333';
    const groups: FoldGroup[] = [
      // DUP folds into KEPT first, giving KEPT businessUnit Consulting …
      { relation: { id: DUP, type: 'HAS_ROLE', props: { title: 'VP', businessUnit: 'Consulting' }, status: 'accepted' }, candidates: [{ id: KEPT, props: { title: 'VP' } }] },
      // … so X ({VP, Sales}) is no longer the same fact as KEPT, and DUP is retired.
      { relation: { id: X, type: 'HAS_ROLE', props: { title: 'VP', businessUnit: 'Sales' }, status: 'edited' }, candidates: [{ id: DUP, props: {} }, { id: KEPT, props: { title: 'VP' } }] },
    ];
    expect(planRelationFolds(groups)).toEqual([{ relationId: DUP, keptId: KEPT, previousStatus: 'accepted', filledProps: { businessUnit: 'Consulting' } }]);
  });
});

/**
 * A scripted transaction for one manual merge of M into S where only DUP was
 * re-pointed and KEPT is its one same-type/endpoints/`valid` candidate — just
 * enough SQL routing to run `merge` and `reverse` through the real service.
 */
function scriptedMerge(dupProps: Record<string, unknown>, keptProps: Record<string, unknown>) {
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  let reversal: MergeReversal | null = null;
  let keptNow: Record<string, unknown> = { ...keptProps };
  let mergedState = { review_status: 'accepted', merged_into_id: null as string | null };
  const sqlOf = (strings: TemplateStringsArray) => strings.join('?').replace(/\s+/g, ' ');

  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = sqlOf(strings);
      if (sql.includes('FROM kg_entities')) {
        return [
          { id: M, type: 'Person', label: 'J. Doe', props: {}, ...mergedState },
          { id: S, type: 'Person', label: 'Joe Doe', props: {}, review_status: 'accepted', merged_into_id: null },
        ];
      }
      if (sql.includes('UPDATE kg_relations SET from_id')) return [{ id: DUP }];
      if (sql.includes('JOIN kg_relations k')) {
        return [{ id: DUP, type: 'HAS_ROLE', props: dupProps, status: 'accepted', kept_id: KEPT, kept_props: keptNow }];
      }
      if (sql.includes('UPDATE kg_evidence SET subject_id') && sql.includes("subject_kind = 'relation'")) return [{ id: 'ev-dup' }];
      if (sql.includes('FROM kg_merges')) {
        return [{ id: 'merge-1', survivor_id: S, merged_id: M, reversal, reversed_at: null }];
      }
      if (sql.includes('SELECT props FROM kg_relations')) return [{ props: keptNow }];
      if (sql.includes('UPDATE kg_merges')) return [{ reversed_at: new Date('2026-09-29T00:00:00Z') }];
      return [];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = sqlOf(strings);
      executed.push({ sql, values });
      if (sql.includes('SET props = props ||')) keptNow = { ...keptNow, ...(JSON.parse(values[0] as string) as Record<string, unknown>) };
      if (sql.includes('SET props = props -')) {
        const next = { ...keptNow };
        for (const k of values[0] as string[]) delete next[k];
        keptNow = next;
      }
      if (sql.includes("UPDATE kg_entities SET review_status = 'merged'")) mergedState = { review_status: 'merged', merged_into_id: S };
      return 1;
    }),
    kgDistinctPair: { findMany: jest.fn(async () => []) },
    kgMerge: {
      create: jest.fn(async ({ data }: { data: { reversal: MergeReversal } }) => {
        reversal = data.reversal;
        return { id: 'merge-1', createdAt: new Date('2026-09-29T00:00:00Z') };
      }),
    },
    kgEntityAlias: { count: jest.fn(async () => 0), deleteMany: jest.fn() },
    kgEvidence: { count: jest.fn(async () => 1) },
  };
  const write = { addAliases: jest.fn(async () => []) };
  const service = new MergeService({} as never, write as never, {} as never, {} as never, {} as never);
  return {
    service,
    tx,
    executed,
    reversal: () => reversal!,
    keptProps: () => keptNow,
    setKeptProps: (p: Record<string, unknown>) => {
      keptNow = p;
    },
    folded: () => executed.some((e) => e.sql.includes("SET review_status = 'merged'") && e.values.includes(DUP)),
  };
}

describe('MergeService relation fold (#445)', () => {
  const input = { ownerId: 'o', mergedId: M, survivorId: S, actorId: 'o', source: 'manual' as const };

  it('keeps both HAS_ROLE {VP} and {SVP} over the same period — two roles, not one', async () => {
    const run = scriptedMerge({ title: 'SVP' }, { title: 'VP' });
    await run.service.merge(input, run.tx as never);
    expect(run.folded()).toBe(false);
    expect(run.reversal().collapsed).toEqual([]);
    expect(run.keptProps()).toEqual({ title: 'VP' });
  });

  it('folds {VP} into {VP}, moving the evidence and copying nothing', async () => {
    const run = scriptedMerge({ title: 'VP' }, { title: 'vp' });
    await run.service.merge(input, run.tx as never);
    expect(run.folded()).toBe(true);
    expect(run.reversal().collapsed).toEqual([{ relationId: DUP, keptId: KEPT, movedEvidence: ['ev-dup'], previousStatus: 'accepted' }]);
    expect(run.executed.some((e) => e.sql.includes('props ||'))).toBe(false);
  });

  it('folds {VP, Consulting} into {VP}; the survivor gains Consulting, and a reverse takes it back off', async () => {
    const run = scriptedMerge({ title: 'VP', businessUnit: 'Consulting' }, { title: 'VP' });
    await run.service.merge(input, run.tx as never);
    expect(run.folded()).toBe(true);
    expect(run.keptProps()).toEqual({ title: 'VP', businessUnit: 'Consulting' });
    expect(run.reversal().collapsed).toEqual([
      { relationId: DUP, keptId: KEPT, movedEvidence: ['ev-dup'], previousStatus: 'accepted', filledProps: { businessUnit: 'Consulting' } },
    ]);

    const reversed = await run.service.reverse({ ownerId: 'o', mergeId: 'merge-1', actorId: 'o' }, run.tx as never);
    expect(reversed.skipped).toEqual([]);
    expect(run.keptProps()).toEqual({ title: 'VP' });
    // The folded duplicate is restored to its own status, evidence given back.
    expect(run.executed.some((e) => e.sql.includes('SET review_status = ?::kg_review_status') && e.values.includes(DUP))).toBe(true);
  });

  it('leaves a filled prop edited since in place and reports it changed_since', async () => {
    const run = scriptedMerge({ title: 'VP', businessUnit: 'Consulting' }, { title: 'VP' });
    await run.service.merge(input, run.tx as never);
    run.setKeptProps({ title: 'VP', businessUnit: 'Strategy' });

    const reversed = await run.service.reverse({ ownerId: 'o', mergeId: 'merge-1', actorId: 'o' }, run.tx as never);
    expect(reversed.skipped).toEqual([{ kind: 'relation', id: KEPT, why: 'changed_since' }]);
    expect(run.keptProps()).toEqual({ title: 'VP', businessUnit: 'Strategy' });
  });
});
