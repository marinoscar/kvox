import { Module } from '@nestjs/common';

import { AiTasksController } from './ai-tasks.controller';
import { AiTasksService } from './ai-tasks.service';

// =============================================================================
// AiPortModule (issue #473, epic #472)
// =============================================================================
//
// This app's side of the platform AI slice: the `/api/ai-tasks/*` routes. The
// resolver they read (`KvoxAiTargetResolver`) is exported by the `@Global()`
// `AiHostModule`, which `platform/ai/ai.config.ts` hands to `AiModule.forRoot`, so
// this module imports nothing. `PrismaService` is global, and so is the settings
// slice.
// =============================================================================

@Module({
  controllers: [AiTasksController],
  providers: [AiTasksService],
  exports: [AiTasksService],
})
export class AiPortModule {}
