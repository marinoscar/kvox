import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GRAPH_NOT_FOUND_MESSAGES,
  GraphAccessService,
  type GraphSubjectKind,
} from './graph-access.service';

// =============================================================================
// GraphAccessService (#354, epic #344, docs/specs/ontology.md §12)
// =============================================================================
//
// For every one of the seven kinds, the properties this service exists to hold:
//
//   1. EVERY refusal about EXISTENCE is a 404 with the SAME message per kind —
//      missing, somebody else's, and (for reviewed kinds) unreviewed/rejected
//      or merged are indistinguishable from outside.
//   2. The one refusal NOT about existence — an owner lacking `graph:write` at
//      level `edit` — is a 403, and only once the row is the caller's own.
//   3. It RETURNS the row.
// =============================================================================

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const ROW_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

const WRITE = [PERMISSIONS.GRAPH_READ, PERMISSIONS.GRAPH_WRITE];
const READ_ONLY = [PERMISSIONS.GRAPH_READ];

/** The Prisma delegate each kind reads through. */
const DELEGATES: Record<GraphSubjectKind, string> = {
  entity: 'kgEntity',
  relation: 'kgRelation',
  item: 'kgItem',
  proposal: 'kgProposal',
  attribute_def: 'kgAttributeDef',
  evidence: 'kgEvidence',
  merge: 'kgMerge',
};

const ALL_KINDS = Object.keys(DELEGATES) as GraphSubjectKind[];
const REVIEWED_KINDS: GraphSubjectKind[] = ['entity', 'relation', 'item'];

type Delegate = { findUnique: jest.Mock; count: jest.Mock };

