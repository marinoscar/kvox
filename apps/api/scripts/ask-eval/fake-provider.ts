// =============================================================================
// A scripted `AiProvider` for the Ask evaluation's replay test (issue #382)
// =============================================================================
//
// Drives `AskRespondHandler.process()` end to end — real toolset, real DB,
// real `HandleRegistry`/citation plumbing — with NO network call and NO real
// model: `chat()` yields a fixed, per-call script the replay spec hands it,
// one script array per question. This proves the harness's plumbing (the
// scorer, the seeder's `idMap`, the citation mapper) without a real model or
// a paid key, mirroring #362's `--predictions gold` self-test.
// =============================================================================

import type { AiChatEvent, AiChatRequest, AiProviderContext } from '../../src/ai/providers/ai-provider.interface';

export type ChatScript = AiChatEvent[];

/** One provider whose `chat()` replays a queue of scripts, one per call, in order. FIFO across the whole run — the caller sequences them per question. */
export class FakeAskProvider {
  readonly id = 'openai';
  readonly label = 'OpenAI (fake, replay test)';
  readonly settingsSchema = { safeParse: () => ({ success: true as const, data: {} }) };

  private queue: ChatScript[] = [];
  readonly requests: AiChatRequest[] = [];

  /** Appends one call's worth of events to the queue. */
  enqueue(script: ChatScript): void {
    this.queue.push(script);
  }

  /** Clears captured requests — call between questions so each question's `capturedPrompts` is its own. */
  resetRequests(): void {
    this.requests.length = 0;
  }

  chat(_ctx: AiProviderContext<never>, request: AiChatRequest): AsyncIterable<AiChatEvent> {
    this.requests.push(request);
    const script = this.queue.shift() ?? [{ kind: 'done', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } }];
    return (async function* () {
      for (const event of script) yield event;
    })();
  }
}

export const done = (
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' = 'stop',
  promptTokens = 100,
  completionTokens = 20,
): AiChatEvent => ({ kind: 'done', finishReason, usage: { promptTokens, completionTokens } });

export const text = (t: string): AiChatEvent => ({ kind: 'delta', text: t });

export const toolCall = (id: string, name: string, argumentsJson: string): AiChatEvent => ({
  kind: 'tool_call',
  id,
  name,
  argumentsJson,
});
