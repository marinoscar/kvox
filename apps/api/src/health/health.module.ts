import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { MaintenanceModule } from '../common/maintenance/maintenance.module';

@Module({
  // MaintenanceModule (#257) for `MaintenanceModeService`: the readiness probe
  // answers the maintenance question BEFORE the database probe. The edge goes
  // one way — nothing in the maintenance graph knows this module exists.
  imports: [TerminusModule, MaintenanceModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator],
})
export class HealthModule {}
