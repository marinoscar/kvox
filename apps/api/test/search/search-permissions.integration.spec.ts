import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import request from 'supertest';

import { registerMockUserRecord, setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockUserWithRelations } from '../fixtures/test-data.factory';
import { authHeader, type TestUser } from '../helpers/auth-mock.helper';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';

// =============================================================================
// `GET /api/search` for a caller who holds ONE of the two read permissions
// (issue #494, epic #491)
// =============================================================================
//
// The route and its two siblings declare NO permission on purpose: `GET /api/search`
// needs `transcripts:read` OR `notes:read`, which a guard that requires all declared
// permissions cannot express, so the service narrows the types from the caller's
// permissions. That is exactly the case the permissionless-route trap is about. A
// platform guard attaches the normalised user only on a route that declares a role or
// a permission, so a service reading it on this route would see NO permissions, and
// every caller, whatever their role, would be refused.
//
// The packaged route reads the principal the identity port returns
// (`KVOX_IDENTITY`, whose web adapter derives roles and permissions from what the
// JWT guard itself attached), and this suite proves it THROUGH THE REAL GUARD STACK:
// the real `AppModule`, the real JWT strategy, the real `KvoxAuthGuard`, the real
// adapter, the real `SearchService`. Only the database is mocked.
//
// The users carry the shape production has: the domain permissions come from the
// ORG role on the default organization's membership (platform migration 0024), here
// a Viewer whose role was narrowed to a single permission.
// =============================================================================

const SEARCH = '/api/search';

const NOTE_ROW = {
  type: 'note',
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Quarterly plan',
  status: 'ready',
  updated_at: new Date('2026-09-15T12:00:00.000Z'),
  score: 0.5,
};

const TRANSCRIPT_ROW = {
  type: 'transcript',
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Quarterly review call',
  status: 'ready',
  updated_at: new Date('2026-09-14T12:00:00.000Z'),
  score: 0.4,
};

/**
 * A user whose default-organization membership holds a Viewer role narrowed to
 * `permissions`, and who holds no system role.
 */
async function viewerHolding(context: TestContext, permissions: string[]): Promise<TestUser> {
  const base = createMockUserWithRelations({ roleName: 'viewer' });
  const roleId = randomUUID();
  const orgId = 'org-default';

  registerMockUserRecord({
    ...base,
    userRoles: [],
    memberships: [
      {
        orgId,
        userId: base.id,
        status: 'active' as const,
        lastActiveAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        org: { id: orgId, isDefault: true },
        role: {
          id: roleId,
          name: 'viewer',
          description: null,
          rolePermissions: permissions.map((name) => ({
            roleId,
            permissionId: `perm-${name}`,
            permission: { id: `perm-${name}`, name, description: null },
          })),
        },
      },
    ],
  } as never);

  const accessToken = context.module.get(JwtService).sign({ sub: base.id, email: base.email, roles: ['viewer'] });

  return { id: base.id, email: base.email, roles: ['viewer'], accessToken };
}

describe('GET /api/search permissions (integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  /** Every raw statement the search service sent, as text. */
  const statements = (): string[] =>
    (prismaMock.$queryRaw.mock.calls as unknown as Array<[{ strings: string[] }]>).map(([sql]) => sql.strings.join('?'));

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();

    // The visibility rule runs its statements in the viewer's organization scope.
    prismaMock.runInOrg.mockImplementation((async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(prismaMock)) as never);

    // The database answers each statement by its text: the stopword probe, the
    // embeddings-present probe, the unindexed count, the snippets and the candidate
    // window, which holds only the document types the statement asks for.
    prismaMock.$queryRaw.mockImplementation((async (sql: { strings: string[] }) => {
      const text = sql.strings.join('?');

      if (text.includes('numnode(')) return [{ nodes: 3 }];
      if (text.includes('AS present')) return [{ present: false }];
      if (text.includes('coalesce(sum(x.n)')) return [{ n: 0 }];
      if (text.includes('y.rn')) return [];

      return [
        ...(/FROM transcripts (tt|t)\b/.test(text) ? [TRANSCRIPT_ROW] : []),
        ...(text.includes('FROM notes n') ? [NOTE_ROW] : []),
      ];
    }) as never);
    prismaMock.searchIndexState.findMany.mockResolvedValue([] as never);
  });

  it('answers a Viewer holding ONLY notes:read with 200 and the notes, not a 403', async () => {
    const viewer = await viewerHolding(context, ['notes:read']);

    const response = await request(context.app.getHttpServer())
      .get(`${SEARCH}?q=quarterly`)
      .set(authHeader(viewer.accessToken))
      .expect(200);

    expect(response.body.data.searchedTypes).toEqual(['note']);
    expect(response.body.data.results.map((row: { id: string }) => row.id)).toEqual([NOTE_ROW.id]);

    // The transcript arm never ran: a caller without `transcripts:read` is not
    // even a candidate for a transcript row.
    expect(statements().some((text) => /FROM transcripts\b/.test(text))).toBe(false);
  });

  it('answers a Viewer holding ONLY transcripts:read with 200 and the transcripts', async () => {
    const viewer = await viewerHolding(context, ['transcripts:read']);

    const response = await request(context.app.getHttpServer())
      .get(`${SEARCH}?q=quarterly`)
      .set(authHeader(viewer.accessToken))
      .expect(200);

    expect(response.body.data.searchedTypes).toEqual(['transcript']);
    expect(response.body.data.results.map((row: { id: string }) => row.id)).toEqual([TRANSCRIPT_ROW.id]);
    expect(statements().some((text) => /FROM notes\b/.test(text))).toBe(false);
  });

  it('searches both types for a Viewer holding both permissions', async () => {
    const viewer = await viewerHolding(context, ['transcripts:read', 'notes:read']);

    const response = await request(context.app.getHttpServer())
      .get(`${SEARCH}?q=quarterly`)
      .set(authHeader(viewer.accessToken))
      .expect(200);

    expect(response.body.data.searchedTypes).toEqual(['transcript', 'note']);
    expect(response.body.data.results).toHaveLength(2);
  });

  it('narrows an explicit types request to what the caller may read, rather than refusing', async () => {
    const viewer = await viewerHolding(context, ['notes:read']);

    const response = await request(context.app.getHttpServer())
      .get(`${SEARCH}?q=quarterly&types=transcript,note`)
      .set(authHeader(viewer.accessToken))
      .expect(200);

    expect(response.body.data.searchedTypes).toEqual(['note']);
  });

  it('answers 403 only when the caller holds NEITHER permission, or asks for the one type they may not read', async () => {
    const neither = await viewerHolding(context, ['graph:read']);
    const notesOnly = await viewerHolding(context, ['notes:read']);

    await request(context.app.getHttpServer())
      .get(`${SEARCH}?q=quarterly`)
      .set(authHeader(neither.accessToken))
      .expect(403);

    await request(context.app.getHttpServer())
      .get(`${SEARCH}?q=quarterly&types=transcript`)
      .set(authHeader(notesOnly.accessToken))
      .expect(403);
  });

  it('answers 401 without a credential', async () => {
    await request(context.app.getHttpServer()).get(`${SEARCH}?q=quarterly`).expect(401);
  });

  it('serves the index status to a one-permission caller too (the route names no permission)', async () => {
    const viewer = await viewerHolding(context, ['notes:read']);

    const response = await request(context.app.getHttpServer())
      .get(`${SEARCH}/index-status`)
      .set(authHeader(viewer.accessToken))
      .expect(200);

    expect(response.body.data.types.map((entry: { type: string }) => entry.type).sort()).toEqual(['note', 'transcript']);
  });
});
