import { Injectable } from '@nestjs/common';

import {
  createKvoxAiReadiness,
  type KvoxAiFeatureId,
  type KvoxAiReadiness,
  type KvoxAiReadinessReader,
} from '@marinoscar/kvox-ai';

import { PlatformAiRuntime } from './platform-ai-runtime';
import { PlatformTaskModelSource } from './platform-task-model-source';

// =============================================================================
// AiReadinessService: "may this user run this feature, and on what?" (issue #579)
// =============================================================================
//
// The web edition's ONE readiness reader: `createKvoxAiReadiness` of
// `@marinoscar/kvox-ai` over the task-model source (the `ai` namespace and the
// enabled `ai_models` rows) and the platform runtime (does a `user_ai_keys` row
// exist). The bound `KVOX_AI` is built with this same instance
// (`createKvoxAi({ readiness })`, `platform-kvox/platform-kvox.module.ts`), and the
// onboarding checklist's `app.aiReadiness` fact reads it, so the two can never
// disagree. It replaced `KvoxAi.readiness` of the retired facade, with the same
// signature and the same answers.
//
// Never throws for a missing key or an unconfigured deployment (those are
// reasons); never reads or returns a key.
// =============================================================================

@Injectable()
export class AiReadinessService implements KvoxAiReadinessReader {
  private readonly reader: KvoxAiReadinessReader;

  constructor(runtime: PlatformAiRuntime, taskModels: PlatformTaskModelSource) {
    this.reader = createKvoxAiReadiness({ runtime, taskModels });
  }

  /** The readiness of `feature` for `userId`, with the model it would run on. */
  readiness(userId: string, feature: KvoxAiFeatureId, requested?: string | null): Promise<KvoxAiReadiness> {
    return this.reader.readiness(userId, feature, requested ?? null);
  }
}
