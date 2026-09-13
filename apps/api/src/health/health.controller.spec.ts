import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckService, HealthCheckResult } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { MaintenanceModeService } from '../common/maintenance/maintenance-mode.service';
import { MAINTENANCE_ERROR_MARKER } from '../common/maintenance/maintenance.guard';

describe('HealthController', () => {
  let controller: HealthController;
  let mockHealthCheckService: jest.Mocked<HealthCheckService>;
  let mockDatabaseIndicator: jest.Mocked<DatabaseHealthIndicator>;
  let mockMaintenance: { isEnabled: jest.Mock };

  beforeEach(async () => {
    mockHealthCheckService = {
      check: jest.fn(),
    } as any;

    mockDatabaseIndicator = {
      isHealthy: jest.fn(),
    } as any;

    // Off by default: every existing expectation below describes an
    // application that is open for business.
    mockMaintenance = { isEnabled: jest.fn().mockResolvedValue(false) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: mockHealthCheckService },
        { provide: DatabaseHealthIndicator, useValue: mockDatabaseIndicator },
        { provide: MaintenanceModeService, useValue: mockMaintenance },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  describe('liveness', () => {
    it('should return liveness status', () => {
      const result = controller.liveness();

      expect(result).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should return valid ISO timestamp', () => {
      const result = controller.liveness();
      const timestamp = new Date(result.timestamp);

      expect(timestamp.toISOString()).toBe(result.timestamp);
    });
  });

  describe('readiness', () => {
    it('should call health check service with database indicator', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.readiness();

      expect(mockHealthCheckService.check).toHaveBeenCalledWith([
        expect.any(Function),
      ]);
      expect(result).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should return status "ok" when database is healthy', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.readiness();

      expect(result.status).toBe('ok');
      expect(result.info?.database?.status).toBe('up');
    });

    it('should return status "error" when database is unhealthy', async () => {
      const mockResult: HealthCheckResult = {
        status: 'error',
        info: {},
        error: {
          database: {
            status: 'down',
            message: 'Connection refused',
          },
        },
        details: {
          database: {
            status: 'down',
            message: 'Connection refused',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.readiness();

      expect(result.status).toBe('error');
      expect(result.error?.database?.status).toBe('down');
    });

    it('should include timestamp in response', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.readiness();

      expect(result.timestamp).toBeDefined();
      const timestamp = new Date(result.timestamp);
      expect(timestamp.toISOString()).toBe(result.timestamp);
    });
  });

  describe('fullHealth', () => {
    it('should call health check service with all indicators', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.fullHealth();

      expect(mockHealthCheckService.check).toHaveBeenCalledWith([
        expect.any(Function),
      ]);
      expect(result).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should return aggregated health status when all services healthy', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.fullHealth();

      expect(result.status).toBe('ok');
      expect(result.info).toBeDefined();
    });

    it('should return aggregated health status when any service unhealthy', async () => {
      const mockResult: HealthCheckResult = {
        status: 'error',
        info: {},
        error: {
          database: {
            status: 'down',
            message: 'Database connection timeout',
          },
        },
        details: {
          database: {
            status: 'down',
            message: 'Database connection timeout',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.fullHealth();

      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
      expect(result.error?.database?.status).toBe('down');
    });

    it('should include timestamp in response', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.fullHealth();

      expect(result.timestamp).toBeDefined();
      const timestamp = new Date(result.timestamp);
      expect(timestamp.toISOString()).toBe(result.timestamp);
    });

    it('should include all indicator details in response', async () => {
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: {
          database: {
            status: 'up',
            responseTime: '15ms',
          },
        },
        error: {},
        details: {
          database: {
            status: 'up',
            responseTime: '15ms',
          },
        },
      };

      mockHealthCheckService.check.mockResolvedValue(mockResult);

      const result = await controller.fullHealth();

      expect(result.info?.database).toMatchObject({
        status: 'up',
        responseTime: '15ms',
      });
    });
  });

  // ===========================================================================
  // Maintenance mode (#257, epic #254) — deliberately asymmetric
  // ===========================================================================

  describe('during a maintenance window', () => {
    beforeEach(() => {
      mockMaintenance.isEnabled.mockResolvedValue(true);
    });

    it('keeps liveness at 200, so nothing kills the container mid-upgrade', () => {
      // Liveness means "this process is not hung", which is still true. An
      // orchestrator told otherwise would restart the container in the middle
      // of the very upgrade the window was opened for.
      expect(controller.liveness()).toMatchObject({ status: 'ok' });
    });

    it('reports readiness as 503, carrying the marker under details', async () => {
      await expect(controller.readiness()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      try {
        await controller.readiness();
      } catch (error) {
        const body = (error as ServiceUnavailableException).getResponse() as {
          details: { reason: string };
        };
        expect(body.details.reason).toBe(MAINTENANCE_ERROR_MARKER);
      }
    });

    it('answers readiness BEFORE the database probe', async () => {
      // The ordering is the requirement, not an optimisation: during the
      // restore swap (#285) the live database is renamed away, so the probe
      // would fail on a connection error and readiness would report 503 for a
      // reason that reads like a fault.
      await expect(controller.readiness()).rejects.toThrow();

      expect(mockHealthCheckService.check).not.toHaveBeenCalled();
      expect(mockDatabaseIndicator.isHealthy).not.toHaveBeenCalled();
    });

    it('leaves the full health check to report on dependencies as usual', async () => {
      // `/api/health` is a diagnostic, not a traffic signal. During a window
      // the honest answer is whatever its dependencies actually say — which,
      // during the swap, is "the database is not there".
      const mockResult: HealthCheckResult = {
        status: 'ok',
        info: { database: { status: 'up' } },
        error: {},
        details: { database: { status: 'up' } },
      };
      mockHealthCheckService.check.mockResolvedValue(mockResult);

      await expect(controller.fullHealth()).resolves.toMatchObject({
        status: 'ok',
      });
    });
  });
});
