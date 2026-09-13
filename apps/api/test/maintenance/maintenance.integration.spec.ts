import request from 'supertest';
import { DatabaseHealthIndicator } from '../../src/health/indicators/database.indicator';
import {
  MAINTENANCE_ERROR_MARKER,
  MAINTENANCE_RETRY_AFTER_SECONDS,
} from '../../src/common/maintenance/maintenance.guard';
import { MaintenanceModeService } from '../../src/common/maintenance/maintenance-mode.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import type { SystemMaintenanceValue } from '../../src/common/schemas/settings.schema';
import {
  createMockAdminUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import {
  TestContext,
  closeTestApp,
  createTestApp,
} from '../helpers/test-app.helper';

/**
 * The maintenance window, exercised through the REAL request pipeline.
 *
 * Everything here needs the whole stack rather than a unit test, because the
 * things being asserted are properties of the pipeline and not of the guard:
 * the 503's body has to survive `HttpExceptionFilter`, which rebuilds every
 * error response from a fixed key allowlist; the `Retry-After` header has to
 * survive the same filter's `send()`; and the readiness probe has to answer
 * before Terminus reaches the database.
 */
describe('Maintenance mode (integration)', () => {
  let context: TestContext;
  let maintenance: MaintenanceModeService;

  /** Spy standing in for the DB probe, so "was it reached?" is answerable. */
  const databaseProbe = jest.fn();
  const databaseIndicatorStub = {
    isHealthy: (key: string) => {
      databaseProbe(key);
      return Promise.resolve({ [key]: { status: 'up' } });
    },
  };

  /**
   * A STATEFUL stand-in for the `system_settings` row.
   *
   * The default fixture answers every `findUnique` with the same frozen object
   * and drops whatever `update` wrote, which would make a PUT look like it had
   * been ignored — the write path here reads the row back through the same
   * accessor the guard uses, so the round trip has to actually round-trip.
   */
  let storedSettings: {
    id: string;
    key: string;
    version: number;
    updatedAt: Date;
    updatedByUserId: string | null;
    value: Record<string, unknown>;
  };

  const installSettingsRow = () => {
    storedSettings = {
      id: '99999999-9999-4999-8999-999999999999',
      key: 'global',
      version: 1,
      updatedAt: new Date(),
      updatedByUserId: null,
      value: structuredClone(
        DEFAULT_SYSTEM_SETTINGS,
      ) as unknown as Record<string, unknown>,
    };

    (context.prismaMock.systemSettings.findUnique as jest.Mock).mockImplementation(
      async () => storedSettings,
    );
    (context.prismaMock.systemSettings.update as jest.Mock).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        storedSettings = {
          ...storedSettings,
          ...data,
          version: storedSettings.version + 1,
        } as typeof storedSettings;
        return storedSettings;
      },
    );
    (context.prismaMock.systemSettings.upsert as jest.Mock).mockImplementation(
      async () => storedSettings,
    );
  };

  /** Put a window into the PERSISTED layer, the way an operator would. */
  const persistMaintenance = (value: Partial<SystemMaintenanceValue>) => {
    storedSettings.value.maintenance = {
      ...DEFAULT_SYSTEM_SETTINGS.maintenance,
      ...value,
    };
    maintenance.invalidateCache();
  };

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: DatabaseHealthIndicator, useValue: databaseIndicatorStub },
      ],
    });
    maintenance = context.module.get(MaintenanceModeService);
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    installSettingsRow();
    databaseProbe.mockClear();
    // The service caches its persisted read for a few seconds and holds any
    // in-memory override for the life of the process — neither may leak from
    // one test into the next.
    maintenance.setInMemoryOverride(null);
    maintenance.invalidateCache();
    delete process.env.MAINTENANCE_MODE;
  });

  // ===========================================================================
  // The 503 a blocked caller receives
  // ===========================================================================

  describe('the 503 response', () => {
    it('carries the stable marker, through the real exception filter', async () => {
      persistMaintenance({ enabled: true, message: 'Upgrading, back shortly' });

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .expect(503);

      // UNDER `details`, and that is the point of asserting it here rather than
      // against the guard: HttpExceptionFilter rebuilds every body from a fixed
      // key allowlist (statusCode, code, message, details, timestamp, path) and
      // derives `code` from the status. A marker written anywhere else would be
      // silently stripped on the way out and this test is what proves it is not.
      expect(response.body.details.reason).toBe(MAINTENANCE_ERROR_MARKER);
      expect(response.body.message).toBe('Upgrading, back shortly');
      expect(response.body.statusCode).toBe(503);
      expect(response.body.details.allowAdmins).toBe(true);
    });

    it('sets Retry-After, so a client backs off on a timer', async () => {
      persistMaintenance({ enabled: true });

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .expect(503);

      expect(response.headers['retry-after']).toBe(
        String(MAINTENANCE_RETRY_AFTER_SECONDS),
      );
      expect(response.body.details.retryAfterSeconds).toBe(
        MAINTENANCE_RETRY_AFTER_SECONDS,
      );
    });

    it('is distinguishable from an ordinary upstream 503', async () => {
      // No window: the same status from a genuinely failing dependency carries
      // neither the marker nor the header, which is the whole reason both exist.
      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .expect(401);

      expect(response.headers['retry-after']).toBeUndefined();
      expect(response.body.details?.reason).not.toBe(MAINTENANCE_ERROR_MARKER);
    });
  });

  // ===========================================================================
  // Who still gets through
  // ===========================================================================

  describe('the admin bypass', () => {
    it('lets an admin through while allowAdmins is true', async () => {
      const admin = await createMockAdminUser(context);
      persistMaintenance({ enabled: true, allowAdmins: true });

      await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);
    });

    it('blocks a non-admin even while allowAdmins is true', async () => {
      const viewer = await createMockViewerUser(context);
      persistMaintenance({ enabled: true, allowAdmins: true });

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(viewer.accessToken))
        .expect(503);

      expect(response.body.details.reason).toBe(MAINTENANCE_ERROR_MARKER);
    });

    it('blocks an admin when allowAdmins is false', async () => {
      const admin = await createMockAdminUser(context);
      persistMaintenance({ enabled: true, allowAdmins: false });

      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(admin.accessToken))
        .expect(503);
    });

    it.each(['pat_', 'nod_'])(
      'never grants the bypass to a %s bearer',
      async (prefix) => {
        // Opaque credentials belonging to unattended clients. They are blocked
        // regardless of allowAdmins — deliberately, since backing off is
        // exactly what an unattended client should do during a window.
        persistMaintenance({ enabled: true, allowAdmins: true });

        const response = await request(context.app.getHttpServer())
          .get('/api/users')
          .set('Authorization', `Bearer ${prefix}0123456789abcdef`)
          .expect(503);

        expect(response.body.details.reason).toBe(MAINTENANCE_ERROR_MARKER);
      },
    );

    it('does not authenticate: a blocked request never becomes a signed-in one', async () => {
      // `request.user` is never populated by the guard, so an admin who is let
      // through is still authenticated by JwtAuthGuard exactly as usual — and
      // an admin token with no permission for the route still gets a 403,
      // not a free pass.
      const admin = await createMockAdminUser(context);
      persistMaintenance({ enabled: true, allowAdmins: true });

      await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .expect(503);
    });
  });

  // ===========================================================================
  // The environment break-glass, end to end
  // ===========================================================================

  describe('the environment break-glass', () => {
    it('MAINTENANCE_MODE=false reopens an application locked by allowAdmins:false', async () => {
      const admin = await createMockAdminUser(context);
      persistMaintenance({ enabled: true, allowAdmins: false });

      await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(503);

      process.env.MAINTENANCE_MODE = 'false';

      await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);
    });

    it('MAINTENANCE_MODE=true closes an application whose stored flag is off', async () => {
      persistMaintenance({ enabled: false });
      process.env.MAINTENANCE_MODE = 'true';

      await request(context.app.getHttpServer()).get('/api/users').expect(503);
    });
  });

  // ===========================================================================
  // Health — deliberately asymmetric
  // ===========================================================================

  describe('health probes during a window', () => {
    it('keeps /api/health/live at 200, so nothing kills the container', async () => {
      persistMaintenance({ enabled: true });

      const response = await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      expect(response.body.data.status).toBe('ok');
    });

    it('reports 503 on /api/health/ready, so load balancers drain the instance', async () => {
      persistMaintenance({ enabled: true });

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);

      expect(response.body.details.reason).toBe(MAINTENANCE_ERROR_MARKER);
    });

    it('answers readiness BEFORE probing the database', async () => {
      // THE ORDERING IS THE REQUIREMENT. During the restore swap (#285) the
      // live database is renamed away, so the probe would fail on a connection
      // error and readiness would report 503 for a reason that reads like a
      // fault. Asserting the probe was never reached is the only way to pin
      // "before", and it is what makes readiness still correct in the one
      // window where storage genuinely is not there.
      persistMaintenance({ enabled: true });

      await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);

      expect(databaseProbe).not.toHaveBeenCalled();
    });

    it('probes the database as usual when no window is open', async () => {
      await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(databaseProbe).toHaveBeenCalledWith('database');
    });

    it('carries no Retry-After — that header is the guard’s contract with API clients', async () => {
      persistMaintenance({ enabled: true });

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);

      // Also what lets the reachable-set spec tell a route the guard BLOCKED
      // from a route that was reached and chose to report 503.
      expect(response.headers['retry-after']).toBeUndefined();
    });
  });

  // ===========================================================================
  // The admin API
  // ===========================================================================

  describe('GET /api/admin/maintenance', () => {
    it('requires system_settings:read', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get('/api/admin/maintenance')
        .expect(401);

      await request(context.app.getHttpServer())
        .get('/api/admin/maintenance')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('reports the effective state and every contributing layer', async () => {
      const admin = await createMockAdminUser(context);
      persistMaintenance({ enabled: true, message: 'Stored copy' });
      process.env.MAINTENANCE_MODE = 'false';

      const response = await request(context.app.getHttpServer())
        .get('/api/admin/maintenance')
        .set(authHeader(admin.accessToken))
        .expect(200);

      // The question this endpoint exists to answer: "I turned it off and it
      // is still on — why?". The effective answer alone could not say.
      expect(response.body.data.enabled).toBe(false);
      expect(response.body.data.source).toBe('env');
      expect(response.body.data.layers.env).toEqual({
        present: true,
        enabled: false,
      });
      expect(response.body.data.layers.persisted.value.enabled).toBe(true);
      expect(response.body.data.layers.memory).toEqual({
        present: false,
        override: null,
      });
    });

    it('reports an in-memory override as its own layer', async () => {
      const admin = await createMockAdminUser(context);
      maintenance.setInMemoryOverride({
        enabled: true,
        message: 'Restoring database',
      });

      const response = await request(context.app.getHttpServer())
        .get('/api/admin/maintenance')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.source).toBe('memory');
      expect(response.body.data.layers.memory.override).toEqual({
        enabled: true,
        message: 'Restoring database',
      });
    });
  });

  describe('PUT /api/admin/maintenance', () => {
    it('requires system_settings:write', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .put('/api/admin/maintenance')
        .send({ enabled: true })
        .expect(401);

      await request(context.app.getHttpServer())
        .put('/api/admin/maintenance')
        .set(authHeader(viewer.accessToken))
        .send({ enabled: true })
        .expect(403);
    });

    it('rejects a body with no `enabled`', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put('/api/admin/maintenance')
        .set(authHeader(admin.accessToken))
        .send({ message: 'no enabled field' })
        .expect(400);
    });

    it('opens a window, stamps its provenance, and audits it', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .put('/api/admin/maintenance')
        .set(authHeader(admin.accessToken))
        .send({ enabled: true, message: 'Upgrading', allowAdmins: true })
        .expect(200);

      expect(response.body.data.enabled).toBe(true);

      const written = (context.prismaMock.systemSettings.update as jest.Mock).mock
        .calls[0][0].data.value.maintenance;
      expect(written).toMatchObject({
        enabled: true,
        message: 'Upgrading',
        allowAdmins: true,
        startedById: admin.id,
      });
      expect(typeof written.startedAt).toBe('string');

      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'maintenance:enable',
          targetType: 'maintenance',
          actorUserId: admin.id,
        }),
      });
    });

    it('closes a window and clears its provenance', async () => {
      const admin = await createMockAdminUser(context);
      persistMaintenance({
        enabled: true,
        startedAt: '2026-01-01T00:00:00.000Z',
        startedById: admin.id,
      });

      await request(context.app.getHttpServer())
        .put('/api/admin/maintenance')
        .set(authHeader(admin.accessToken))
        .send({ enabled: false })
        .expect(200);

      const written = (context.prismaMock.systemSettings.update as jest.Mock).mock
        .calls[0][0].data.value.maintenance;
      expect(written).toMatchObject({
        enabled: false,
        startedAt: null,
        startedById: null,
      });

      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'maintenance:disable' }),
      });
    });

    it('is reachable while a window is open — the switch that turns it off', async () => {
      const admin = await createMockAdminUser(context);
      persistMaintenance({ enabled: true, allowAdmins: false });

      // Blocked everywhere else, including for this admin...
      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(admin.accessToken))
        .expect(503);

      // ...but the maintenance endpoints themselves are exempt, so an admin
      // whose bypass was switched off can still close the window through the
      // API rather than through the environment.
      await request(context.app.getHttpServer())
        .put('/api/admin/maintenance')
        .set(authHeader(admin.accessToken))
        .send({ enabled: false })
        .expect(200);
    });
  });
});
