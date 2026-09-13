import { PERMISSIONS_KEY } from '../../auth/decorators/permissions.decorator';
import { PERMISSIONS } from '../constants/roles.constants';
import { ALLOW_DURING_MAINTENANCE_KEY } from './allow-during-maintenance.decorator';
import { MaintenanceController } from './maintenance.controller';
import type {
  MaintenanceModeService,
  MaintenanceStatus,
} from './maintenance-mode.service';
import { maintenanceStatusSchema } from './dto/update-maintenance.dto';

describe('MaintenanceController', () => {
  const status: MaintenanceStatus = {
    enabled: true,
    message: 'Down for maintenance',
    allowAdmins: true,
    startedAt: '2026-01-01T00:00:00.000Z',
    startedById: '33333333-3333-4333-8333-333333333333',
    source: 'persisted',
    layers: {
      env: { present: false, enabled: null },
      memory: { present: false, override: null },
      persisted: {
        readable: true,
        value: {
          enabled: true,
          message: 'Down for maintenance',
          allowAdmins: true,
          startedAt: '2026-01-01T00:00:00.000Z',
          startedById: '33333333-3333-4333-8333-333333333333',
        },
      },
    },
  };

  let service: { resolve: jest.Mock; setMaintenance: jest.Mock };
  let controller: MaintenanceController;

  beforeEach(() => {
    service = {
      resolve: jest.fn().mockResolvedValue(status),
      setMaintenance: jest.fn().mockResolvedValue(status),
    };
    controller = new MaintenanceController(
      service as unknown as MaintenanceModeService,
    );
  });

  describe('GET', () => {
    it('reads past the cache, so an operator is never shown a stale switch', async () => {
      await controller.getMaintenance();

      expect(service.resolve).toHaveBeenCalledWith({ fresh: true });
    });

    it('publishes every contributing layer, not just the effective answer', async () => {
      const body = await controller.getMaintenance();

      // Parsed through the published schema rather than eyeballed, so the
      // response and its OpenAPI contract cannot drift apart unnoticed.
      const parsed = maintenanceStatusSchema.parse(body);
      expect(parsed.layers.env).toEqual({ present: false, enabled: null });
      expect(parsed.layers.memory).toEqual({ present: false, override: null });
      expect(parsed.layers.persisted.readable).toBe(true);
      expect(parsed.source).toBe('persisted');
    });
  });

  describe('PUT', () => {
    it('forwards the body and the acting user', async () => {
      await controller.setMaintenance(
        { enabled: true, message: 'Upgrading', allowAdmins: false } as never,
        'actor-id',
      );

      expect(service.setMaintenance).toHaveBeenCalledWith(
        { enabled: true, message: 'Upgrading', allowAdmins: false },
        'actor-id',
      );
    });

    it('passes omitted fields through as undefined rather than inventing values', async () => {
      await controller.setMaintenance({ enabled: false } as never, 'actor-id');

      expect(service.setMaintenance).toHaveBeenCalledWith(
        { enabled: false, message: undefined, allowAdmins: undefined },
        'actor-id',
      );
    });
  });

  describe('authorization metadata', () => {
    it('gates the read on system_settings:read', () => {
      expect(
        Reflect.getMetadata(
          PERMISSIONS_KEY,
          MaintenanceController.prototype.getMaintenance,
        ),
      ).toEqual([PERMISSIONS.SYSTEM_SETTINGS_READ]);
    });

    it('gates the write on system_settings:write', () => {
      // NO DEDICATED `maintenance:manage`. This is a system setting stored in
      // the `maintenance` namespace of the system settings row, and that
      // permission pair already means "may change global application
      // behaviour" — a new permission would protect nothing it does not, while
      // adding one more thing to seed and to get wrong.
      expect(
        Reflect.getMetadata(
          PERMISSIONS_KEY,
          MaintenanceController.prototype.setMaintenance,
        ),
      ).toEqual([PERMISSIONS.SYSTEM_SETTINGS_WRITE]);
    });

    it('is itself reachable during a window — the switch that turns it off', () => {
      expect(
        Reflect.getMetadata(ALLOW_DURING_MAINTENANCE_KEY, MaintenanceController),
      ).toBe(true);
    });
  });
});
