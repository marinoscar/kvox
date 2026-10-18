// =============================================================================
// Who may call the factory reset routes (issue #562)
// =============================================================================
//
// The full `AppModule` over a mocked `PrismaService`, so this also proves the app still
// boots with the factory reset wiring (`UserDataHostModule` now imports the storage
// providers and binds `KvoxFactoryResetBinding`). `/api/admin/factory-reset/*` needs
// `system:factory_reset`, held by the `admin` SYSTEM role only: an `org_admin`, a
// contributor and a viewer are refused, and so is an anonymous caller. The Admin is not
// refused (what the route then answers depends on a database this suite does not have,
// so only the guard's answer is asserted).
// =============================================================================

import request from 'supertest';

import { isKvoxFactoryResetBound } from '../../src/kvox-objects/factory-reset-storage.step';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { authHeader } from '../helpers/auth-mock.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMembershipAdmin,
  createMembershipContributor,
  createMembershipUser,
  createMembershipViewer,
} from '../helpers/membership-user.helper';

const ROUTES: Array<['get' | 'post', string]> = [
  ['get', '/api/admin/factory-reset/summary'],
  ['post', '/api/admin/factory-reset'],
  ['get', '/api/admin/factory-reset/33333333-3333-4333-8333-333333333333'],
];

describe('factory reset routes (RBAC)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
  });

  const call = (method: 'get' | 'post', path: string, token?: string) => {
    const req = request(context.app.getHttpServer())[method](path);

    if (method === 'post') req.send({});

    return token ? req.set(authHeader(token)) : req;
  };

  it('binds the storage sweep’s ports when the app boots, so the reset can delete bytes', () => {
    expect(isKvoxFactoryResetBound()).toBe(true);
  });

  it.each(ROUTES)('answers 401 to an anonymous caller: %s %s', async (method, path) => {
    await call(method, path).expect(401);
  });

  it.each(ROUTES)('refuses a viewer: %s %s', async (method, path) => {
    const viewer = await createMembershipViewer(context);

    await call(method, path, viewer.accessToken).expect(403);
  });

  it.each(ROUTES)('refuses a contributor: %s %s', async (method, path) => {
    const contributor = await createMembershipContributor(context);

    await call(method, path, contributor.accessToken).expect(403);
  });

  it.each(ROUTES)('refuses an organization admin, whose role is org-scoped: %s %s', async (method, path) => {
    const orgAdmin = await createMembershipUser(context, { orgRole: 'org_admin' });

    await call(method, path, orgAdmin.accessToken).expect(403);
  });

  it.each(ROUTES)('lets the system admin through the guard: %s %s', async (method, path) => {
    const admin = await createMembershipAdmin(context);
    const response = await call(method, path, admin.accessToken);

    expect([401, 403]).not.toContain(response.status);
  });
});
