import { Global, Module } from '@nestjs/common';

import { aiModule } from '../platform/ai/ai.config';
import { AiReadinessService } from './ai-readiness.service';
import { KvoxAiSettings } from './kvox-ai-settings';
import { PlatformAiRuntime } from './platform-ai-runtime';

// =============================================================================
// KvoxAiModule (issue #475, epic #472; rebuilt for #579)
// =============================================================================
//
// Provides the web edition's half of `@marinoscar/kvox-ai`: the pieces `KVOX_AI`
// (the port of `@marinoscar/kvox-api/ports`, bound to `createKvoxAi` in
// `platform-kvox/platform-kvox.module.ts`) is built from, and that host code reads
// on its own:
//
//   PlatformAiRuntime   one provider round trip over the platform `AiService.forUser`
//   AiReadinessService  "may this user run this feature, and on what?" (the onboarding
//                       checklist's `app.aiReadiness` fact reads it; `KVOX_AI` shares it)
//   KvoxAiSettings      the typed reader of the fields this app adds to the `ai`
//                       namespace (`graphEnabled`, `requestTimeoutMs`, limits)
//
// GLOBAL, so the port binding and a feature module inject them without importing this
// module. It imports the configured platform `AiModule` (the same object `AppModule`
// mounts, never a second `forRoot`) to reach `AiService`, and relies on the global
// `AiHostModule` for `PlatformTaskModelSource` and `KvoxAiTargetResolver`.
// `PrismaService` and the settings slice are global.
//
// The retired `KvoxAi` facade and its app token (`ai-port/kvox-ai.ts`) are gone: code
// reaches a model through `KVOX_AI` of `@marinoscar/kvox-api/ports` only.
// =============================================================================

@Global()
@Module({
  imports: [aiModule],
  providers: [PlatformAiRuntime, AiReadinessService, KvoxAiSettings],
  exports: [PlatformAiRuntime, AiReadinessService, KvoxAiSettings],
})
export class KvoxAiModule {}
