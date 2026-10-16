// =============================================================================
// KvoxObjectsModule (issue #469)
// =============================================================================
//
// The storage gateway: `KvoxManagedObjectsService` is the only code that
// reads `storage_objects` for the domain modules. Agents add their own
// providers and controllers here (the multipart routes, the files route, the
// upload processor).
//
// `storageModule` (the platform's, `platform/storage/storage.config.ts`) exports
// `ObjectsService`; the provider token `STORAGE_PROVIDER` comes from
// `StorageProvidersModule`.
// =============================================================================

import { Module } from '@nestjs/common';
import { StorageProvidersModule } from '@marinoscar/platform-api/storage';

import { storageModule } from '../platform/storage/storage.config';
import { KvoxManagedObjectsService } from './kvox-managed-objects.service';
import { KvoxObjectOwnershipStore } from './kvox-object-ownership.store';
import { FilesPurgeUnmanagedHandler } from './files-purge-unmanaged.handler';
import { KvoxFilesController } from './kvox-files.controller';
import { KvoxMultipartController } from './kvox-multipart.controller';
import { KvoxS3PartLister } from './kvox-s3-part-lister';
import { ManagedDeleteVeto } from './managed-delete.hook';

@Module({
  imports: [storageModule, StorageProvidersModule],
  controllers: [KvoxMultipartController, KvoxFilesController],
  providers: [
    KvoxObjectOwnershipStore,
    KvoxManagedObjectsService,
    KvoxS3PartLister,
    ManagedDeleteVeto,
    // `files.purge_unmanaged` (#480): the Danger Zone's `files` category.
    FilesPurgeUnmanagedHandler,
  ],
  // Re-exports the platform's providers module and `ObjectsService` so a domain
  // module imports ONE module for everything storage-shaped.
  exports: [KvoxObjectOwnershipStore, KvoxManagedObjectsService, KvoxS3PartLister, StorageProvidersModule, storageModule],
})
export class KvoxObjectsModule {}
