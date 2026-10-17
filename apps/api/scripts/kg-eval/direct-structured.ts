// =============================================================================
// The kg:eval structured-output client (issue #475, epic #472)
// =============================================================================
//
// An eval run is a developer or CI tool: it has no signed-in user, no organization
// and no stored key, so it cannot go through the platform's per-user AI service.
// Its key comes from the environment (`KG_EVAL_OPENAI_API_KEY`, see `runner.ts`).
// This is the ONE place a key is turned into a request, and it is deliberately
// tiny: one non-streamed Chat Completions call constrained to a strict JSON Schema,
// with the signature and the failures of `KVOX_AI.generateStructured` (the port of
// `@marinoscar/kvox-api/ports`), so the runners are written against the port and a
// test injects a fake port (`createFakeKvoxAi` of `@marinoscar/kvox-api/testing`).
//
// ⚠ The key is used for one `Authorization` header and nowhere else: it is never
// logged, never put in an error message, and never returned. A failed request
// reports its HTTP status only (a vendor body is the one place an echoed
// credential could appear).
// ⚠ This file is for scripts. Application code never builds a vendor request: it
// calls `KVOX_AI`.
// =============================================================================

import type { z } from 'zod';
import { KvoxAiError, type KvoxAiContext, type KvoxAiPort, type KvoxStructuredResult } from '@marinoscar/kvox-api/ports';

const CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

/** The slice of the port the eval runners use. */
export type KgEvalAi = Pick<KvoxAiPort, 'generateStructured'>;

interface ChatCompletion {
  model?: unknown;
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown; refusal?: unknown };
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** A `generateStructured` that calls OpenAI directly with `apiKey`. */
export function directStructuredClient(apiKey: string, fetchImpl: typeof fetch = fetch): KgEvalAi {
  return {
    async generateStructured<T>(
      ctx: KvoxAiContext,
      req: Omit<Parameters<KgEvalAi['generateStructured']>[1], 'schema'> & { schema: z.ZodType<T> },
    ): Promise<KvoxStructuredResult<T>> {
      const response = await fetchImpl(CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: req.target.model,
          max_completion_tokens: req.maxOutputTokens,
          response_format: {
            type: 'json_schema',
            json_schema: { name: req.schemaName, strict: true, schema: req.jsonSchema },
          },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
        signal: ctx.signal,
      });
      if (!response.ok) {
        throw new Error(`The structured-output request failed with HTTP ${response.status}.`);
      }

      const body = (await response.json()) as ChatCompletion;
      const choice = body.choices?.[0];
      const usage = {
        inputTokens: count(body.usage?.prompt_tokens),
        outputTokens: count(body.usage?.completion_tokens),
      };

      const refusal = choice?.message?.refusal;
      if (choice?.finish_reason === 'content_filter' || (typeof refusal === 'string' && refusal.trim() !== '')) {
        throw new KvoxAiError('refusal', 'The provider declined to produce this structured answer.');
      }
      if (choice?.finish_reason === 'length') {
        throw new KvoxAiError(
          'truncated',
          `The structured answer was cut off at the ${req.maxOutputTokens ?? 'default'}-token output ceiling.`,
          undefined,
          { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof choice?.message?.content === 'string' ? choice.message.content : '');
      } catch {
        throw new KvoxAiError('invalid_output', 'The structured answer was not valid JSON.');
      }

      return { value: req.schema.parse(parsed), usage };
    },
  };
}
