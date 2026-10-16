// =============================================================================
// The kg:eval structured-output client (issue #475, epic #472)
// =============================================================================
//
// An eval run is a developer or CI tool: it has no signed-in user, no organization
// and no stored key, so it cannot go through the platform's per-user AI service.
// Its key comes from the environment (`KG_EVAL_OPENAI_API_KEY`, see `runner.ts`).
// This is the ONE place a key is turned into a request, and it is deliberately
// tiny: one non-streamed Chat Completions call constrained to a strict JSON Schema,
// returning the same `{ value, model, usage }` shape `KvoxAi.generateStructured`
// does, so the runners are written against the port and a test injects a fake.
//
// ⚠ The key is used for one `Authorization` header and nowhere else: it is never
// logged, never put in an error message, and never returned. A failed request
// reports its HTTP status only (a vendor body is the one place an echoed
// credential could appear).
// ⚠ This file is for scripts. Application code never builds a vendor request: it
// calls `KvoxAi`.
// =============================================================================

import { AiRefusedError, AiStructuredOutputError } from '../../src/ai-port/ai-errors';
import type { KvoxAi } from '../../src/ai-port/kvox-ai';

const CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

/** The slice of the port the eval runners use. */
export type KgEvalAi = Pick<KvoxAi, 'generateStructured'>;

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
    async generateStructured<T>(req: Parameters<KgEvalAi['generateStructured']>[0]) {
      const response = await fetchImpl(CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: req.model,
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
        signal: req.signal,
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
        throw new AiRefusedError('The provider declined to produce this structured answer.');
      }
      if (choice?.finish_reason === 'length') {
        throw new AiStructuredOutputError(
          `The structured answer was cut off at the ${req.maxOutputTokens ?? 'default'}-token output ceiling.`,
          'truncated',
          undefined,
          { promptTokens: usage.inputTokens ?? 0, completionTokens: usage.outputTokens ?? 0 },
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof choice?.message?.content === 'string' ? choice.message.content : '');
      } catch {
        throw new AiStructuredOutputError('The structured answer was not valid JSON.', 'invalid_json');
      }

      return {
        value: req.schema.parse(parsed) as T,
        model: typeof body.model === 'string' ? body.model : req.model ?? 'unknown',
        usage,
      };
    },
  };
}
