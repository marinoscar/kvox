// =============================================================================
// The telemetry assistant's AI port (issue #471, epic #467; bound in #477)
// =============================================================================
//
// A binding over the platform AI slice, as the telemetry slice's README asks: the
// assistant spends the CALLING USER's own key through `AiService.forUser(userId)`,
// which runs the gate pipeline (kill switch, provider, model, capability, limits,
// key resolution), records one usage row per round trip and traces the call. No
// provider SDK, no key and no prompt is touched here.
//
// The assistant names its own provider and model (`telemetry.assistant`), and
// passes no feature id, so the platform resolves the target itself
// (`DefaultAiTargetResolver`, through `KvoxAiTargetResolver`'s delegation). A
// user without a key gets the platform's `AI_KEY_REQUIRED`, which the assistant
// turns into its own message.
//
// This replaces the stub that answered "unavailable" while the application kept
// its keys in its own table (issue #471's PLATFORM-ADOPTION-SHIM for #472).
// =============================================================================

import { Injectable } from '@nestjs/common';
import {
  AiConfigService,
  AiError,
  AiService,
  defineTool,
  type AiDefinedTool,
  type AiInputItem,
} from '@marinoscar/platform-api/ai';
import type {
  TelemetryAiError,
  TelemetryAiPort,
  TelemetryAiSession,
  TelemetryAiTool,
  TelemetryAiToolDefinition,
  TelemetryAiToolLoopRequest,
  TelemetryAiToolLoopResult,
} from '@marinoscar/platform-api/telemetry';
import type { z } from 'zod';

@Injectable()
export class TelemetryAiAdapter implements TelemetryAiPort {
  constructor(
    private readonly ai: AiService,
    private readonly config: AiConfigService,
  ) {}

  forUser(userId: string): TelemetryAiSession {
    const client = this.ai.forUser(userId);
    return {
      runTools: async (
        request: TelemetryAiToolLoopRequest,
        options: { signal?: AbortSignal },
      ): Promise<TelemetryAiToolLoopResult> => {
        const result = await client.runTools(
          {
            provider: request.provider,
            model: request.model,
            instructions: request.instructions,
            input: request.input as AiInputItem[],
            tools: request.tools as unknown as AiDefinedTool[],
            maxSteps: request.maxSteps,
            toolTimeoutMs: request.toolTimeoutMs,
            onStep: (step) => request.onStep(step),
          },
          { signal: options.signal },
        );
        return { final: result.final, steps: result.steps, stopReason: result.stopReason };
      },
    };
  }

  defineTool<P extends z.ZodType, R>(definition: TelemetryAiToolDefinition<P, R>): TelemetryAiTool {
    // Opaque to telemetry: handed back to `runTools` unchanged.
    return defineTool({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      execute: (args, ctx) => definition.execute(args, { signal: ctx.signal }),
    }) as unknown as TelemetryAiTool;
  }

  isAiError(error: unknown): error is TelemetryAiError {
    return error instanceof AiError;
  }

  /** Throws the platform's 403 `AI_DISABLED` while the kill switch is off. */
  async assertEnabled(): Promise<void> {
    await this.config.assertEnabled();
  }
}
