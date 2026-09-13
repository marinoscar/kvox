import { Module } from '@nestjs/common';
import { StorageProvidersModule } from './providers/storage-providers.module';
import { ObjectProcessingModule } from './processing/object-processing.module';
import { CommonModule } from '../common/common.module';
import { ObjectsController } from './objects/objects.controller';
import { ObjectsService } from './objects/objects.service';
import { StorageCleanupTask } from './tasks/storage-cleanup.task';
import { StorageCleanupHandler } from './handlers/storage-cleanup.handler';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [
    StorageProvidersModule,
    // #353: the stale-upload sweep is a queue job now, so this module needs
    // `JobsService` to enqueue it and `JobHandlerRegistry` for the handler to
    // register itself with. One-way — nothing in `JobsModule` imports storage.
    JobsModule,
    ObjectProcessingModule,
    CommonModule,
  ],
  controllers: [ObjectsController],
  providers: [ObjectsService, StorageCleanupTask, StorageCleanupHandler],
  exports: [ObjectsService],
})
export class StorageModule {}
