// =============================================================================
// The Ask turn `scope` (GIC-17, #678): owner isolation, 404 for any unreadable id, and the
// sensitivity filter. The rows are in memory; the matcher honours the `where` operators the
// resolver uses (`in`, `notIn`, equality), so a filter dropped from the query fails here.
// =============================================================================

import { NotFoundException } from '@nestjs/common';

import { ASK_SCOPE_NOT_FOUND, assertAskScopeReadable, resolveAskScope } from './ask-scope.js';
import type { KvoxAskDb } from './data/ask-db.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      const op = condition as { in?: unknown[]; notIn?: unknown[] };
      if (op.in) return op.in.includes(value);
      if (op.notIn) return !op.notIn.includes(value);
    }
    return value === condition;
  });
}

function table(rows: Row[]) {
  return { findMany: async ({ where }: { where: Row }) => rows.filter((row) => matches(row, where)) };
}

function db(): KvoxAskDb {
  const entities: Row[] = [
    { id: id(1), ownerId: OWNER, label: 'Joe', type: 'Person', mergedIntoId: null, reviewStatus: 'accepted' },
    { id: id(2), ownerId: OWNER, label: 'Copilot rollout', type: 'Project', mergedIntoId: null, reviewStatus: 'accepted' },
    { id: id(3), ownerId: STRANGER, label: 'Not mine', type: 'Person', mergedIntoId: null, reviewStatus: 'accepted' },
    { id: id(4), ownerId: OWNER, label: 'Merged', type: 'Person', mergedIntoId: id(1), reviewStatus: 'accepted' },
    { id: id(5), ownerId: OWNER, label: 'A trip', type: 'Trip', mergedIntoId: null, reviewStatus: 'accepted' },
  ];
  const items: Row[] = [
    { id: id(20), ownerId: OWNER, kind: 'commitment', sensitivity: null, reviewStatus: 'accepted' },
    { id: id(21), ownerId: OWNER, kind: 'person_fact', sensitivity: 'sensitive', reviewStatus: 'accepted' },
  ];
  const relations: Row[] = [
    { id: id(30), ownerId: OWNER, type: 'INVOLVED_IN', reviewStatus: 'accepted' },
    { id: id(31), ownerId: STRANGER, type: 'INVOLVED_IN', reviewStatus: 'accepted' },
  ];
  const evidence: Row[] = [
    { id: id(40), ownerId: OWNER, subjectKind: 'relation', subjectId: id(30) },
    { id: id(41), ownerId: OWNER, subjectKind: 'item', subjectId: id(21) },
    { id: id(42), ownerId: STRANGER, subjectKind: 'relation', subjectId: id(31) },
    { id: id(43), ownerId: OWNER, subjectKind: 'item', subjectId: id(20) },
    { id: id(44), ownerId: OWNER, subjectKind: 'entity', subjectId: id(1) },
  ];
  return {
    kgEntity: table(entities),
    kgItem: table(items),
    kgRelation: table(relations),
    kgEvidence: table(evidence),
  } as unknown as KvoxAskDb;
}

describe('resolveAskScope (GIC-17)', () => {
  it('resolves entities, and the subject each evidence id supports, once each', async () => {
    const resolved = await resolveAskScope(db(), OWNER, {
      entityIds: [id(1), id(2), id(1)],
      evidenceIds: [id(40), id(43), id(44)],
    });
    expect(resolved.missing).toBe(false);
    expect(resolved.subjects.map((s) => `${s.kind}:${s.label}`)).toEqual([
      'ent:Joe',
      'ent:Copilot rollout',
      'itm:commitment',
      'rel:INVOLVED_IN',
    ]);
  });

  it('is missing for another owner’s entity and evidence, and for a merged entity', async () => {
    expect((await resolveAskScope(db(), OWNER, { entityIds: [id(3)] })).missing).toBe(true);
    expect((await resolveAskScope(db(), OWNER, { entityIds: [id(4)] })).missing).toBe(true);
    expect((await resolveAskScope(db(), OWNER, { evidenceIds: [id(42)] })).missing).toBe(true);
    expect((await resolveAskScope(db(), OWNER, { entityIds: [id(99)] })).missing).toBe(true);
  });

  it('never resolves a sensitive PersonFact’s evidence, nor a personal-by-declaration type', async () => {
    const sensitive = await resolveAskScope(db(), OWNER, { evidenceIds: [id(41)] });
    expect(sensitive.missing).toBe(true);
    expect(sensitive.subjects).toEqual([]);
    expect((await resolveAskScope(db(), OWNER, { entityIds: [id(5)] })).missing).toBe(true);
  });
});

describe('assertAskScopeReadable (GIC-17)', () => {
  it('answers one 404 sentence whatever the reason', async () => {
    for (const scope of [
      { entityIds: [id(3)] },
      { entityIds: [id(99)] },
      { evidenceIds: [id(41)] },
      { evidenceIds: [id(42)] },
      { entityIds: [id(1)], evidenceIds: [id(42)] },
    ]) {
      const error = await assertAskScopeReadable(db(), OWNER, scope).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(ASK_SCOPE_NOT_FOUND);
    }
  });

  it('passes a scope the owner can read', async () => {
    await expect(
      assertAskScopeReadable(db(), OWNER, { entityIds: [id(1)], evidenceIds: [id(40), id(44)] }),
    ).resolves.toBeUndefined();
  });
});
