import { Global, Module } from '@nestjs/common';

import {
  AI_METRICS,
  AI_OBJECT_STORE,
  AI_SYSTEM_PRISMA,
  AI_TARGET_RESOLVER,
  AiCoreModule,
  DefaultAiTargetResolver,
  type AiSystemPrisma,
} from '@marinoscar/platform-api/ai';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { StorageProvidersModule } from '@marinoscar/platform-api/storage';

import { KvoxAiTargetResolver } from '../../ai-port/kvox-ai-target-resolver';
import { PlatformTaskModelSource } from '../../ai-port/platform-task-model-source';
import { PrismaSystemService } from '../../prisma/prisma-system.service';
import { AiObjectStoreAdapter } from './ai-object-store.adapter';

// =============================================================================
// The AI slice's host ports (issue #473, epic #472)
// =============================================================================
//
//   AI_SYSTEM_PRISMA    -> PrismaSystemService.forSystem   (the bypass client behind the
//                          two retention purges, the deployment-wide usage report and
//                          the catalogue sync's organization-less usage row)
//   AI_OBJECT_STORE     -> AiObjectStoreAdapter            (the active STORAGE_PROVIDER)
//   AI_METRICS          -> AppMetricsService               (the host core's instruments)
//   AI_TARGET_RESOLVER  -> KvoxAiTargetResolver            (this app's task routing)
//
// `PlatformTaskModelSource` (the policy and enabled-model reads, with their
// 5-second cache, #579) is provided and exported beside the resolver, which
// delegates to it: the bound `KVOX_AI` (`createKvoxAi`) reads the SAME instance,
// so one settings write invalidates both.
//
// `@Global()` because every sub-module of the AI slice injects the ports. The
// resolver is exported as well: `/api/ai-tasks/*` (`AiPortModule`) reads it.
// `DefaultAiTargetResolver` is provided here so the app resolver can delegate a
// feature it does not own (a platform page such as the Playground) to the
// platform's own order.
// =============================================================================

@Global()
@Module({
  imports: [AiCoreModule, StorageProvidersModule],
  providers: [
    {
      provide: AI_SYSTEM_PRISMA,
      inject: [PrismaSystemService],
      useFactory: (system: PrismaSystemService): AiSystemPrisma => ({
        asSystem: (reason) =>
          system.forSystem(reason) as unknown as ReturnType<AiSystemPrisma['asSystem']>,
      }),
    },
    { provide: AI_OBJECT_STORE, useClass: AiObjectStoreAdapter },
    { provide: AI_METRICS, useExisting: AppMetricsService },
    DefaultAiTargetResolver,
    PlatformTaskModelSource,
    KvoxAiTargetResolver,
    { provide: AI_TARGET_RESOLVER, useExisting: KvoxAiTargetResolver },
  ],
  exports: [
    AI_SYSTEM_PRISMA,
    AI_OBJECT_STORE,
    AI_METRICS,
    AI_TARGET_RESOLVER,
    KvoxAiTargetResolver,
    PlatformTaskModelSource,
  ],
})
export class AiHostModule {}
