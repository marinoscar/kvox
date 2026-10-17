import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockViewerUser } from '../helpers/auth-mock.helper';

// =============================================================================
// GET /api/exports/sources through the real guard stack (issue #532)
// =============================================================================
//
// The slice silently drops a source that offers no format, so "Download your data" would
// simply lack a row if `kvox-content` forgot to list the built-in writers (they attach only
// to the platform's own source ids). This pins what the lowest role sees: the platform's
// `user-data` first (the dialog's default), then `kvox-content`, each with json, csv and xlsx,
// and NOT `org-data` (it needs `org_members:read`, an org-admin permission).
// =============================================================================

describe('GET /api/exports/sources', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
  });

  it('answers 401 without a token', async () => {
    await request(context.app.getHttpServer()).get('/api/exports/sources').expect(401);
  });

  it('lists user-data then kvox-content for a viewer, each in json, csv and xlsx', async () => {
    const viewer = await createMockViewerUser(context);

    const response = await request(context.app.getHttpServer())
      .get('/api/exports/sources')
      .set(authHeader(viewer.accessToken))
      .expect(200);

    const items = response.body.data.items as Array<{ id: string; scope: string; formats: Array<{ id: string }>; fields: unknown[] }>;

    expect(items.map((item) => item.id)).toEqual(['user-data', 'kvox-content']);
    for (const item of items) {
      expect(item.scope).toBe('user');
      expect(item.formats.map((format) => format.id)).toEqual(['json', 'csv', 'xlsx']);
      expect(item.fields).toEqual([]);
    }
  });

  it('refuses an unknown source and a source the caller may not use, before queueing anything', async () => {
    const viewer = await createMockViewerUser(context);

    await request(context.app.getHttpServer())
      .post('/api/exports')
      .set(authHeader(viewer.accessToken))
      .send({ source: 'nope', format: 'json' })
      .expect(400);
    await request(context.app.getHttpServer())
      .post('/api/exports')
      .set(authHeader(viewer.accessToken))
      .send({ source: 'org-data', format: 'json' })
      .expect(403);
  });
});
