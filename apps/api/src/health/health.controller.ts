import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
} from '@nestjs/terminus';
import { Public } from '../auth/decorators/public.decorator';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { AllowDuringMaintenance } from '../common/maintenance/allow-during-maintenance.decorator';
import { MaintenanceModeService } from '../common/maintenance/maintenance-mode.service';
import {
  MAINTENANCE_ERROR_MARKER,
  MAINTENANCE_RETRY_AFTER_SECONDS,
} from '../common/maintenance/maintenance.guard';

/**
 * DELIBERATELY ASYMMETRIC UNDER MAINTENANCE (#257, epic #254).
 *
 * The whole controller is exempt from the maintenance guard — every route on it
 * is a probe, and a probe that answers 503 because it was BLOCKED tells an
 * orchestrator nothing about the process it is probing. What each probe reports
 * during a window is then decided route by route, below, and the two answers
 * are deliberately different:
 *
 *   * `live` stays 200. Liveness means "this process is not hung"; that is
 *     still true during a window, and reporting otherwise would have the
 *     orchestrator KILL AND RESTART THE CONTAINER in the middle of the very
 *     upgrade the window was opened for.
 *   * `ready` reports 503. Readiness means "send me traffic", which is exactly
 *     what must not happen, so a load balancer drains this instance instead.
 */
@ApiTags('Health')
@Controller('health')
@AllowDuringMaintenance()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DatabaseHealthIndicator,
    private readonly maintenance: MaintenanceModeService,
  ) {}

  @Get('live')
  @Public()
  @ApiOperation({
    summary: 'Liveness probe',
    description: 'Checks if the application process is running. Used by orchestrators to detect hung processes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Application is alive',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  liveness() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @Public()
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe',
    description: 'Checks if the application is ready to receive traffic. Includes database connectivity check.',
  })
  @ApiResponse({
    status: 200,
    description: 'Application is ready',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        info: {
          type: 'object',
          properties: {
            database: {
              type: 'object',
              properties: {
                status: { type: 'string', example: 'up' },
              },
            },
          },
        },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'Application is not ready',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'error' },
        error: {
          type: 'object',
          properties: {
            database: {
              type: 'object',
              properties: {
                status: { type: 'string', example: 'down' },
                message: { type: 'string' },
              },
            },
          },
        },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  async readiness(): Promise<HealthCheckResult & { timestamp: string }> {
    // ------------------------------------------------------------------------
    // BEFORE THE DATABASE PROBE, and that ordering is the requirement.
    // ------------------------------------------------------------------------
    //
    // The case this exists for is the restore swap (#285), which renames the
    // live database out from under this process: for those seconds there is no
    // database under the expected name, the probe below would fail on a
    // connection error, and readiness would report 503 for a reason that reads
    // like a fault. Answering the maintenance question first means this
    // instance drains for the reason that is actually true, with a body that
    // says so — and it means readiness keeps answering correctly at the one
    // moment the probe cannot reach storage at all.
    //
    // `resolve()` never throws: an unreadable row degrades to the last known
    // state (see MaintenanceModeService.readPersisted), so this cannot turn a
    // database outage into a 500 on the readiness probe.
    if (await this.maintenance.isEnabled()) {
      throw new ServiceUnavailableException({
        message: 'Service is in maintenance mode',
        // Same marker the guard puts on a blocked request, under `details` for
        // the same reason — `HttpExceptionFilter` rebuilds bodies from a fixed
        // key allowlist and would strip a custom top-level field. No
        // `Retry-After` header here, though: that header is the guard's
        // contract with API CLIENTS, and this response is read by probes.
        details: {
          reason: MAINTENANCE_ERROR_MARKER,
          retryAfterSeconds: MAINTENANCE_RETRY_AFTER_SECONDS,
        },
      });
    }

    const result = await this.health.check([
      () => this.db.isHealthy('database'),
    ]);

    return {
      ...result,
      timestamp: new Date().toISOString(),
    };
  }

  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({
    summary: 'Full health check',
    description: 'Comprehensive health check including all dependencies.',
  })
  @ApiResponse({ status: 200, description: 'All checks passed' })
  @ApiResponse({ status: 503, description: 'One or more checks failed' })
  async fullHealth(): Promise<HealthCheckResult & { timestamp: string }> {
    const result = await this.health.check([
      () => this.db.isHealthy('database'),
      // Add more indicators here as needed:
      // () => this.redis.isHealthy('redis'),
      // () => this.external.isHealthy('external-api'),
    ]);

    return {
      ...result,
      timestamp: new Date().toISOString(),
    };
  }
}
