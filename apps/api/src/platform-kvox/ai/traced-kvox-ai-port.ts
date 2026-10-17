import { Trace } from '@marinoscar/platform-api/otel-core';
import type {
  KvoxAiCapabilities,
  KvoxAiContext,
  KvoxAiPort,
  KvoxAiTarget,
  KvoxChatEvent,
  KvoxChatMessage,
  KvoxEmbedResult,
  KvoxStructuredResult,
  KvoxTextEvent,
  KvoxToolDef,
} from '@marinoscar/kvox-api/ports';
import type { z } from 'zod';

// =============================================================================
// TracedKvoxAiPort: the bound KVOX_AI, with the web edition's spans (issue #579)
// =============================================================================
//
// `KVOX_AI` is `createKvoxAi(...)` of `@marinoscar/kvox-ai` (host-neutral: no
// tracer). This wrapper adds back the spans the retired `PlatformKvoxAiAdapter`
// opened, UNDER THEIR FORMER NAMES (`PlatformKvoxAiAdapter.capabilities`, ...), so a
// dashboard that filters on them keeps working. It adds no rule and no model call
// of its own: every method passes straight through.
//
// ⚠ THE STREAMING METHODS ARE NOT `@Trace()`D. The decorator awaits the method,
// which would turn an async generator into a Promise of one; the platform AI slice
// already traces each round trip. Everything that returns a promise is.
// =============================================================================

export class TracedKvoxAiPort implements KvoxAiPort {
  constructor(private readonly ai: KvoxAiPort) {}

  @Trace('PlatformKvoxAiAdapter.capabilities')
  capabilities(ctx: KvoxAiContext): Promise<KvoxAiCapabilities> {
    return this.ai.capabilities(ctx);
  }

  @Trace('PlatformKvoxAiAdapter.resolveTask')
  resolveTask(ctx: KvoxAiContext, task: string, opts?: { model?: string; requireKey?: boolean }): Promise<KvoxAiTarget> {
    return this.ai.resolveTask(ctx, task, opts);
  }

  generateText(
    ctx: KvoxAiContext,
    req: { target: KvoxAiTarget; system: string; user: string; maxOutputTokens?: number },
  ): AsyncIterable<KvoxTextEvent> {
    return this.ai.generateText(ctx, req);
  }

  @Trace('PlatformKvoxAiAdapter.generateStructured')
  generateStructured<T>(
    ctx: KvoxAiContext,
    req: {
      target: KvoxAiTarget;
      system: string;
      user: string;
      schema: z.ZodType<T>;
      schemaName: string;
      jsonSchema?: Record<string, unknown>;
      maxOutputTokens?: number;
    },
  ): Promise<KvoxStructuredResult<T>> {
    return this.ai.generateStructured(ctx, req);
  }

  chat(
    ctx: KvoxAiContext,
    req: { target: KvoxAiTarget; messages: KvoxChatMessage[]; tools: KvoxToolDef[]; toolChoice: 'auto' | 'none' },
  ): AsyncIterable<KvoxChatEvent> {
    return this.ai.chat(ctx, req);
  }

  @Trace('PlatformKvoxAiAdapter.embed')
  embed(ctx: KvoxAiContext, req: { inputs: string[] }): Promise<KvoxEmbedResult> {
    return this.ai.embed(ctx, req);
  }

  countTokens(target: KvoxAiTarget, text: string): number {
    return this.ai.countTokens(target, text);
  }
}
