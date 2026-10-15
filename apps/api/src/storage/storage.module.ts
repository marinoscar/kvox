import { Module } from '@nestjs/common';
import { StorageProvidersModule } from './providers/storage-providers.module';
import { ObjectProcessingModule } from './processing/object-processing.module';
import { CommonModule } from '../common/common.module';
import { ObjectsController } from './objects/objects.controller';
import { ObjectsService } from './objects/objects.service';
import { StorageCleanupTask } from './tasks/storage-cleanup.task';
import { StorageCleanupHandler } from './handlers/storage-cleanup.handler';

@Module({
  imports: [
    StorageProvidersModule,
    // #353: the stale-upload sweep is a queue job. `JobsService` (to enqueue it)
    // and `JobHandlerRegistry` (for the handler to register itself with) come
    // from the platform's global jobs slice (#468), so no import is needed.
    ObjectProcessingModule,
    CommonModule,
  ],
  controllers: [ObjectsController],
  providers: [ObjectsService, StorageCleanupTask, StorageCleanupHandler],
  exports: [ObjectsService],
})
export class StorageModule {}
