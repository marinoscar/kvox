import { Global, Module } from '@nestjs/common';

import { aiModule } from '../platform/ai/ai.config';
import { KVOX_AI } from './kvox-ai';
import { KvoxAiSettings } from './kvox-ai-settings';
import { PlatformKvoxAi } from './platform-kvox-ai';

// =============================================================================
// KvoxAiModule (issue #475, epic #472)
// =============================================================================
//
// Provides the one way this app reaches a model. `KVOX_AI` is `PlatformKvoxAi`
// (over the platform `AiService`); a handler or service injects
// `@Inject(KVOX_AI) private readonly ai: KvoxAi` and imports no platform AI type.
//
// GLOBAL, so a feature module does not import it. It imports the configured
// platform `AiModule` (the same object `AppModule` mounts, never a second
// `forRoot`) to reach `AiService`, and relies on the global `AiHostModule` for
// `KvoxAiTargetResolver`. `PrismaService` and the settings slice are global.
//
// `KvoxAiSettings` is exported too: the typed reader of the fields this app adds
// to the `ai` namespace (`graphEnabled`, limits), replacing the retired
// `AiSettingsService`.
// =============================================================================

@Global()
@Module({
  imports: [aiModule],
  providers: [
    PlatformKvoxAi,
    KvoxAiSettings,
    { provide: KVOX_AI, useExisting: PlatformKvoxAi },
  ],
  exports: [KVOX_AI, KvoxAiSettings],
})
export class KvoxAiModule {}
