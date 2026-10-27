import { KG_AUTOCOMMIT_JOB_TYPE } from '../../graph/index.js';
import * as precheck from '../extraction/precheck.js';
import { ProposalBatchCommitService } from '../proposals/proposal-batch-commit.service.js';
import { jobsMock } from '../__fixtures__/jobs-mock.js';
import { GRAPH_AUTOCOMMIT_ACTION, KgAutocommitHandler } from './kg-autocommit.handler.js';

const P = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const job = (payload: unknown = { proposalId: P, ownerId: OWNER }) => ({ id: 'j1', type: KG_AUTOCOMMIT_JOB_TYPE, payload }) as never;

function harness(over: {
  proposal?: Record<string, unknown> | null;
  policy?: { libraryId: string; autoExtract: boolean; autoCommit: boolean | null } | null;
  autoCommitSafeRows?: boolean;
  graphEnabled?: boolean;
  writer?: boolean;
  noteVersion?: number;
} = {}) {
  const proposal = over.proposal === undefined ? { id: P, status: 'draft', kind: 'extraction', noteId: 'n1', noteVersion: 2 } : over.proposal;
  const prisma = {
    kgProposal: { findFirst: jest.fn(async () => proposal) },
    note: { findUnique: jest.fn(async () => ({ currentVersion: over.noteVersion ?? 2 })) },
  };
  const commitSafe = jest.fn(async () => ({ proposalId: P, status: 'committed' as const, accepted: 3, waiting: 1, remainderProposalId: null }));
  const audit = { record: jest.fn(async () => undefined) };
  const identity = { hasPermission: jest.fn(async () => over.writer ?? true) };
  const resolver = { graphEnabled: jest.fn(async () => over.graphEnabled ?? true) };
  const policy = { forNote: jest.fn(async () => (over.policy === undefined ? { libraryId: 'l1', autoExtract: true, autoCommit: true } : over.policy)) };
  const prefs = { get: jest.fn(async () => ({ review: { minConfidence: 0.7, autoCommitSafeRows: over.autoCommitSafeRows ?? true } })) };
  const jobs = jobsMock();
  const handler = new KgAutocommitHandler(jobs as never, prisma as never, identity as never, audit as never, resolver as never, policy as never, prefs as never, { commitSafe } as never);
  return { handler, commitSafe, audit, identity, prisma };
}

