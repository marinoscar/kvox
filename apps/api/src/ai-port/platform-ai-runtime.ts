import { HttpException, Injectable } from '@nestjs/common';

import { AiError, AiService, type AiResponse, type AiStreamEvent, type AiUserClient } from '@marinoscar/platform-api/ai';
import { RateLimitError } from '@marinoscar/platform-api/jobs';
import { KvoxAiError, type KvoxAiErrorClass } from '@marinoscar/kvox-api/ports';
import {
  scrub,
  type KvoxAiKeyReadiness,
  type KvoxAiRuntime,
  type KvoxAiRuntimeCall,
  type KvoxAiRuntimeEmbedRequest,
  type KvoxAiRuntimeEmbedResult,
  type KvoxAiRuntimeRequest,
} from '@marinoscar/kvox-ai';

import { PrismaService } from '../prisma/prisma.service';
import { KvoxAiBadRequest, KvoxAiConflict } from './kvox-ai-errors';

// =============================================================================
// PlatformAiRuntime: the web edition's KvoxAiRuntime, over AiService.forUser (#579)
// =============================================================================
//
// THE ONE PLACE THE WEB EDITION MAKES A PROVIDER ROUND TRIP. `createKvoxAi`
// (`@marinoscar/kvox-ai`, bound as `KVOX_AI` in `platform-kvox/`) owns every model
// rule; this class only hands each round trip to the platform `AiService.forUser
// (userId, { orgId?, jobId?, feature })`, which runs every gate, resolves the
// user's own key from `user_ai_keys`, records ONE USAGE ROW PER ROUND TRIP and
// traces the call. So every Ask step, every structured call and every embeddings
// batch still writes its own usage row, exactly as `PlatformKvoxAi` did.
//
//   stream    -> client.stream(req)
//   create    -> client.respond(req)   (`respondStructured` IS `respond` with
//                                       `structuredOutput` set, which the request carries)
//   embed     -> client.embed({ provider, model, input, dimensions })
//   readiness -> does a `user_ai_keys` row exist? (`select: { id: true }`, never the secret)
//
// THE MODEL, NOT THE PROVIDER. A call's `model` is sent when the target names one;
// its `provider` is NOT: the platform asks this app's `KvoxAiTargetResolver`
// (`AI_TARGET_RESOLVER`) for the target, so the product's 409/400 answers and its
// task routing stay where they were. Embeddings name both, as they always did.
//
// HOST ERRORS ARE TRANSLATED HERE. A platform `AiError` leaves as it is
// (`createKvoxAi` classifies it by code, route or job). What only this host throws
// becomes a `KvoxAiError` before it leaves, with the class the web edition always
// answered (frozen in test/ai/fixtures/platform-ai-runtime-error-parity.v1.json):
// the target resolver's `KvoxAiConflict` by reason, its `KvoxAiBadRequest` as
// `capability`, the queue's `RateLimitError` as `rate_limit` with its retry hint,
// and any other `HttpException` by status (429 `rate_limit`, 422 `refusal`, else
// `other`). Messages are scrubbed.
//
// ⚠ NOT `@Trace()`D. The platform AI slice already traces each round trip, and the
// port's own spans are kept by `TracedKvoxAiPort` (`platform-kvox/ai/`) under
// their former names. A decorator that awaits would also turn `stream` (an async
// generator) into a Promise of one.
// ⚠ A KEY NEVER CROSSES THIS CLASS: the platform resolves it per call, and
// `readiness` selects the row id only.
// =============================================================================

/** The port class of each 409 reason the target resolver answers with. */
const CONFLICT_CLASS: Readonly<Record<string, KvoxAiErrorClass>> = {
  ai_not_configured: 'not_configured',
  graph_disabled: 'not_configured',
  ai_key_missing: 'key_missing',
  ai_key_invalid: 'auth',
  model_lacks_capability: 'capability',
};

/**
 * What only this host throws, as the port's error; anything else (a platform
 * `AiError`, a plain error) unchanged, for `createKvoxAi` to classify.
 */
export function translateHostError(error: unknown): unknown {
  if (error instanceof KvoxAiError || AiError.isAiError(error)) return error;

  if (error instanceof RateLimitError) return new KvoxAiError('rate_limit', scrub(error.message), error.retryAfterMs);
  if (error instanceof KvoxAiConflict) return new KvoxAiError(CONFLICT_CLASS[error.reason] ?? 'other', scrub(error.message));
  if (error instanceof KvoxAiBadRequest) return new KvoxAiError('capability', scrub(error.message));
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const message = scrub(error.message);
    if (status === 429) return new KvoxAiError('rate_limit', message);
    if (status === 422) return new KvoxAiError('refusal', message);
    return new KvoxAiError('other', message);
  }

  return error;
}

@Injectable()
export class PlatformAiRuntime implements KvoxAiRuntime {
  constructor(
    private readonly ai: AiService,
    private readonly prisma: PrismaService,
  ) {}

  async *stream(call: KvoxAiRuntimeCall, req: KvoxAiRuntimeRequest): AsyncIterable<AiStreamEvent> {
    try {
      yield* this.client(call).stream(this.request(call, req), this.options(call));
    } catch (error) {
      throw translateHostError(error);
    }
  }

  async create(call: KvoxAiRuntimeCall, req: KvoxAiRuntimeRequest): Promise<AiResponse> {
    try {
      return await this.client(call).respond(this.request(call, req), this.options(call));
    } catch (error) {
      throw translateHostError(error);
    }
  }

  async embed(call: KvoxAiRuntimeCall, req: KvoxAiRuntimeEmbedRequest): Promise<KvoxAiRuntimeEmbedResult> {
    if (call.model === undefined) {
      // Vectors are comparable only within one model, so it is never inferred.
      throw new KvoxAiError('capability', 'An embeddings call must name its model.');
    }
    try {
      const result = await this.client(call).embed(
        {
          ...(call.provider !== undefined ? { provider: call.provider } : {}),
          model: call.model,
          input: req.input,
          ...(req.dimensions !== undefined ? { dimensions: req.dimensions } : {}),
        },
        this.options(call),
      );
      return { vectors: result.vectors, inputTokens: result.usage?.inputTokens ?? null, model: result.model };
    } catch (error) {
      throw translateHostError(error);
    }
  }

  async readiness(call: Pick<KvoxAiRuntimeCall, 'userId' | 'feature'> & { provider: string }): Promise<KvoxAiKeyReadiness> {
    // Existence only: `secret` is never selected.
    const key = await this.prisma.userAiKey.findUnique({
      where: { userId_provider: { userId: call.userId, provider: call.provider } },
      select: { id: true },
    });
    return { hasKey: key !== null };
  }

  /** One platform client bound to the call's user, org, feature and job. */
  private client(call: KvoxAiRuntimeCall): AiUserClient {
    return this.ai.forUser(call.userId, {
      ...(call.orgId !== undefined ? { orgId: call.orgId } : {}),
      ...(call.jobId !== undefined ? { jobId: call.jobId } : {}),
      feature: call.feature,
    });
  }

  /** The platform request: the call's model pick, when there is one, then the request. */
  private request(call: KvoxAiRuntimeCall, req: KvoxAiRuntimeRequest) {
    return { ...(call.model !== undefined && call.model.length > 0 ? { model: call.model } : {}), ...req };
  }

  /** The call's signal (the caller's, combined with the request timeout by `createKvoxAi`). */
  private options(call: KvoxAiRuntimeCall): { signal?: AbortSignal } {
    return call.signal !== undefined ? { signal: call.signal } : {};
  }
}
