import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';

// =============================================================================
// The proposal routes over the wire (#366)
// =============================================================================
//
// Through the real `AppModule` — guards, Zod pipes, `GraphAccessService` —
// with `PrismaService` mocked. The commit and revert SQL are covered against
// real Postgres in `kg-proposal-commit.db.spec.ts` / `kg-proposal-revert.db
// .spec.ts`; this file pins the envelope: 401, 403 without `graph:write` on
// every write, the byte-identical 404 for someone else's proposal, and the
// Zod 400s.
// =============================================================================

const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

type Row = Record<string, any>;

function stripPermission(userId: string, permission: string): void {
  const original = prismaMock.user.findUnique.getMockImplementation();
  prismaMock.user.findUnique.mockImplementation(async (args: never) => {
    const user = (await original?.(args)) as Row | null;
    if (!user || user.id !== userId || !user.userRoles) return user as never;
    return {
      ...user,
      userRoles: user.userRoles.map((ur: Row) => ({
        ...ur,
        role: { ...ur.role, rolePermissions: ur.role.rolePermissions.filter((rp: Row) => rp.permission.name !== permission) },
      })),
    } as never;
  });
}

const WRITES: Array<[string, 'patch' | 'post', string, unknown]> = [
  ['decide', 'patch', `/api/graph/proposals/${P}/items/${ITEM}`, { decision: 'accept' }],
  ['bulk', 'post', `/api/graph/proposals/${P}/items/bulk`, { itemIds: [ITEM], decision: 'accept' }],
  [
    'add',
    'post',
    `/api/graph/proposals/${P}/items`,
    { kind: 'entity', payload: { type: 'Person', label: 'X' }, evidence: [{ source: 'note', noteVersion: 1, charStart: 0, charEnd: 1, quote: 'X' }] },
  ],
  ['commit', 'post', `/api/graph/proposals/${P}/commit`, {}],
  ['discard', 'post', `/api/graph/proposals/${P}/discard`, {}],
  ['revert', 'post', `/api/graph/proposals/${P}/revert`, { confirmPartial: false }],
];

describe('graph proposal routes (integration)', () => {
  let context: TestContext;
  let proposals: Row[];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 120_000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    proposals = [];
    prismaMock.kgProposal.findUnique.mockImplementation(async ({ where }: { where: Row }) => proposals.find((p) => p.id === where.id) ?? null);
  });

  function seed(ownerId: string) {
    proposals = [
      {
        id: P,
        ownerId,
        kind: 'extraction',
        status: 'draft',
        noteId: null,
        noteVersion: 1,
        model: null,
        provider: null,
        systemPrompt: null,
        userContent: null,
        userGuidance: null,
        stats: {},
        committedAt: null,
        revertedAt: null,
        jobId: null,
        commitLog: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
  }

  const server = () => context.app.getHttpServer();

  it('answers 401 without a token', async () => {
    await request(server()).get('/api/graph/proposals').expect(401);
    await request(server()).get(`/api/graph/proposals/${P}`).expect(401);
    for (const [, method, url, body] of WRITES) {
      await request(server())[method](url).send(body as object).expect(401);
    }
  });

  it.each(WRITES)('%s answers 403 to the owner without graph:write', async (_name, method, url, body) => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);
    stripPermission(owner.id, 'graph:write');
    await request(server())[method](url).set(authHeader(owner.accessToken)).send(body as object).expect(403);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("answers another user's proposal with the same 404 a missing one gets, reads and writes alike", async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    const stranger = await createMockTestUser(context, { roleName: 'admin' });
    seed(owner.id);
    const theirs = await request(server()).get(`/api/graph/proposals/${P}`).set(authHeader(stranger.accessToken)).expect(404);
    const missing = await request(server()).get(`/api/graph/proposals/${MISSING}`).set(authHeader(stranger.accessToken)).expect(404);
    expect(theirs.body.message).toBe('Proposal not found');
    const strip = ({ path: _p, timestamp: _t, ...rest }: Row) => rest;
    expect(strip(missing.body)).toEqual(strip(theirs.body));
    for (const [, method, url, body] of WRITES) {
      const res = await request(server())[method](url).set(authHeader(stranger.accessToken)).send(body as object).expect(404);
      expect(res.body.message).toBe('Proposal not found');
    }
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown decision', 'patch', `/api/graph/proposals/${P}/items/${ITEM}`, { decision: 'maybe' }],
    ['an unknown key', 'patch', `/api/graph/proposals/${P}/items/${ITEM}`, { decision: 'accept', force: true }],
    ['a non-uuid item', 'patch', `/api/graph/proposals/${P}/items/nope`, { decision: 'accept' }],
    ['an empty bulk', 'post', `/api/graph/proposals/${P}/items/bulk`, { itemIds: [], decision: 'accept' }],
    ['a bulk edit', 'post', `/api/graph/proposals/${P}/items/bulk`, { itemIds: [ITEM], decision: 'edit' }],
    ['an add without evidence', 'post', `/api/graph/proposals/${P}/items`, { kind: 'entity', payload: {}, evidence: [] }],
    ['a closing add', 'post', `/api/graph/proposals/${P}/items`, { kind: 'closing', payload: {}, evidence: [{ source: 'note', noteVersion: 1, charStart: 0, charEnd: 1, quote: 'X' }] }],
    ['a commit body', 'post', `/api/graph/proposals/${P}/commit`, { force: true }],
    ['a revert with a string flag', 'post', `/api/graph/proposals/${P}/revert`, { confirmPartial: 'yes' }],
  ] as const)('answers %s with 400', async (_name, method, url, body) => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);
    await request(server())[method](url).set(authHeader(owner.accessToken)).send(body as object).expect(400);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['a limit over 50', '/api/graph/proposals?limit=51'],
    ['an unknown status', '/api/graph/proposals?status=pending'],
    ['a garbage cursor', '/api/graph/proposals?cursor=not-a-cursor'],
    ['an unknown include', `/api/graph/proposals/${P}?include=everything`],
  ])('answers a list/get with %s with 400', async (_name, url) => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);
    await request(server()).get(url).set(authHeader(owner.accessToken)).expect(400);
  });

  it('lists the caller\'s drafts by default, newest first, with an opaque cursor', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);
    prismaMock.kgProposal.findMany.mockResolvedValue([proposals[0], { ...proposals[0], id: MISSING }]);
    prismaMock.kgProposalItem.findMany.mockResolvedValue([]);
    const res = await request(server()).get('/api/graph/proposals?limit=1').set(authHeader(owner.accessToken)).expect(200);
    expect(prismaMock.kgProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerId: owner.id, status: 'draft' }), take: 2 }),
    );
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toEqual(expect.objectContaining({ id: P, status: 'draft', counts: expect.objectContaining({ total: 0 }) }));
    expect(typeof res.body.data.nextCursor).toBe('string');
  });

  it("answers a note's latest proposal with null when there is none", async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.note.findUnique.mockResolvedValue({ id: MISSING, ownerId: owner.id, deletedAt: null } as never);
    prismaMock.kgProposal.findFirst.mockResolvedValue(null);
    const res = await request(server()).get(`/api/graph/notes/${MISSING}/proposal`).set(authHeader(owner.accessToken)).expect(200);
    expect(res.body.data).toEqual({ proposal: null });
  });
});
