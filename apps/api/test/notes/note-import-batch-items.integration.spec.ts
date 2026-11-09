import { NotFoundException } from '@nestjs/common';
import request from 'supertest';

import { NoteLibrariesService } from '@marinoscar/kvox-api/notes';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { mockPrismaTransaction, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';

// GET /api/notes/import-batches/:id/items over the wire: query validation (400), the parsed
// query reaching the service, and the 404 for a batch the caller does not own. The query
// building itself is the service spec's subject.

const BATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const URL = `/api/notes/import-batches/${BATCH}/items`;

describe('GET /api/notes/import-batches/:id/items (integration)', () => {
  let context: TestContext;
  let listItems: jest.SpyInstance;
  let token: string;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    mockPrismaTransaction();
    listItems?.mockRestore();
    listItems = jest
      .spyOn(context.app.get(NoteLibrariesService), 'listItems')
      .mockResolvedValue({ items: [], nextCursor: null } as never);
    token = (await createMockTestUser(context)).accessToken;
  });

  const get = (query: Record<string, string>) =>
    request(context.app.getHttpServer()).get(URL).query(query).set(authHeader(token));

  it('is 401 without a session', async () => {
    await request(context.app.getHttpServer()).get(URL).expect(401);
  });

  it('passes q, status, updatedSince and a limit of 500 to the service', async () => {
    await get({
      q: ' Plan ',
      status: 'failed',
      updatedSince: '2026-11-06T10:00:00.000Z',
      limit: '500',
    }).expect(200);

    expect(listItems).toHaveBeenCalledWith(
      expect.anything(),
      BATCH,
      expect.objectContaining({
        q: 'Plan',
        status: 'failed',
        updatedSince: '2026-11-06T10:00:00.000Z',
        limit: 500,
      })
    );
  });

  it('is 400 for limit 501, an invalid updatedSince, an empty or oversize q', async () => {
    await get({ limit: '501' }).expect(400);
    await get({ updatedSince: 'not-a-date' }).expect(400);
    await get({ q: '   ' }).expect(400);
    await get({ q: 'a'.repeat(201) }).expect(400);
    expect(listItems).not.toHaveBeenCalled();
  });

  it('is 404, never 403, for a batch the caller does not own', async () => {
    listItems.mockRejectedValue(new NotFoundException('Import batch not found'));

    await get({ q: 'x' }).expect(404);
  });
});
