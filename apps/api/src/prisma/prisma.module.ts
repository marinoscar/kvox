import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
// PLATFORM-ADOPTION-SHIM(#469): global so every module that touches a
// storage object's `managed_by` / `part_size` reaches the store without each
// one importing it; deleting the shim is then a one-file change here.
import { LegacyObjectOwnershipStore } from '../storage/legacy-object-ownership.store';

@Global()
@Module({
  providers: [PrismaService, LegacyObjectOwnershipStore],
  exports: [PrismaService, LegacyObjectOwnershipStore],
})
export class PrismaModule {}
