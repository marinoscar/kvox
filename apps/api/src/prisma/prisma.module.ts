import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PrismaSystemService } from './prisma-system.service';
// PLATFORM-ADOPTION-SHIM(#469): global so every module that touches a
// storage object's `managed_by` / `part_size` reaches the store without each
// one importing it; deleting the shim is then a one-file change here.
import { LegacyObjectOwnershipStore } from '../storage/legacy-object-ownership.store';

@Global()
@Module({
  providers: [PrismaService, PrismaSystemService, LegacyObjectOwnershipStore],
  exports: [PrismaService, PrismaSystemService, LegacyObjectOwnershipStore],
})
export class PrismaModule {}