describe('KgAutocommitHandler (#718, ADR-0007)', () => {
  it('declares its profile, registers itself and is server-only', () => {
    const { handler } = harness();
    const jobs = jobsMock();
    expect(handler.type).toBe('kg.autocommit');
    expect(handler.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 2 });
    expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>).persistNodeResult).toBeUndefined();
    new KgAutocommitHandler(jobs as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never).onModuleInit();
    expect(jobs.registerHandler).toHaveBeenCalled();
  });

  it('commits the safe rows with an actor built from the owner, then audits ids and counts only', async () => {
    const h = harness();
    await h.handler.process(job());
    expect(h.commitSafe).toHaveBeenCalledWith({ id: OWNER, permissions: ['graph:write'] }, P, {});
    expect(h.identity.hasPermission).toHaveBeenCalledWith(OWNER, 'graph:write');
    expect(h.audit.record).toHaveBeenCalledWith({
      actorUserId: OWNER,
      action: GRAPH_AUTOCOMMIT_ACTION,
      targetType: 'kg_proposal',
      targetId: P,
      meta: { noteId: 'n1', libraryId: 'l1', source: 'library', status: 'committed', accepted: 3, waiting: 1 },
    });
  });

  const closed: Array<[string, Parameters<typeof harness>[0]]> = [
    ['the note has no library and the owner turned the preference off', { policy: null, autoCommitSafeRows: false }],
    ['the library has auto-commit explicitly off, whatever the preference', { policy: { libraryId: 'l1', autoExtract: true, autoCommit: false }, autoCommitSafeRows: true }],
    ['the library follows the preference and the owner turned it off', { policy: { libraryId: 'l1', autoExtract: true, autoCommit: null }, autoCommitSafeRows: false }],
    ['the owner lost graph:write', { writer: false }],
    ['the graph is disabled', { graphEnabled: false }],
    ['the proposal is stale', { noteVersion: 3 }],
    ['the proposal is not a draft', { proposal: { id: P, status: 'committed', kind: 'extraction', noteId: 'n1', noteVersion: 2 } }],
    ['the proposal is not an extraction', { proposal: { id: P, status: 'draft', kind: 'import', noteId: 'n1', noteVersion: 2 } }],
    ['the proposal is gone', { proposal: null }],
  ];
  it.each(closed)('commits nothing and does not throw when %s', async (_label, over) => {
    const h = harness(over);
    await expect(h.handler.process(job())).resolves.toBeUndefined();
    expect(h.commitSafe).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('commits a note outside any library when the preference is on (the default)', async () => {
    const h = harness({ policy: null });
    await h.handler.process(job());
    expect(h.commitSafe).toHaveBeenCalledWith({ id: OWNER, permissions: ['graph:write'] }, P, {});
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ libraryId: null, source: 'preference' }) }),
    );
  });

  it('a library that follows the preference commits when the preference is on', async () => {
    const h = harness({ policy: { libraryId: 'l1', autoExtract: true, autoCommit: null }, autoCommitSafeRows: true });
    await h.handler.process(job());
    expect(h.commitSafe).toHaveBeenCalledTimes(1);
  });

  it('a library that explicitly turned auto-commit on commits even when the preference is off', async () => {
    const h = harness({ policy: { libraryId: 'l1', autoExtract: true, autoCommit: true }, autoCommitSafeRows: false });
    await h.handler.process(job());
    expect(h.commitSafe).toHaveBeenCalledTimes(1);
  });

  it('an unreadable payload is a no-op', async () => {
    const h = harness();
    await expect(h.handler.process(job({ nope: 1 }))).resolves.toBeUndefined();
    expect(h.commitSafe).not.toHaveBeenCalled();
  });

  it('a note outside any library: confident rows commit by default, a sensitive PersonFact and a closing stay pending (real safe policy)', async () => {
    jest.spyOn(precheck, 'reviewOnlyTypes').mockReturnValue(new Set());
    const row = (id: string, payload: Record<string, unknown>) => ({
      id, kind: 'item', decision: 'pending', payload, editedPayload: null, resolution: null, mergeIntoId: null, flags: [],
    });
    const rows = [
      row('ok', { kind: 'commitment' }),
      row('sens', { kind: 'person_fact', sensitivity: 'sensitive' }),
      { ...row('close', {}), kind: 'closing' },
    ];
    const proposal = { id: P, ownerId: OWNER, status: 'draft', kind: 'extraction', noteId: 'n1', noteVersion: 2 };
    const prisma: any = {
      kgProposal: { findFirst: jest.fn(async () => proposal) },
      kgProposalItem: { findMany: jest.fn(async () => rows) },
      note: { findUnique: jest.fn(async () => ({ currentVersion: 2 })) },
    };
    const bulk = jest.fn(async (_a: unknown, _id: string, d: { itemIds: string[] }) => ({ updated: d.itemIds.length }));
    const commit = jest.fn(async () => ({}));
    const real = new ProposalBatchCommitService(
      prisma,
      { bulk } as never,
      { commit } as never,
      { get: async () => ({ review: { minConfidence: 0.7 } }) } as never,
      { effectiveSchemaFor: async () => ({ entityTypes: [], relationTypes: [] }) } as never,
      { require: jest.fn(async () => undefined) } as never,
      { record: jest.fn(async () => undefined) } as never,
    );
    jest.spyOn(real as never, 'carryOver').mockResolvedValue('rem' as never);
    const handler = new KgAutocommitHandler(
      jobsMock() as never,
      prisma,
      { hasPermission: async () => true } as never,
      { record: jest.fn(async () => undefined) } as never,
      { graphEnabled: async () => true } as never,
      { forNote: async () => null } as never,
      { get: async () => ({ review: { minConfidence: 0.7, autoCommitSafeRows: true } }) } as never,
      real,
    );
    await handler.process(job());
    expect(bulk).toHaveBeenCalledWith(expect.anything(), P, { itemIds: ['ok'], decision: 'accept' });
    expect(JSON.stringify(bulk.mock.calls)).not.toContain('sens');
    expect(JSON.stringify(bulk.mock.calls)).not.toContain('close');
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
