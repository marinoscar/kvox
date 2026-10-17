import { Logger } from '@nestjs/common';
import type { KvoxAiPort } from '@marinoscar/kvox-api/ports';
import {
  createKvoxAi,
  type KvoxAiLogger,
  type KvoxAiReadinessReader,
  type KvoxAiRuntime,
  type KvoxTaskModelSource,
} from '@marinoscar/kvox-ai';

import type { KvoxAiSettings } from '../../ai-port/kvox-ai-settings';
import { KVOX_AI_EXTENSION_DEFAULTS } from '../../platform/ai/ai-settings.extension';
import { TracedKvoxAiPort } from './traced-kvox-ai-port';

// =============================================================================
// createWebKvoxAi: how the web edition builds KVOX_AI (issue #579)
// =============================================================================
//
// `KVOX_AI` (the model port of `@marinoscar/kvox-api/ports`) is `createKvoxAi` of
// `@marinoscar/kvox-ai`, wrapped for the web edition's spans. This function is the
// one recipe, used by the binding (`platform-kvox.module.ts`) and by every test or
// script that must drive the REAL binding over a fake platform (`scripts/ask-eval/`,
// `test/platform-kvox/`):
//
//   runtime           PlatformAiRuntime   (AiService.forUser: gates, key, usage row, trace)
//   taskModels        PlatformTaskModelSource (the `ai` namespace + enabled `ai_models`)
//   readiness         AiReadinessService  (the same reader the onboarding fact reads)
//   requestTimeoutMs  `ai.requestTimeoutMs`, read per call; a failed read is the
//                     extension default (ten minutes), never a failed call
//   graphEnabled      `ai.graphEnabled`, for `capabilities()`
//   logger            a Nest logger under the retired class's name (`PlatformKvoxAi`):
//                     the one entry is a JSON Schema that did not round-trip
// =============================================================================

/** What the web binding is built from. */
export interface WebKvoxAiDeps {
  runtime: KvoxAiRuntime;
  taskModels: KvoxTaskModelSource;
  readiness?: KvoxAiReadinessReader;
  settings: Pick<KvoxAiSettings, 'requestTimeoutMs' | 'graphEnabled'>;
  logger?: KvoxAiLogger;
}

/** The web edition's `KVOX_AI`. */
export function createWebKvoxAi(deps: WebKvoxAiDeps): KvoxAiPort {
  return new TracedKvoxAiPort(
    createKvoxAi({
      runtime: deps.runtime,
      taskModels: deps.taskModels,
      ...(deps.readiness !== undefined ? { readiness: deps.readiness } : {}),
      requestTimeoutMs: async () => {
        try {
          return await deps.settings.requestTimeoutMs();
        } catch {
          // A settings read that fails must not fail the call: the default backstop applies.
          return KVOX_AI_EXTENSION_DEFAULTS.requestTimeoutMs;
        }
      },
      graphEnabled: () => deps.settings.graphEnabled(),
      logger: deps.logger ?? new Logger('PlatformKvoxAi'),
    }),
  );
}
