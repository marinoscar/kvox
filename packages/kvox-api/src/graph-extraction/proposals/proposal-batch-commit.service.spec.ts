import { NotFoundException } from '@nestjs/common';

import { ProposalBatchCommitService, rewriteEndpoints } from './proposal-batch-commit.service.js';
import * as precheck from '../extraction/precheck.js';

const OWNER = 'o1';
const actor = { id: OWNER, permissions: ['graph:write'] };
const dto = { policy: 'safe' as const };

function row(id: string, over: Record<string, unknown> = {}) {
  return { id, kind: 'item', decision: 'pending', payload: { kind: 'commitment' }, editedPayload: null, resolution: null, mergeIntoId: null, flags: [], ...over };
}

function setup(opts: { proposals?: any[]; rows?: Record<string, any[]>; currentVersion?: number; commitFails?: string[] } = {}) {
  const proposals = opts.proposals ?? [{ id: 'p1', kind: 'extraction', status: 'draft', noteId: 'n1', noteVersion: 1 }];
  const rows = opts.rows ?? { p1: [row('a'), row('sens', { payload: { kind: 'person_fact', sensitivity: 'sensitive' } })] };
  const prisma: any = {
    kgProposal: {
      findFirst: jest.fn(async ({ where }: any) => proposals.find((p) => p.id === where.id) ?? null),
      findMany: jest.fn(async () => proposals),
      findUniqueOrThrow: jest.fn(async () => ({ ...proposals[0], stats: {}, userGuidance: null })),
      create: jest.fn(async () => ({ id: 'rem' })),
    },
    kgProposalItem: { findMany: jest.fn(async ({ where }: any) => rows[where.proposalId] ?? []) },
    note: { findUnique: jest.fn(async () => ({ currentVersion: opts.currentVersion ?? 1 })) },
    noteImportBatch: { findFirst: jest.fn(async () => ({ id: 'b1' })), findMany: jest.fn(async () => [{ id: 'b1' }]) },
    noteImportBatchItem: { findMany: jest.fn(async () => proposals.map((p) => ({ noteId: p.noteId, noteVersion: p.noteVersion }))) },
    noteLibrary: { findFirst: jest.fn(async () => null) },
  };
  const bulk = jest.fn(async (_u: any, _id: string, d: any) => ({ updated: d.itemIds.length, skipped: [], counts: {} }));
  const commit = jest.fn(async (_u: any, id: string) => {
    if (opts.commitFails?.includes(id)) throw new Error('boom');
    return {};
  });
  const svc = new ProposalBatchCommitService(
    prisma,
    { bulk } as never,
    { commit } as never,
    { get: async () => ({ review: { minConfidence: 0.7 } }) } as never,
    { effectiveSchemaFor: async () => ({ entityTypes: [], relationTypes: [] }) } as never,
    { require: jest.fn(async () => undefined) } as never,
    { record: jest.fn(async () => undefined) } as never,
  );
  return { svc, prisma, bulk, commit };
}

describe('ProposalBatchCommitService', () => {
  beforeEach(() => jest.spyOn(precheck, 'reviewOnlyTypes').mockReturnValue(new Set()));

  it('accepts only safe rows through ProposalsService.bulk, then commits through ProposalCommitService', async () => {
    const t = setup();
    jest.spyOn(t.svc as any, 'carryOver').mockResolvedValue('rem');
    const { results } = await t.svc.commitBatch(actor, { ...dto, proposalIds: ['p1'] });
    expect(t.bulk).toHaveBeenCalledWith(actor, 'p1', { itemIds: ['a'], decision: 'accept' });
    expect(t.commit).toHaveBeenCalledWith(actor, 'p1');
    expect(results).toEqual([{ proposalId: 'p1', status: 'committed', accepted: 1, waiting: 1, remainderProposalId: 'rem' }]);
  });

  it('never sends a sensitive person fact to bulk, even alone', async () => {
    const t = setup({ rows: { p1: [row('sens', { payload: { kind: 'person_fact', sensitivity: 'sensitive' } })] } });
    const { results } = await t.svc.commitBatch(actor, { ...dto, proposalIds: ['p1'] });
    expect(t.bulk).not.toHaveBeenCalled();
    expect(t.commit).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ status: 'skipped', reason: 'nothing_to_commit', waiting: 1 });
  });

  it('skips a stale proposal without touching it', async () => {
    const t = setup({ currentVersion: 2 });
    const { results } = await t.svc.commitBatch(actor, { ...dto, proposalIds: ['p1'] });
    expect(results[0]).toMatchObject({ status: 'skipped', reason: 'stale' });
    expect(t.bulk).not.toHaveBeenCalled();
    expect(t.commit).not.toHaveBeenCalled();
  });

  it('isolates a failing proposal from the others', async () => {
    const proposals = [
      { id: 'p1', kind: 'extraction', status: 'draft', noteId: 'n1', noteVersion: 1 },
      { id: 'p2', kind: 'extraction', status: 'draft', noteId: 'n2', noteVersion: 1 },
    ];
    const t = setup({ proposals, rows: { p1: [row('a')], p2: [row('b')] }, commitFails: ['p1'] });
    const { results } = await t.svc.commitBatch(actor, { ...dto, proposalIds: ['p1', 'p2'] });
    expect(results.map((r) => [r.proposalId, r.status])).toEqual([['p1', 'failed'], ['p2', 'committed']]);
  });

  it('answers 404 for a batch that is not the caller\'s', async () => {
    const t = setup();
    t.prisma.noteImportBatch.findFirst.mockResolvedValue(null);
    await expect(t.svc.commitBatch(actor, { ...dto, batchId: 'b9' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolves a batch to its note drafts', async () => {
    const t = setup();
    jest.spyOn(t.svc as any, 'carryOver').mockResolvedValue(null);
    const { results } = await t.svc.commitBatch(actor, { ...dto, batchId: 'b1' });
    expect(results.map((r) => r.proposalId)).toEqual(['p1']);
  });

  it('writes no graph row itself', () => {
    const src = require('node:fs').readFileSync(require.resolve('./proposal-batch-commit.service.ts'), 'utf8') as string;
    const code = src.replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/GraphWriteService|kgEntity\.|kgRelation\.|kgItem\./);
  });
});

describe('rewriteEndpoints', () => {
  it('turns refs of written entities into entity ids and leaves the rest', () => {
    const out = rewriteEndpoints('relation', { from: { ref: 'e1' }, to: { ref: 'e2' } }, new Map([['e1', 'ID1']]));
    expect(out).toEqual({ from: { entityId: 'ID1' }, to: { ref: 'e2' } });
  });
});
