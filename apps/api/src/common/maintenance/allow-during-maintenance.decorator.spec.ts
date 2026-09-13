import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ALLOW_DURING_MAINTENANCE_KEY,
  AllowDuringMaintenance,
} from './allow-during-maintenance.decorator';

describe('AllowDuringMaintenance', () => {
  const reflector = new Reflector();

  @Controller('exempt-controller')
  @AllowDuringMaintenance()
  class ExemptController {
    @Get('a')
    a() {}
  }

  @Controller('guarded-controller')
  class PartlyExemptController {
    @Get('a')
    @AllowDuringMaintenance()
    exempt() {}

    @Get('b')
    guarded() {}
  }

  it('marks a whole controller, covering every route on it', () => {
    const value = reflector.getAllAndOverride<boolean>(
      ALLOW_DURING_MAINTENANCE_KEY,
      [ExemptController.prototype.a, ExemptController],
    );

    expect(value).toBe(true);
  });

  it('marks a single route', () => {
    const value = reflector.getAllAndOverride<boolean>(
      ALLOW_DURING_MAINTENANCE_KEY,
      [PartlyExemptController.prototype.exempt, PartlyExemptController],
    );

    expect(value).toBe(true);
  });

  it('leaves everything else unmarked — blocked is the default', () => {
    const value = reflector.getAllAndOverride<boolean>(
      ALLOW_DURING_MAINTENANCE_KEY,
      [PartlyExemptController.prototype.guarded, PartlyExemptController],
    );

    expect(value).toBeUndefined();
  });
});
