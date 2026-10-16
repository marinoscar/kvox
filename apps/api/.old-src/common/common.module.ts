import { Module } from '@nestjs/common';
import { AdminBootstrapService } from './services/admin-bootstrap.service';
import { RegistryFreezeService } from './registry/registry-freeze.service';

@Module({
  providers: [AdminBootstrapService, RegistryFreezeService],
  exports: [AdminBootstrapService],
})
export class CommonModule {}
