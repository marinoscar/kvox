import { APP_SLUG } from '@app/shared';
import type {
  JsonSchema,
  KvoxAiCallBase,
  KvoxAiFeatureId,
  KvoxAiReadiness,
  KvoxChatEvent,
  KvoxChatRequest,
  KvoxEmbeddingCapability,
  KvoxReasoningEffort,
  KvoxTextEvent,
  KvoxUsage,
} from '@marinoscar/kvox-ai';
import type { z } from 'zod';

// =============================================================================
// KvoxAi: the one way this app's code reaches a model (issue #475, epic #472)
// =============================================================================
//
// Every feature that calls a model (notes, transcripts, search, the graph, Ask)
// goes through this interface. It is implemented over the platform
// `AiService.forUser(...)` by `PlatformKvoxAi`. The domain packages' own model port,
// `KVOX_AI` of `@marinoscar/kvox-api/ports` (a different token and a narrower interface),
// is bound to this facade by `platform-kvox/ai/platform-kvox-ai.adapter.ts` (#490).
//
// ⚠ NO PLATFORM TYPE APPEARS HERE. This file imports only Zod and the call and
// event types of `@marinoscar/kvox-ai` (`JsonSchema`, `KvoxAiCallBase`,
// `KvoxAiReadiness`, the chat and text events, ...), which moved there with #579;
// the facade and its token stay here until the port is bound to `createKvoxAi`.
// ⚠ A CALLER NEVER SEES A KEY. The platform resolves the user's key per call.
// =============================================================================

/** Injection token of the port. */
export const KVOX_AI = Symbol.for(`${APP_SLUG}/KVOX_AI`);

export interface KvoxAi {
  /** The readiness of `feature` for `userId`, with the model it would run on. Never throws. */
  readiness(
    userId: string,
    feature: KvoxAiFeatureId,
    requested?: string | null,
  ): Promise<KvoxAiReadiness>;

  /** Streamed plain text. Throws a mapped error on a refusal, a bad key or a rate limit. */
  streamText(
    req: KvoxAiCallBase & {
      system: string;
      user: string;
      maxOutputTokens?: number;
      /** A per-call override of the deployment's effort; `'none'` omits reasoning. */
      reasoningEffort?: KvoxReasoningEffort;
    },
  ): AsyncIterable<KvoxTextEvent>;

  /**
   * One structured answer. `schema` validates the parsed value (the caller's own
   * validation is unchanged); `jsonSchema`, when given, is what the vendor is
   * constrained to.
   */
  generateStructured<T>(
    req: KvoxAiCallBase & {
      system: string;
      user: string;
      schemaName: string;
      schema: z.ZodType<T>;
      jsonSchema?: JsonSchema;
      maxOutputTokens?: number;
      /** A per-call override of the deployment's effort; `'none'` omits reasoning. */
      reasoningEffort?: KvoxReasoningEffort;
    },
  ): Promise<{ value: T; model: string; usage: KvoxUsage }>;

  /** One vector per text, in order, each `embeddingCapability().dimensions` wide. */
  embed(
    req: KvoxAiCallBase & { texts: string[] },
  ): Promise<{ vectors: number[][]; promptTokens: number | null; model: string }>;

  embeddingCapability(): KvoxEmbeddingCapability;

  /** A local estimate (no network). Budgets are checked against it. */
  countTokens(text: string, model: string): number;

  /** Streamed, possibly tool-calling, chat turn (the Ask loop, #476). Full history every call. */
  chat(req: KvoxChatRequest): AsyncIterable<KvoxChatEvent>;
}
