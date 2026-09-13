import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockTestUser,
  createMockAdminUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import {
  DEFAULT_SYSTEM_SETTINGS,
  SystemSettingsValue,
} from '../../src/common/types/settings.types';
import { systemSettingsResponseSchema } from '../../src/settings/dto/system-settings-response.dto';

// .env.test pins JWT_ACCESS_TTL_MINUTES=15 and JWT_REFRESH_TTL_DAYS=14 —
// the same numbers configuration.ts falls back to when the env vars are
// unset, so this suite cannot tell "read from config" apart from "hardcoded
// default" on its own. That distinction (non-default config values) is
// pinned instead in the unit spec
// (system-settings.service.spec.ts), which mocks ConfigService directly;
// this integration suite proves the real HTTP contract: GET/PATCH actually
// emit the block, a submitted one is discarded, and the payload validates
// against systemSettingsResponseSchema.
const EXPECTED_SECURITY = { jwtAccessTtlMinutes: 15, refreshTtlDays: 14 };

describe('System Settings Integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
  });

  describe('GET /api/system-settings', () => {
    it('should return 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .expect(401);
    });

    it('should return 403 for users without system_settings:read permission', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('should return settings for admin', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
        nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
        security: EXPECTED_SECURITY,
        version: expect.any(Number),
      });
      expect(response.body.data.updatedAt).toBeDefined();

      // #225, epic #215. The defaults are asserted as LITERALS rather than
      // against `DEFAULT_SYSTEM_SETTINGS.notifications`, which would pass
      // even if someone flipped the constant: the acceptance criterion is
      // specifically `true` and `[]`, because an operator opts OUT of the
      // browser channel and never into it.
      expect(response.body.data.notifications).toEqual({
        browserEnabled: true,
        disabledEvents: [],
      });
    });

    // Note: ETag header not currently implemented in controller
  });

  describe.skip('PUT /api/system-settings', () => {
    const newSettings: SystemSettingsValue = {
      ...DEFAULT_SYSTEM_SETTINGS,
      jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 45 },
      nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
      notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
    };

    it('should return 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .send(newSettings)
        .expect(401);
    });

    it('should return 403 for users without system_settings:write permission', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .send(newSettings)
        .expect(403);
    });

    it('should replace settings for admin', async () => {
      const admin = await createMockAdminUser(context);

      context.prismaMock.systemSettings.upsert.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: newSettings as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });

      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(newSettings)
        .expect(200);

      expect(response.body.data).toMatchObject({
        jobs: newSettings.jobs,
        nodes: newSettings.nodes,
        version: 2,
      });
    });

    // Note: ETag header not currently implemented in controller

    it('should return 400 with invalid settings structure', async () => {
      const admin = await createMockAdminUser(context);

      const invalidSettings = {
        jobs: { stuckThresholdMinutes: 'not-a-number' },
        notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
      };

      await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(invalidSettings)
        .expect(400);
    });

    it('should return 400 with missing required fields', async () => {
      const admin = await createMockAdminUser(context);

      const incompleteSettings = {
        // Missing notifications field
        jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
      };

      await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(incompleteSettings)
        .expect(400);
    });
  });

  describe('PATCH /api/system-settings', () => {
    beforeEach(() => {
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: DEFAULT_SYSTEM_SETTINGS as any,
        version: 1,
        updatedAt: new Date(),
        updatedByUserId: null,
        updatedByUser: null,
      });
    });

    it('should return 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .send({ nodes: { jobSecretBrokerEnabled: false } })
        .expect(401);
    });

    it('should return 403 for users without system_settings:write permission', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .send({ nodes: { jobSecretBrokerEnabled: false } })
        .expect(403);
    });

    it('should merge settings for admin', async () => {
      const admin = await createMockAdminUser(context);

      const partialUpdate = { nodes: { jobSecretBrokerEnabled: true } };

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        } as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });

      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.nodes.jobSecretBrokerEnabled).toBe(true);
      expect(response.body.data.jobs).toEqual(DEFAULT_SYSTEM_SETTINGS.jobs);
      expect(response.body.data.security).toEqual(EXPECTED_SECURITY);
      expect(response.body.data.version).toBe(2);
    });

    it('should return 412 when If-Match does not match ETag', async () => {
      const admin = await createMockAdminUser(context);

      const partialUpdate = { nodes: { jobSecretBrokerEnabled: true } };

      // Current version is 1, but If-Match header expects version 2
      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .set('If-Match', '2')
        .send(partialUpdate)
        .expect(409); // ConflictException returns 409

      expect(response.body.message).toContain('version mismatch');
    });

    it('should succeed when If-Match matches current version', async () => {
      const admin = await createMockAdminUser(context);

      const partialUpdate = { nodes: { jobSecretBrokerEnabled: true } };

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        } as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });

      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      // Current version is 1, If-Match header expects version 1
      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .set('If-Match', '1')
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.version).toBe(2);
    });

    it('should work without If-Match header', async () => {
      const admin = await createMockAdminUser(context);

      const partialUpdate = { nodes: { jobSecretBrokerEnabled: true } };

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        } as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });

      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.version).toBe(2);
    });

    it('should handle nested jobs.history updates', async () => {
      const admin = await createMockAdminUser(context);

      const partialUpdate = { jobs: { history: { retentionDays: 90 } } };

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: {
            ...DEFAULT_SYSTEM_SETTINGS.jobs,
            history: { ...DEFAULT_SYSTEM_SETTINGS.jobs.history, retentionDays: 90 },
          },
        } as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });

      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.jobs.history.retentionDays).toBe(90);
    });

    /**
     * Issue #225, epic #215 — the acceptance criterion "PATCH persists both
     * the global toggle and the per-event list", over real HTTP.
     *
     * Asserted on the PERSISTED value as well as the response, because the two
     * can disagree: the response is a projection of whatever the mocked
     * `update` returns, so a merge that dropped the block would still echo a
     * healthy-looking payload back. What the service asked Prisma to write is
     * the only honest evidence.
     */
    it('persists both halves of the notifications block (#225)', async () => {
      const admin = await createMockAdminUser(context);

      const partialUpdate = {
        notifications: {
          browserEnabled: false,
          disabledEvents: ['security.role_changed'],
        },
      };

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          notifications: partialUpdate.notifications,
        } as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.notifications).toEqual(
        partialUpdate.notifications,
      );

      const updateArgs = context.prismaMock.systemSettings.update.mock
        .calls[0][0] as any;
      expect(updateArgs.data.value.notifications).toEqual(
        partialUpdate.notifications,
      );
    });

    it('leaves the untouched half of notifications alone when only one is sent (#225)', async () => {
      const admin = await createMockAdminUser(context);

      // The stored row already suppresses an event; the admin only moves the
      // global switch. The list must survive — `browserEnabled` and
      // `disabledEvents` are merged field by field, not as one blob.
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          notifications: {
            browserEnabled: true,
            disabledEvents: ['security.role_changed'],
          },
        } as any,
        version: 1,
        updatedAt: new Date(),
        updatedByUserId: null,
        updatedByUser: null,
      });

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: DEFAULT_SYSTEM_SETTINGS as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ notifications: { browserEnabled: false } })
        .expect(200);

      const updateArgs = context.prismaMock.systemSettings.update.mock
        .calls[0][0] as any;
      expect(updateArgs.data.value.notifications).toEqual({
        browserEnabled: false,
        disabledEvents: ['security.role_changed'],
      });
    });

    it('rejects a malformed event key rather than storing it (#225)', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ notifications: { disabledEvents: ['NOT A KEY'] } })
        .expect(400);
    });

    /**
     * Issue #256, epic #254 — the wire-DTO trap, proven over real HTTP.
     *
     * A namespace can be declared in `systemSettingsSchema`,
     * `systemSettingsPatchSchema`, `SystemSettingsValue` and
     * `DEFAULT_SYSTEM_SETTINGS`, pass every unit test written against those,
     * and STILL no-op on every real request — because the global
     * `ZodValidationPipe` parses the body against
     * `patchSystemSettingsSchema` (settings/dto/update-system-settings.dto.ts)
     * first and strips whatever that schema does not declare. The service is
     * then handed `{}`, merges nothing, writes the row back unchanged and
     * returns 200 with a body that looks exactly right.
     *
     * That is why this test goes through HTTP rather than calling the service:
     * a service-level test constructs the DTO itself and never touches the pipe
     * that does the stripping, so it cannot see this failure at all.
     *
     * TWO NETS ALREADY CATCH PART OF IT, AND NEITHER REPLACES THIS ONE. Because
     * the merge in `system-settings.service.ts` names `dto.databaseBackup`
     * explicitly and the namespace is required in `systemSettingsSchema`,
     * deleting it from the PATCH body schema is currently a compile error, and
     * deleting it from the merge as well is a ZodError. Both nets depend on
     * choices that a future namespace may not repeat — a namespace merged with
     * a spread, or made optional in the canonical schema, restores the silent
     * 200 exactly. `common/schemas/settings-parity.spec.ts` catches the key-set
     * half of that; this test is what proves the whole path still works when
     * the schemas agree.
     *
     * Asserted in three places for three different reasons:
     *   1. the PERSISTED value — what the service asked Prisma to write is the
     *      only honest evidence the change survived the pipe;
     *   2. the PATCH response — the caller's own confirmation;
     *   3. a subsequent GET over the stored value — the read path projects the
     *      namespace too, so the round trip is closed rather than assumed.
     */
    it('persists and reads back a single-field databaseBackup patch (#256)', async () => {
      const admin = await createMockAdminUser(context);

      const expectedStored = {
        ...DEFAULT_SYSTEM_SETTINGS.databaseBackup,
        enabled: true,
      };

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          databaseBackup: expectedStored,
        } as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const patched = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ databaseBackup: { enabled: true } })
        .expect(200);

      // 1. What actually reached storage: the one field the caller sent,
      //    changed; the other eleven, untouched. A body stripped by the wire
      //    DTO would show `enabled: false` here while everything above still
      //    passed.
      const updateArgs = context.prismaMock.systemSettings.update.mock
        .calls[0][0] as any;
      expect(updateArgs.data.value.databaseBackup).toEqual(expectedStored);

      // 2. The response the caller gets back.
      expect(patched.body.data.databaseBackup).toEqual(expectedStored);
      expect(() =>
        systemSettingsResponseSchema.parse(patched.body.data),
      ).not.toThrow();

      // 3. And a genuine read back, over the value the write produced.
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: updateArgs.data.value,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });

      const reread = await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(reread.body.data.databaseBackup).toEqual(expectedStored);
    });

    it('leaves the other operations namespaces alone while patching one (#256)', async () => {
      // The complement of the test above: a PATCH must not quietly rewrite the
      // namespaces it did not mention, which is the failure the hand-written
      // merge in `system-settings.service.ts` produces when a namespace is
      // added to the schemas and forgotten there.
      const admin = await createMockAdminUser(context);

      const stored = {
        ...DEFAULT_SYSTEM_SETTINGS,
        jobs: {
          history: { retentionDays: 7, purgeEnabled: false },
          stuckThresholdMinutes: 15,
        },
        maintenance: {
          ...DEFAULT_SYSTEM_SETTINGS.maintenance,
          enabled: true,
          message: 'Back shortly.',
          startedAt: '2026-01-01T00:00:00.000Z',
          startedById: '11111111-1111-4111-8111-111111111111',
        },
      };

      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: stored as any,
        version: 1,
        updatedAt: new Date(),
        updatedByUserId: null,
        updatedByUser: null,
      });
      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: stored as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ nodes: { offlineRetentionDays: 14 } })
        .expect(200);

      const updateArgs = context.prismaMock.systemSettings.update.mock
        .calls[0][0] as any;
      expect(updateArgs.data.value.nodes).toEqual({
        ...DEFAULT_SYSTEM_SETTINGS.nodes,
        offlineRetentionDays: 14,
      });
      expect(updateArgs.data.value.jobs).toEqual(stored.jobs);
      expect(updateArgs.data.value.maintenance).toEqual(stored.maintenance);
    });

    it('rejects a databaseBackup value outside its bounds rather than storing it (#256)', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ databaseBackup: { compressionLevel: 10 } })
        .expect(400);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ databaseBackup: { timeOfDay: '2:00' } })
        .expect(400);
    });

    it('should return 400 with invalid partial update', async () => {
      const admin = await createMockAdminUser(context);

      const invalidUpdate = { nodes: { jobSecretBrokerEnabled: 'invalid' } };

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(invalidUpdate)
        .expect(400);
    });

    /**
     * Issue #366 — the removed `ui`/`features` namespaces. A body that still
     * sends them (an old client, a stale bookmarked request) must not have
     * them reappear anywhere: they are unknown REQUEST keys now, stripped by
     * the wire DTO like any other unrecognised field.
     */
    it('strips legacy ui/features keys from a PATCH body instead of storing or echoing them (#366)', async () => {
      const admin = await createMockAdminUser(context);

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: DEFAULT_SYSTEM_SETTINGS as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({
          ui: { allowUserThemeOverride: false },
          features: { newFlag: true },
        })
        .expect(200);

      expect(response.body.data).not.toHaveProperty('ui');
      expect(response.body.data).not.toHaveProperty('features');

      const updateArgs = context.prismaMock.systemSettings.update.mock
        .calls[0][0] as any;
      expect(updateArgs.data.value).not.toHaveProperty('ui');
      expect(updateArgs.data.value).not.toHaveProperty('features');
    });
  });

  // ===========================================================================
  // #148 — `systemSettingsResponseSchema` has always declared `security`, and
  // nothing ever populated it, so the OpenAPI contract advertised a key every
  // real response omitted. The GET and PATCH assertions above (and inline in
  // their own describes) already cover "the block is present with the right
  // numbers" on the happy path; this block covers the other two guarantees
  // end to end over real HTTP: a client cannot write it, and the payload
  // that goes out the door is the one the published schema promises.
  //
  // PUT is deliberately not exercised here: `describe.skip('PUT
  // /api/system-settings', ...)` above predates this change and is unrelated
  // to it — see the unit spec (system-settings.service.spec.ts) for PUT's
  // read-only and schema-conformance coverage via `service.replaceSettings`
  // directly.
  // ===========================================================================
  describe('security block (#148)', () => {
    it('GET: a real response parses cleanly through systemSettingsResponseSchema', async () => {
      const admin = await createMockAdminUser(context);

      // The default fixture from `setupBaseMocks()` sets `updatedByUserId`
      // but omits the `updatedByUser` key outright (rather than nulling it),
      // which is not what the real `loadOrCreateRow`'s Prisma `include`
      // produces for a row with no updater — that always comes back as an
      // explicit `null`. Set the row up the way production actually shapes
      // it so this test exercises the response schema, not a fixture gap.
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: DEFAULT_SYSTEM_SETTINGS as any,
        version: 1,
        updatedAt: new Date(),
        updatedByUserId: null,
        updatedByUser: null,
      });

      const response = await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(() =>
        systemSettingsResponseSchema.parse(response.body.data),
      ).not.toThrow();
    });

    it('PATCH: a submitted security block is discarded — the persisted value carries no security key, and the response still reflects config, not the submitted numbers', async () => {
      const admin = await createMockAdminUser(context);

      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: DEFAULT_SYSTEM_SETTINGS as any,
        version: 1,
        updatedAt: new Date(),
        updatedByUserId: null,
        updatedByUser: null,
      });

      context.prismaMock.systemSettings.update.mockResolvedValue({
        id: 'settings-1',
        key: 'global',
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        } as any,
        version: 2,
        updatedAt: new Date(),
        updatedByUserId: admin.id,
        updatedByUser: { id: admin.id, email: admin.email },
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({} as any);

      // A client that read the OpenAPI contract and assumed `security` was
      // writable, since the response DTO declares it.
      const dtoWithSecurity = {
        nodes: { jobSecretBrokerEnabled: true },
        security: { jwtAccessTtlMinutes: 9999, refreshTtlDays: 9999 },
      };

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(dtoWithSecurity)
        .expect(200);

      // The write itself is clean: nothing resembling the submitted
      // security block reached storage.
      const updateArgs =
        context.prismaMock.systemSettings.update.mock.calls[0][0];
      expect(updateArgs.data.value).not.toHaveProperty('security');

      // And the response carries config's numbers (see EXPECTED_SECURITY
      // above), never the submitted 9999s.
      expect(response.body.data.security).toEqual(EXPECTED_SECURITY);
      expect(response.body.data.security).not.toEqual({
        jwtAccessTtlMinutes: 9999,
        refreshTtlDays: 9999,
      });

      expect(() =>
        systemSettingsResponseSchema.parse(response.body.data),
      ).not.toThrow();
    });
  });
});