describe('GraphAccessService', () => {
  let service: GraphAccessService;
  let prisma: Record<string, Delegate>;

  const row = (kind: GraphSubjectKind, overrides: Record<string, unknown> = {}) => ({
    id: ROW_ID,
    ownerId: OWNER,
    ...(REVIEWED_KINDS.includes(kind) ? { reviewStatus: 'accepted' } : {}),
    ...overrides,
  });

  // The overloads narrow the return type per kind; the tests drive every kind
  // through one loop, so they call through this loosely-typed view.
  const requireAny = (
    userId: string,
    kind: GraphSubjectKind,
    id: string,
    level: 'view' | 'edit',
    permissions?: readonly string[],
    options?: { includeMerged?: boolean },
  ): Promise<{ message?: string } & Record<string, unknown>> =>
    (service.require as unknown as (...args: unknown[]) => Promise<never>)(
      userId,
      kind,
      id,
      level,
      permissions,
      options,
    );

  beforeEach(async () => {
    prisma = Object.fromEntries(
      Object.values(DELEGATES).map((name) => [
        name,
        { findUnique: jest.fn(), count: jest.fn() },
      ]),
    );

    const module = await Test.createTestingModule({
      providers: [GraphAccessService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(GraphAccessService);
  });

  it('declares a distinct not-found message for every kind', () => {
    expect(Object.keys(GRAPH_NOT_FOUND_MESSAGES).sort()).toEqual([...ALL_KINDS].sort());
    expect(GRAPH_NOT_FOUND_MESSAGES.entity).toBe('Entity not found');
  });

  describe.each(ALL_KINDS)('kind %s', (kind) => {
    const delegate = () => prisma[DELEGATES[kind]];
    const message = GRAPH_NOT_FOUND_MESSAGES[kind];

    it('returns the caller\'s own row, read by id through its own table', async () => {
      const own = row(kind);
      delegate().findUnique.mockResolvedValue(own);

      await expect(requireAny(OWNER, kind, ROW_ID, 'view')).resolves.toBe(own);
      expect(delegate().findUnique).toHaveBeenCalledWith({ where: { id: ROW_ID } });
    });

    it('answers 404 with the exact message for another owner\'s row', async () => {
      delegate().findUnique.mockResolvedValue(row(kind, { ownerId: STRANGER }));

      const error = await requireAny(OWNER, kind, ROW_ID, 'view').catch((e: Error) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(message);
    });

    it('answers the SAME 404 for a missing row', async () => {
      delegate().findUnique.mockResolvedValue(null);

      const error = await requireAny(OWNER, kind, ROW_ID, 'view').catch((e: Error) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(message);
    });

    it('answers the SAME 404 for a malformed id, without querying', async () => {
      const error = await requireAny(OWNER, kind, 'not-a-uuid', 'view').catch((e: Error) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(message);
      expect(delegate().findUnique).not.toHaveBeenCalled();
    });

    it('refuses a stranger with 404, not 403, even at level edit without graph:write', async () => {
      delegate().findUnique.mockResolvedValue(row(kind, { ownerId: STRANGER }));

      await expect(requireAny(OWNER, kind, ROW_ID, 'edit', READ_ONLY)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses edit without graph:write with a 403 on the caller\'s own row', async () => {
      delegate().findUnique.mockResolvedValue(row(kind));

      const error = await requireAny(OWNER, kind, ROW_ID, 'edit', READ_ONLY).catch((e: Error) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.message).toBe('This action requires the graph:write permission.');
    });

    it('admits edit with graph:write', async () => {
      const own = row(kind);
      delegate().findUnique.mockResolvedValue(own);

      await expect(requireAny(OWNER, kind, ROW_ID, 'edit', WRITE)).resolves.toBe(own);
    });
  });

  describe.each(REVIEWED_KINDS)('review status on kind %s', (kind) => {
    const delegate = () => prisma[DELEGATES[kind]];
    const message = GRAPH_NOT_FOUND_MESSAGES[kind];

    it.each(['unreviewed', 'rejected'])('answers the same 404 for a %s row', async (status) => {
      delegate().findUnique.mockResolvedValue(row(kind, { reviewStatus: status }));

      const error = await requireAny(OWNER, kind, ROW_ID, 'view').catch((e: Error) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(message);
    });

    it.each(['unreviewed', 'rejected'])(
      'still answers 404 for a %s row with includeMerged',
      async (status) => {
        delegate().findUnique.mockResolvedValue(row(kind, { reviewStatus: status }));

        await expect(
          requireAny(OWNER, kind, ROW_ID, 'view', [], { includeMerged: true }),
        ).rejects.toBeInstanceOf(NotFoundException);
      },
    );

    it('answers the same 404 for a merged row by default', async () => {
      delegate().findUnique.mockResolvedValue(row(kind, { reviewStatus: 'merged' }));

      const error = await requireAny(OWNER, kind, ROW_ID, 'view').catch((e: Error) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe(message);
    });

    it('returns a merged row with includeMerged', async () => {
      const merged = row(kind, { reviewStatus: 'merged', mergedIntoId: OTHER_ID });
      delegate().findUnique.mockResolvedValue(merged);

      await expect(
        requireAny(OWNER, kind, ROW_ID, 'view', [], { includeMerged: true }),
      ).resolves.toBe(merged);
    });

    it.each(['accepted', 'edited', 'superseded'])('returns a %s row', async (status) => {
      delegate().findUnique.mockResolvedValue(row(kind, { reviewStatus: status }));

      await expect(requireAny(OWNER, kind, ROW_ID, 'view')).resolves.toMatchObject({
        reviewStatus: status,
      });
    });
  });

  it('entity: another user\'s, missing, rejected and merged all give the identical message', async () => {
    const outcomes = [
      row('entity', { ownerId: STRANGER }),
      null,
      row('entity', { reviewStatus: 'rejected' }),
      row('entity', { reviewStatus: 'merged' }),
    ];
    const messages: string[] = [];
    for (const outcome of outcomes) {
      prisma.kgEntity.findUnique.mockResolvedValueOnce(outcome);
      const error = await service.require(OWNER, 'entity', ROW_ID, 'view').catch((e: Error) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      messages.push((error as Error).message);
    }
    expect(new Set(messages)).toEqual(new Set(['Entity not found']));
  });

  describe.each(['entity', 'relation', 'item'] as const)('ownsAll(%s)', (kind) => {
    const delegate = () => prisma[DELEGATES[kind]];

    it('is true when every id is the caller\'s, in one owner-scoped count', async () => {
      delegate().count.mockResolvedValue(2);

      await expect(service.ownsAll(OWNER, kind, [ROW_ID, OTHER_ID, ROW_ID])).resolves.toBe(true);
      expect(delegate().count).toHaveBeenCalledTimes(1);
      expect(delegate().count).toHaveBeenCalledWith({
        where: { id: { in: [ROW_ID, OTHER_ID] }, ownerId: OWNER },
      });
    });

    it('is false when any id is foreign (or missing)', async () => {
      delegate().count.mockResolvedValue(1);

      await expect(service.ownsAll(OWNER, kind, [ROW_ID, OTHER_ID])).resolves.toBe(false);
    });

    it('is false for a malformed id, without querying', async () => {
      await expect(service.ownsAll(OWNER, kind, [ROW_ID, 'nope'])).resolves.toBe(false);
      expect(delegate().count).not.toHaveBeenCalled();
    });

    it('is trivially true for an empty list, without querying', async () => {
      await expect(service.ownsAll(OWNER, kind, [])).resolves.toBe(true);
      expect(delegate().count).not.toHaveBeenCalled();
    });
  });
});
