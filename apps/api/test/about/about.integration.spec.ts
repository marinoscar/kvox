import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { aboutResponseSchema } from '../../src/about/about.dto';
import fixture from '../../src/about/__fixtures__/deploy-info.json';

// =============================================================================
// GET /api/admin/about through the real request pipeline (issue #124)
// =============================================================================
//
// What a unit test cannot prove: that the guards `@Auth()` attaches actually
// produce 401 and 403, that the body reaches the client inside the `{ data }`
// envelope, and — the acceptance criterion this file exists for — that the
// serialised response carries no key named like a secret, whatever the
// mounted file says.
// =============================================================================

describe('About API (Integration)', () => {
  let context: TestContext;
  let prisma: any;
  let dir: string;
  let filePath: string;
  const originalPath = process.env.DEPLOY_INFO_PATH;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
    if (originalPath === undefined) delete process.env.DEPLOY_INFO_PATH;
    else process.env.DEPLOY_INFO_PATH = originalPath;
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    prisma = context.prismaMock;

    // `SELECT version()` and the migrations query. The deep mock would
    // otherwise resolve both to `undefined`, which the service reports as a
    // database error — a legitimate state, but not the one under test here.
    prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('version()')) return [{ version: 'PostgreSQL 16.4' }];
      return [
        {
          name: '20260901120000_add_note_exports',
          finishedAt: new Date('2026-09-14T22:41:12.000Z'),
          applied: 42,
        },
      ];
    });

    dir = mkdtempSync(join(tmpdir(), 'about-integration-'));
    filePath = join(dir, 'info.json');
    process.env.DEPLOY_INFO_PATH = filePath;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const server = () => context.app.getHttpServer();
  const writeInfo = (value: unknown) =>
    writeFileSync(filePath, JSON.stringify(value), 'utf8');

  // ===========================================================================
  // Authorization
  // ===========================================================================

  it('answers 401 to an anonymous caller', async () => {
    await request(server()).get('/api/admin/about').expect(401);
  });

  it('answers 403 to a Viewer — system_settings:read is Admin-only', async () => {
    const viewer = await createMockViewerUser(context);

    await request(server())
      .get('/api/admin/about')
      .set(authHeader(viewer.accessToken))
      .expect(403);
  });

  // ===========================================================================
  // The documented shape
  // ===========================================================================

  it('answers 200 to an Admin with the documented shape, enveloped', async () => {
    const admin = await createMockAdminUser(context);
    writeInfo(fixture);

    const response = await request(server())
      .get('/api/admin/about')
      .set(authHeader(admin.accessToken))
      .expect(200);

    const body = aboutResponseSchema.parse(response.body.data);
    expect(body.deployInfoStatus).toBe('ok');
    expect(body.deployInfo).toMatchObject({
      schema: 1,
      app: { name: 'kvox', commitSha: fixture.app.commitSha },
      host: { hostname: 'vps-01' },
    });
    // Unknown field rides through — the file is `.passthrough()`.
    expect((body.deployInfo as Record<string, unknown>).unknownFutureField).toBe(
      fixture.unknownFutureField,
    );
    expect(body.runtime.nodeVersion).toBe(process.version);
    expect(body.runtime.serverTimeUtc).toMatch(/Z$/);
    expect(body.database).toEqual({
      serverVersion: 'PostgreSQL 16.4',
      appliedMigrations: 42,
      lastMigrationName: '20260901120000_add_note_exports',
      lastMigrationAt: '2026-09-14T22:41:12.000Z',
    });
    expect(body.databaseError).toBeNull();
    expect(body.updateAvailable).toBe(true);
    expect(body.checkedAt).toBe(fixture.remote.checkedAt);
    expect(response.body.meta).toEqual({ timestamp: expect.any(String) });
  });

  it("answers 200 with `deployInfo: null` and 'absent' when there is no file — the dev stack", async () => {
    const admin = await createMockAdminUser(context);
    // Nothing written.

    const response = await request(server())
      .get('/api/admin/about')
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(response.body.data.deployInfo).toBeNull();
    expect(response.body.data.deployInfoStatus).toBe('absent');
    expect(response.body.data.updateAvailable).toBeNull();
    expect(response.body.data.runtime.apiVersion).toEqual(expect.any(String));
  });

  it('answers 200, not 5xx, when the database is unreachable', async () => {
    const admin = await createMockAdminUser(context);
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

    const response = await request(server())
      .get('/api/admin/about')
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(response.body.data.database).toBeNull();
    expect(response.body.data.databaseError).toBe('connection refused');
  });

  it('reflects a rewritten file on the next request, without a restart', async () => {
    const admin = await createMockAdminUser(context);

    writeInfo({ ...fixture, lastCommand: 'install' });
    const first = await request(server())
      .get('/api/admin/about')
      .set(authHeader(admin.accessToken))
      .expect(200);
    expect(first.body.data.deployInfo.lastCommand).toBe('install');

    writeInfo({ ...fixture, lastCommand: 'update' });
    const second = await request(server())
      .get('/api/admin/about')
      .set(authHeader(admin.accessToken))
      .expect(200);
    expect(second.body.data.deployInfo.lastCommand).toBe('update');
  });

  // ===========================================================================
  // The API refuses to relay a secret, whatever the file says
  // ===========================================================================

  it('serialises no key named like a secret, even when the file carries one', async () => {
    const admin = await createMockAdminUser(context);
    writeInfo({
      ...fixture,
      deployToken: 'ghp_never',
      host: { ...fixture.host, dbPassword: 'hunter2' },
      remote: { ...fixture.remote, apiKey: 'sk-never' },
    });

    const response = await request(server())
      .get('/api/admin/about')
      .set(authHeader(admin.accessToken))
      .expect(200);

    const serialised = JSON.stringify(response.body);
    expect(response.body.data.deployInfoStatus).toBe('ok');
    expect(serialised).not.toMatch(/PASSWORD|SECRET|KEY|TOKEN/i);
    expect(serialised).not.toContain('ghp_never');
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('sk-never');
  });
});
