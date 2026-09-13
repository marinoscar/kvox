import type { PrismaService } from '../../prisma/prisma.service';
import type { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../types/settings.types';
import type { SystemMaintenanceValue } from '../schemas/settings.schema';
import {
  MAINTENANCE_AUDIT_DISABLE,
  MAINTENANCE_AUDIT_ENABLE,
  MAINTENANCE_AUDIT_TARGET_ID,
  MAINTENANCE_AUDIT_TARGET_TYPE,
  MAINTENANCE_PERSISTED_CACHE_MS,
  MaintenanceModeService,
} from './maintenance-mode.service';

/**
 * Unit tests for the three-layer resolution.
 *
 * The layering is the part of this feature that can be wrong in a way nobody
 * notices until it matters — an override that is read with `||` instead of
 * `??`, an env value that is truthy-checked, a cache that outlives a write —
 * and every one of those failures shows up as "the application would not come
 * back". So the resolution order is pinned layer by layer, in both directions,
 * rather than only in the happy case.
 */
describe('MaintenanceModeService', () => {
  let systemSettings: {
    getMaintenancePolicy: jest.Mock;
    patchSettings: jest.Mock;
  };
  let prisma: { auditEvent: { create: jest.Mock } };
  let service: MaintenanceModeService;
  let envBefore: string | undefined;

  const persisted = (
    overrides: Partial<SystemMaintenanceValue> = {},
  ): SystemMaintenanceValue => ({
    ...DEFAULT_SYSTEM_SETTINGS.maintenance,
    ...overrides,
  });

  beforeEach(() => {
    envBefore = process.env.MAINTENANCE_MODE;
    delete process.env.MAINTENANCE_MODE;

    systemSettings = {
      getMaintenancePolicy: jest.fn().mockResolvedValue(persisted()),
      patchSettings: jest.fn().mockResolvedValue(undefined),
    };
    prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };

    service = new MaintenanceModeService(
      systemSettings as unknown as SystemSettingsService,
      prisma as unknown as PrismaService,
    );
  });

  afterEach(() => {
    if (envBefore === undefined) {
      delete process.env.MAINTENANCE_MODE;
    } else {
      process.env.MAINTENANCE_MODE = envBefore;
    }
    jest.useRealTimers();
  });

  // ===========================================================================
  // Layer 3 — the persisted setting
  // ===========================================================================

  describe('the persisted layer', () => {
    it('reports the stored window when nothing overrides it', async () => {
      systemSettings.getMaintenancePolicy.mockResolvedValue(
        persisted({
          enabled: true,
          message: 'Back at 03:00 UTC',
          allowAdmins: false,
          startedAt: '2026-01-01T00:00:00.000Z',
          startedById: '11111111-1111-4111-8111-111111111111',
        }),
      );

      const state = await service.resolve();

      expect(state).toMatchObject({
        enabled: true,
        message: 'Back at 03:00 UTC',
        allowAdmins: false,
        startedAt: '2026-01-01T00:00:00.000Z',
        startedById: '11111111-1111-4111-8111-111111111111',
        source: 'persisted',
      });
      expect(state.layers.persisted.readable).toBe(true);
    });

    it('defaults to open for business', async () => {
      expect((await service.resolve()).enabled).toBe(false);
    });
  });

  // ===========================================================================
  // Layer 2 — the in-memory override (the restore swap's layer)
  // ===========================================================================

  describe('the in-memory override', () => {
    it('outranks a persisted window that says the application is up', async () => {
      service.setInMemoryOverride({ enabled: true, message: 'Swapping database' });

      const state = await service.resolve();

      expect(state.enabled).toBe(true);
      expect(state.message).toBe('Swapping database');
      expect(state.source).toBe('memory');
    });

    it('falls back to the persisted message and allowAdmins when it carries none', async () => {
      systemSettings.getMaintenancePolicy.mockResolvedValue(
        persisted({ message: 'Stored copy', allowAdmins: false }),
      );
      service.setInMemoryOverride({ enabled: true });

      const state = await service.resolve();

      expect(state.message).toBe('Stored copy');
      expect(state.allowAdmins).toBe(false);
    });

    it('is cleared with null and leaves the persisted layer deciding again', async () => {
      service.setInMemoryOverride({ enabled: true });
      service.setInMemoryOverride(null);

      const state = await service.resolve();

      expect(state.enabled).toBe(false);
      expect(state.source).toBe('persisted');
      expect(state.layers.memory).toEqual({ present: false, override: null });
    });
  });

  // ===========================================================================
  // Layer 1 — the environment break-glass
  // ===========================================================================

  describe('the environment override', () => {
    // THE ACCEPTANCE CRITERION. This is the documented way out of a window
    // opened with `allowAdmins: false`, in which the endpoint that would turn
    // it off is itself unreachable. If this ever stops working, the recovery
    // procedure in docs/runbooks/maintenance-mode.md is a lie and the only
    // remaining fix is editing JSONB in the database by hand.
    it('MAINTENANCE_MODE=false overrides a persisted enabled window', async () => {
      systemSettings.getMaintenancePolicy.mockResolvedValue(
        persisted({ enabled: true, allowAdmins: false }),
      );
      process.env.MAINTENANCE_MODE = 'false';

      const state = await service.resolve();

      expect(state.enabled).toBe(false);
      expect(state.source).toBe('env');
      // The layer it overrode is still reported, which is what makes the
      // override visible to the operator rather than merely effective.
      expect(state.layers.persisted.value.enabled).toBe(true);
      expect(state.layers.env).toEqual({ present: true, enabled: false });
    });

    it('MAINTENANCE_MODE=false also overrides an in-memory override', async () => {
      service.setInMemoryOverride({ enabled: true });
      process.env.MAINTENANCE_MODE = 'false';

      const state = await service.resolve();

      expect(state.enabled).toBe(false);
      expect(state.source).toBe('env');
      expect(state.layers.memory.present).toBe(true);
    });

    it('MAINTENANCE_MODE=true forces a window open over a stored one that is off', async () => {
      process.env.MAINTENANCE_MODE = 'true';

      const state = await service.resolve();

      expect(state.enabled).toBe(true);
      expect(state.source).toBe('env');
      // It carries a boolean and nothing else, so the operator's stored copy
      // and stored allowAdmins still apply.
      expect(state.message).toBe(DEFAULT_SYSTEM_SETTINGS.maintenance.message);
      expect(state.allowAdmins).toBe(true);
    });

    it.each(['1', '0', 'yes', 'no', 'TRUE', 'False', 'on', 'off', ''])(
      'treats %p as no override at all',
      async (value) => {
        systemSettings.getMaintenancePolicy.mockResolvedValue(
          persisted({ enabled: true }),
        );
        process.env.MAINTENANCE_MODE = value;

        const state = await service.resolve();

        // Not merely "still enabled" — the SOURCE must show the environment
        // took no part. A truthiness check here would turn `off` into an
        // outage and `0` into an unplanned recovery.
        expect(state.source).toBe('persisted');
        expect(state.enabled).toBe(true);
        expect(service.readEnvOverride()).toBeNull();
      },
    );

    it('is unset by default, and reports that it is absent', async () => {
      expect(service.readEnvOverride()).toBeNull();
      expect((await service.resolve()).layers.env).toEqual({
        present: false,
        enabled: null,
      });
    });
  });

  // ===========================================================================
  // Reading through a database that is not there
  // ===========================================================================

  describe('when the persisted layer cannot be read', () => {
    it('does not throw, and degrades to the last known state', async () => {
      systemSettings.getMaintenancePolicy.mockResolvedValue(
        persisted({ message: 'Known copy' }),
      );
      await service.resolve();

      systemSettings.getMaintenancePolicy.mockRejectedValue(
        new Error('database "appdb" does not exist'),
      );
      const state = await service.resolve({ fresh: true });

      expect(state.layers.persisted.readable).toBe(false);
      expect(state.message).toBe('Known copy');
      expect(state.enabled).toBe(false);
    });

    it('degrades to the seeded defaults when it has never read successfully', async () => {
      systemSettings.getMaintenancePolicy.mockRejectedValue(new Error('down'));

      const state = await service.resolve();

      expect(state.layers.persisted.readable).toBe(false);
      expect(state.layers.persisted.value).toEqual(
        DEFAULT_SYSTEM_SETTINGS.maintenance,
      );
    });

    it('still honours the in-memory override — the swap window case', async () => {
      // This is the whole reason the memory layer exists: the persisted flag
      // lives inside the database being renamed, so at this exact moment it is
      // unreadable and only this layer can hold traffic back.
      systemSettings.getMaintenancePolicy.mockRejectedValue(new Error('gone'));
      service.setInMemoryOverride({
        enabled: true,
        message: 'Restoring database',
        allowAdmins: false,
      });

      const state = await service.resolve();

      expect(state.enabled).toBe(true);
      expect(state.message).toBe('Restoring database');
      expect(state.allowAdmins).toBe(false);
      expect(state.source).toBe('memory');
    });

    it('does not hand out the shared defaults object for a caller to mutate', async () => {
      systemSettings.getMaintenancePolicy.mockRejectedValue(new Error('down'));

      const state = await service.resolve();
      state.layers.persisted.value.enabled = true;

      expect(DEFAULT_SYSTEM_SETTINGS.maintenance.enabled).toBe(false);
    });
  });

  // ===========================================================================
  // The cache in front of the persisted read
  // ===========================================================================

  describe('the persisted read cache', () => {
    it('reuses a recent read, because this runs on every request', async () => {
      jest.useFakeTimers();

      await service.resolve();
      await service.resolve();

      expect(systemSettings.getMaintenancePolicy).toHaveBeenCalledTimes(1);
    });

    it('consults the row again once the window has passed', async () => {
      jest.useFakeTimers();

      await service.resolve();
      jest.advanceTimersByTime(MAINTENANCE_PERSISTED_CACHE_MS + 1);
      await service.resolve();

      expect(systemSettings.getMaintenancePolicy).toHaveBeenCalledTimes(2);
    });

    it('is bypassed by `fresh`, which is what the admin GET uses', async () => {
      await service.resolve();
      await service.resolve({ fresh: true });

      expect(systemSettings.getMaintenancePolicy).toHaveBeenCalledTimes(2);
    });

    it('is dropped by invalidateCache', async () => {
      await service.resolve();
      service.invalidateCache();
      await service.resolve();

      expect(systemSettings.getMaintenancePolicy).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // Writing
  // ===========================================================================

  describe('setMaintenance', () => {
    const actor = '22222222-2222-4222-8222-222222222222';

    it('opens a window, stamping who opened it and when', async () => {
      await service.setMaintenance(
        { enabled: true, message: 'Upgrading', allowAdmins: true },
        actor,
      );

      const [body, userId] = systemSettings.patchSettings.mock.calls[0];
      expect(userId).toBe(actor);
      expect(body.maintenance).toMatchObject({
        enabled: true,
        message: 'Upgrading',
        allowAdmins: true,
        startedById: actor,
      });
      expect(typeof body.maintenance.startedAt).toBe('string');
    });

    it('leaves the original start alone when the window is already open', async () => {
      systemSettings.getMaintenancePolicy.mockResolvedValue(
        persisted({
          enabled: true,
          startedAt: '2026-01-01T00:00:00.000Z',
          startedById: actor,
        }),
      );

      await service.setMaintenance({ enabled: true, message: 'New copy' }, actor);

      // Absent, not re-stamped: editing the message of a window that is
      // already holding traffic must not reset how long it has been holding it.
      const { maintenance } = systemSettings.patchSettings.mock.calls[0][0];
      expect(maintenance).not.toHaveProperty('startedAt');
      expect(maintenance).not.toHaveProperty('startedById');
    });

    it('clears the provenance when the window is closed', async () => {
      systemSettings.getMaintenancePolicy.mockResolvedValue(
        persisted({ enabled: true, startedAt: '2026-01-01T00:00:00.000Z' }),
      );

      await service.setMaintenance({ enabled: false }, actor);

      const { maintenance } = systemSettings.patchSettings.mock.calls[0][0];
      expect(maintenance).toMatchObject({
        enabled: false,
        startedAt: null,
        startedById: null,
      });
    });

    it('sends only the fields the caller supplied', async () => {
      await service.setMaintenance({ enabled: false }, actor);

      const { maintenance } = systemSettings.patchSettings.mock.calls[0][0];
      expect(maintenance).not.toHaveProperty('message');
      expect(maintenance).not.toHaveProperty('allowAdmins');
    });

    it('records an audit event when a window is opened', async () => {
      await service.setMaintenance(
        { enabled: true, allowAdmins: false },
        actor,
      );

      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: actor,
          action: MAINTENANCE_AUDIT_ENABLE,
          targetType: MAINTENANCE_AUDIT_TARGET_TYPE,
          targetId: MAINTENANCE_AUDIT_TARGET_ID,
          meta: expect.objectContaining({
            enabled: true,
            previouslyEnabled: false,
            allowAdmins: false,
          }),
        }),
      });
    });

    it('records an audit event when a window is closed', async () => {
      systemSettings.getMaintenancePolicy.mockResolvedValue(
        persisted({ enabled: true }),
      );

      await service.setMaintenance({ enabled: false }, actor);

      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: MAINTENANCE_AUDIT_DISABLE,
          meta: expect.objectContaining({
            enabled: false,
            previouslyEnabled: true,
          }),
        }),
      });
    });

    it('writes through the settings service, never straight to the row', async () => {
      await service.setMaintenance({ enabled: true }, actor);

      // The settings service owns the merge, the unknown-key preservation and
      // the version counter. A second writer to that JSONB column would be a
      // second chance to destroy a key this build does not model.
      expect(systemSettings.patchSettings).toHaveBeenCalledTimes(1);
    });

    it('does not serve a stale cached value to the very next request', async () => {
      jest.useFakeTimers();
      await service.resolve();
      systemSettings.getMaintenancePolicy.mockResolvedValue(
        persisted({ enabled: true }),
      );

      await service.setMaintenance({ enabled: true }, actor);
      const state = await service.resolve();

      expect(state.enabled).toBe(true);
    });
  });

  describe('isEnabled', () => {
    it('ignores allowAdmins, because a probe carries no token', async () => {
      systemSettings.getMaintenancePolicy.mockResolvedValue(
        persisted({ enabled: true, allowAdmins: true }),
      );

      expect(await service.isEnabled()).toBe(true);
    });
  });
});
