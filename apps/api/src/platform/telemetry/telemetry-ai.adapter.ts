// =============================================================================
// The telemetry assistant's AI port (issue #471, epic #467)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(#472): the telemetry assistant spends an AI key through
// the platform's AI slice (`forUser(userId)`: the gate, key resolution, usage
// accounting). This app adopts that slice in #472; until then its AI keys live in
// its own `user_ai_credentials` table and there is nothing to hand the assistant.
// So the port answers "unavailable": `assertEnabled()` refuses with the app's
// `AI_DISABLED` error (403), which is what the assistant route returns while AI is
// off. The explorer, the dashboard and every other telemetry feature are
// unaffected; only `POST /api/admin/telemetry/assistant` is.
//
// #472 replaces this class with a binding over the platform AI facade.
// =============================================================================

import { ForbiddenException, Injectable } from '@nestjs/common';
import type {
  TelemetryAiError,
  TelemetryAiPort,
  TelemetryAiSession,
  TelemetryAiTool,
  TelemetryAiToolDefinition,
} from '@marinoscar/platform-api/telemetry';
import type { z } from 'zod';

const UNAVAILABLE_MESSAGE =
  'The telemetry assistant is not available yet: this application has not adopted the platform AI slice.';

function unavailable(): ForbiddenException {
  return new ForbiddenException({ code: 'AI_DISABLED', message: UNAVAILABLE_MESSAGE });
}

@Injectable()
export class TelemetryAiAdapter implements TelemetryAiPort {
  forUser(_userId: string): TelemetryAiSession {
    return {
      runTools: async () => {
        throw unavailable();
      },
    };
  }

  defineTool<P extends z.ZodType, R>(definition: TelemetryAiToolDefinition<P, R>): TelemetryAiTool {
    // Opaque to telemetry: handed back to `runTools` unchanged, which never runs.
    return definition as unknown as TelemetryAiTool;
  }

  isAiError(_error: unknown): _error is TelemetryAiError {
    return false;
  }

  async assertEnabled(): Promise<void> {
    throw unavailable();
  }
}
